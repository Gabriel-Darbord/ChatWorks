import { randomUUID } from "node:crypto";
import { messageText, type Message } from "../core/message.ts";
import { logDebug } from "../core/diagnostics.ts";
import {
  compileClassicTurn,
  decodeProviderRequest,
  formatCompactTools,
  formatSection,
  formatTools,
} from "./provider-request.ts";
import {
  identityProviderToolAdapter,
  type ProviderToolAdapter,
} from "./provider-tool-adapter.ts";
import {
  parseProviderToolBlocks,
  type ToolProtocolResult,
} from "./provider-tools.ts";

const repairLimit = 2;
const internalTurnLimit = 16;
const pendingStateLimit = 512;
const pendingStateTtlMs = 30 * 60 * 1_000;
const internalToolInput = {
  schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const listToolsTool = {
  name: "listtools",
  input: internalToolInput,
};

const finishTool = {
  name: "finish",
  input: {
    required: ["conclusion"],
    schema: {
      type: "object",
      properties: {
        conclusion: {
          type: "string",
          description: "Final response returned to the user.",
        },
      },
      required: ["conclusion"],
      additionalProperties: false,
    },
  },
};

export type ClassicProviderGateway = {
  sendAndRead(prompt: string, correlationId?: string): Promise<Message>;
};

export type ProviderState = {
  pendingByToolCall: Map<
    string,
    {
      createdAt: number;
      toolCatalog?: string;
      internalResult?: string;
    }
  >;
  now: () => number;
};

export function createProviderState(
  now: () => number = Date.now,
): ProviderState {
  return {
    pendingByToolCall: new Map(),
    now,
  };
}

export type OpenAICompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls";
  }>;
};

