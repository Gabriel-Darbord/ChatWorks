import { createHash } from "node:crypto";
import { messageText, type Message } from "../core/message.ts";
import { logDebug } from "../core/diagnostics.ts";
import {
  compileClassicTurn,
  decodeProviderRequest,
  formatTools,
  type ProviderRequest,
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
  input: internalToolInput,
};

export type ClassicProviderGateway = {
  sendAndRead(prompt: string, correlationId?: string): Promise<Message>;
};

export type ProviderState = {
  pendingToolCatalogs: Map<string, string>;
  pendingInternalResults: Map<string, string>;
};

export function createProviderState(): ProviderState {
  return {
    pendingToolCatalogs: new Map(),
    pendingInternalResults: new Map(),
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
  const turn = providerTurnId(request);
  const pendingCatalogs = request.messages.flatMap((message) => {
    if (!message.toolCallId) return [];
    const catalog = state.pendingToolCatalogs.get(message.toolCallId);
    if (!catalog) return [];
    state.pendingToolCatalogs.delete(message.toolCallId);
    return [catalog];
  });
  const pendingInternalResults = request.messages.flatMap((message) => {
    if (!message.toolCallId) return [];
    const internalResult = state.pendingInternalResults.get(message.toolCallId);
    if (!internalResult) return [];
    state.pendingInternalResults.delete(message.toolCallId);
    return [internalResult];
  });
  const compiled = compileClassicTurn(
    request,
    undefined,
    [...new Set(pendingCatalogs), ...new Set(pendingInternalResults)],
    toolAdapter,
  );
  let prompt = compiled.prompt;

  for (let repairCount = 0; repairCount <= repairLimit; repairCount += 1) {
    await logDebug("provider", "classic-input", {
      correlationId,
      fields: { prompt, repairCount },
    });

    const message = await gateway.sendAndRead(prompt, correlationId);

    await logDebug("provider", "classic-output", {
      correlationId,
      fields: { message: messageText(message), repairCount },
    });

    const result = parseProviderToolBlocks(
      message,
      [...compiled.tools, listToolsTool, finishTool],
      turn,
      toolAdapter,
    );

    if (result.kind === "text") {
      if (result.text) onIntermediate?.(result.text);
      prompt = [
        "The coding-agent turn is still active. Continue working on the current task: reason through what remains, investigate or verify assumptions, and use the available tools whenever they can materially advance the work. Do not stop merely because you have an intermediate result or no immediate tool call to make.",
        "When the task is complete, or further progress requires information or action only the user can provide, end the coding-agent turn by calling `finish`. Do this by including the following `tools` block verbatim:",
        "```tools",
        '{"name":"finish","input":{}}',
        "```",
        "The prose alongside the `finish` block becomes the final response to the user. It should concisely summarize the work performed, the important decisions or conclusions, the resulting state, relevant verification, and anything that remains unresolved or requires user input.",
      ].join("\n");
      repairCount -= 1;
      continue;
    }

    if (result.kind === "tool-calls") {
      const finishCalls = result.calls.filter((call) => call.name === "finish");
      if (finishCalls.length > 0) {
        if (result.calls.length === 1) {
          return completion(request.model, turn, {
            kind: "text",
            text: result.text,
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
          repairCount -= 1;
          continue;
        }

        for (const call of realCalls) {
          state.pendingInternalResults.set(call.id, finishIgnored);
          if (catalog) state.pendingToolCatalogs.set(call.id, catalog);
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
          repairCount -= 1;
          continue;
        }

        for (const call of realCalls) {
          state.pendingToolCatalogs.set(call.id, catalog);
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

    prompt = result.message;
  }

  throw new Error("Unreachable provider repair state.");
}

function providerTurnId(request: ProviderRequest): string {
  const payload = JSON.stringify(request);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
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
