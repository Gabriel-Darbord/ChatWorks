import { randomUUID } from "node:crypto";
import { messageText, type Message } from "../core/message.ts";
import { logDebug } from "../core/diagnostics.ts";
import {
  compileClassicTurn,
  decodeProviderRequest,
  formatCompactTools,
  formatSection,
  formatTools,
  type ProviderRequest,
  type ProviderInternalToolNames,
} from "./provider-request.ts";
import {
  identityProviderToolAdapter,
  type ProviderToolAdapter,
} from "./provider-tool-adapter.ts";
import {
  parseProviderToolBlocks,
  type ProviderTool,
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

const finishToolInput = {
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
};

type InternalProviderTools = {
  names: ProviderInternalToolNames;
  finish: ProviderTool;
  listTools: ProviderTool;
};

export type ClassicProviderGateway = {
  sendAndRead(
    prompt: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<Message>;
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
  signal?: AbortSignal,
): Promise<OpenAICompletion> {
  const request = decodeProviderRequest(value);
  return completeDecodedProviderRequest(
    request,
    gateway,
    correlationId,
    state,
    onIntermediate,
    toolAdapter,
    signal,
  );
}

export async function completeDecodedProviderRequest(
  request: ProviderRequest,
  gateway: ClassicProviderGateway,
  correlationId?: string,
  state: ProviderState = createProviderState(),
  onIntermediate?: (text: string) => void,
  toolAdapter: ProviderToolAdapter = identityProviderToolAdapter,
  signal?: AbortSignal,
): Promise<OpenAICompletion> {
  signal?.throwIfAborted();
  const internalTools = createInternalProviderTools(request.tools, toolAdapter);
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
    internalTools.names,
  );
  let prompt = compiled.prompt;
  let repairCount = 0;

  for (
    let internalTurn = 1;
    internalTurn <= internalTurnLimit;
    internalTurn += 1
  ) {
    signal?.throwIfAborted();
    await logDebug("provider", "classic-input", {
      correlationId,
      fields: { prompt, repairCount, internalTurn },
    });

    const message = await gateway.sendAndRead(prompt, correlationId, signal);

    await logDebug("provider", "classic-output", {
      correlationId,
      fields: { message: messageText(message), repairCount, internalTurn },
    });

    const result = parseProviderToolBlocks(
      message,
      [...compiled.tools, internalTools.listTools, internalTools.finish],
      turn,
      toolAdapter,
    );

    if (result.kind === "text" && result.text) {
      onIntermediate?.(result.text);
    }

    if (result.kind === "text") {
      prompt = [
        "The coding-agent turn is still active. Continue working on the current task: reason through what remains, investigate or verify assumptions, and use the available tools whenever they can materially advance the work. Do not stop merely because you have an intermediate result or no immediate tool call to make.",
        `When the task is complete, or further progress requires information or action only the user can provide, end the coding-agent turn by calling \`${internalTools.names.finish}\` with a \`conclusion\` string. The conclusion becomes the final response to the user and should concisely summarize the work performed, important decisions or conclusions, the resulting state, relevant verification, and anything that remains unresolved or requires user input.`,
        "",
        formatSection(
          "Active tools",
          formatCompactTools(request.tools, internalTools.names.listTools),
        ),
      ].join("\n");
      continue;
    }

    if (result.kind === "tool-calls") {
      const finishCalls = result.calls.filter(
        (call) => call.name === internalTools.names.finish,
      );
      if (finishCalls.length > 0) {
        if (result.calls.length === 1) {
          const conclusion = finishCalls[0].input.conclusion;
          if (
            typeof conclusion !== "string" ||
            conclusion.trim().length === 0
          ) {
            prompt = `The \`${internalTools.names.finish}\` conclusion must be a non-empty string. Continue the current task, then call \`${internalTools.names.finish}\` with the final response in \`input.conclusion\`.`;
            continue;
          }
          return completion(request.model, turn, {
            kind: "text",
            text: conclusion,
          });
        }

        const remainingCalls = result.calls.filter(
          (call) => call.name !== internalTools.names.finish,
        );
        const finishIgnored = `The \`${internalTools.names.finish}\` call was ignored because it was called alongside another tool. The other tools were executed and the coding-agent turn remains active.`;
        const requestedCatalog = remainingCalls.some(
          (call) => call.name === internalTools.names.listTools,
        );
        const realCalls = remainingCalls.filter(
          (call) => call.name !== internalTools.names.listTools,
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
        (call) => call.name === internalTools.names.listTools,
      );

      if (requestedCatalog) {
        const catalog = `Full tool catalog requested:\n\n${formatTools(compiled.tools, toolAdapter)}`;
        const realCalls = result.calls.filter(
          (call) => call.name !== internalTools.names.listTools,
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

function createInternalProviderTools(
  tools: ProviderTool[],
  toolAdapter: ProviderToolAdapter,
): InternalProviderTools {
  const unavailableNames = new Set(
    tools.flatMap((tool) => [tool.name, toolAdapter.present(tool).name]),
  );
  let namespace = "chatworks_internal";
  let suffix = 2;
  while (
    unavailableNames.has(`${namespace}_finish`) ||
    unavailableNames.has(`${namespace}_listtools`)
  ) {
    namespace = `chatworks_internal_${suffix}`;
    suffix += 1;
  }

  const names = {
    finish: `${namespace}_finish`,
    listTools: `${namespace}_listtools`,
  };
  return {
    names,
    finish: { name: names.finish, input: finishToolInput },
    listTools: { name: names.listTools, input: internalToolInput },
  };
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