export async function completeProviderRequest(
  value: unknown,
  gateway: ClassicProviderGateway,
  correlationId?: string,
  state: ProviderState = createProviderState(),
  onIntermediate?: (text: string) => void,
  toolAdapter: ProviderToolAdapter = identityProviderToolAdapter,
): Promise<OpenAICompletion> {
  const request = decodeProviderRequest(value);
  const turn = providerTurnId();
  prunePendingState(state);
  const pendingContexts = request.messages.flatMap((message) => {
    if (!message.toolCallId) return [];
    const context = state.pendingByToolCall.get(message.toolCallId);
    if (!context) return [];
    state.pendingByToolCall.delete(message.toolCallId);
    return [context];
  });
  const pendingCatalogs = pendingContexts.flatMap((context) =>
    context.toolCatalog ? [context.toolCatalog] : [],
  );
  const pendingInternalResults = pendingContexts.flatMap((context) =>
    context.internalResult ? [context.internalResult] : [],
  );
  const compiled = compileClassicTurn(
    request,
    undefined,
    [...new Set(pendingCatalogs), ...new Set(pendingInternalResults)],
    toolAdapter,
  );
  let prompt = compiled.prompt;
  let repairCount = 0;

  for (
    let internalTurn = 1;
    internalTurn <= internalTurnLimit;
    internalTurn += 1
  ) {
    await logDebug("provider", "classic-input", {
      correlationId,
      fields: { prompt, repairCount, internalTurn },
    });

    const message = await gateway.sendAndRead(prompt, correlationId);

    await logDebug("provider", "classic-output", {
      correlationId,
      fields: { message: messageText(message), repairCount, internalTurn },
    });

    const result = parseProviderToolBlocks(
      message,
      [...compiled.tools, listToolsTool, finishTool],
      turn,
      toolAdapter,
    );

    if (result.kind === "text" && result.text) {
      onIntermediate?.(result.text);
    }

    if (result.kind === "text") {
      prompt = [
        "The coding-agent turn is still active. Continue working on the current task: reason through what remains, investigate or verify assumptions, and use the available tools whenever they can materially advance the work. Do not stop merely because you have an intermediate result or no immediate tool call to make.",
        "When the task is complete, or further progress requires information or action only the user can provide, end the coding-agent turn by calling `finish` with a `conclusion` string. The conclusion becomes the final response to the user and should concisely summarize the work performed, important decisions or conclusions, the resulting state, relevant verification, and anything that remains unresolved or requires user input.",
        "",
        formatSection("Active tools", formatCompactTools(request.tools)),
      ].join("\n");
      continue;
    }

    if (result.kind === "tool-calls") {
      const finishCalls = result.calls.filter((call) => call.name === "finish");
      if (finishCalls.length > 0) {
        if (result.calls.length === 1) {
          const conclusion = finishCalls[0].input.conclusion;
          if (
            typeof conclusion !== "string" ||
            conclusion.trim().length === 0
          ) {
            prompt =
              "The `finish` conclusion must be a non-empty string. Continue the current task, then call `finish` with the final response in `input.conclusion`.";
            continue;
          }
          return completion(request.model, turn, {
            kind: "text",
            text: conclusion,
          });
        }

        const remainingCalls = result.calls.filter(
          (call) => call.name !== "finish",
        );
        const finishIgnored =
          "The `finish` call was ignored because it was called alongside another tool. The other tools were executed and the coding-agent turn remains active.";
        const requestedCatalog = remainingCalls.some(
          (call) => call.name === "listtools",
        );
        const realCalls = remainingCalls.filter(
          (call) => call.name !== "listtools",
        );
        const catalog = requestedCatalog
          ? `Full tool catalog requested:\n\n${formatTools(compiled.tools, toolAdapter)}`
          : undefined;

        if (realCalls.length === 0) {
          prompt = [catalog, finishIgnored].filter(Boolean).join("\n\n");
          continue;
        }

        for (const call of realCalls) {
          rememberPendingContext(state, call.id, {
            internalResult: finishIgnored,
            ...(catalog ? { toolCatalog: catalog } : {}),
          });
        }
        return completion(request.model, turn, {
          ...result,
          calls: realCalls,
        });
      }

      const requestedCatalog = result.calls.some(
        (call) => call.name === "listtools",
      );

      if (requestedCatalog) {
        const catalog = `Full tool catalog requested:\n\n${formatTools(compiled.tools, toolAdapter)}`;
        const realCalls = result.calls.filter(
          (call) => call.name !== "listtools",
        );

        if (realCalls.length === 0) {
          prompt = `${catalog}\n\nContinue the current task. Invoke tools only with a fenced \`tools\` block.`;
          continue;
        }

        for (const call of realCalls) {
          rememberPendingContext(state, call.id, { toolCatalog: catalog });
        }

        return completion(request.model, turn, {
          ...result,
          calls: realCalls,
        });
      }
    }

    if (result.kind !== "repair")
      return completion(request.model, turn, result);

    if (repairCount === repairLimit) {
      throw new Error(
        `ChatWorks could not obtain a valid tool request after ${repairLimit} repairs: ${result.message}`,
      );
    }

    repairCount += 1;
    prompt = result.message;
  }

  throw new Error(
    `ChatWorks stopped after ${internalTurnLimit} internal turns without a valid finish call.`,
  );
}

function rememberPendingContext(
  state: ProviderState,
  toolCallId: string,
  context: { toolCatalog?: string; internalResult?: string },
): void {
  state.pendingByToolCall.set(toolCallId, {
    createdAt: state.now(),
    ...context,
  });
  prunePendingState(state);
}

function prunePendingState(state: ProviderState): void {
  const expiredBefore = state.now() - pendingStateTtlMs;
  for (const [toolCallId, context] of state.pendingByToolCall) {
    if (context.createdAt < expiredBefore) {
      state.pendingByToolCall.delete(toolCallId);
    }
  }

  while (state.pendingByToolCall.size > pendingStateLimit) {
    const oldestToolCallId = state.pendingByToolCall.keys().next().value;
    if (oldestToolCallId === undefined) break;
    state.pendingByToolCall.delete(oldestToolCallId);
  }
}

function providerTurnId(): string {
  return randomUUID().replaceAll("-", "");
}

function completion(
  model: string,
  turn: string,
  result: Exclude<ToolProtocolResult, { kind: "repair" }>,
): OpenAICompletion {
  const message =
    result.kind === "text"
      ? { role: "assistant" as const, content: result.text }
      : {
          role: "assistant" as const,
          content: result.text || null,
          tool_calls: result.calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          })),
        };

  return {
    id: `chatcmpl_chatworks_${turn}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.kind === "text" ? "stop" : "tool_calls",
      },
    ],
  };
}
