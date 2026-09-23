import { createHash } from "node:crypto";
import { messageText, type Message } from "../core/message.ts";
import { logDebug } from "../core/diagnostics.ts";
import {
  compileClassicTurn,
  decodeOpenCodeProviderRequest,
  formatTools,
  type OpenCodeProviderRequest,
} from "./opencode-request.ts";
import {
  parseOpenCodeToolBlocks,
  type ToolProtocolResult,
} from "./opencode-tools.ts";

const repairLimit = 2;
const listToolsTool = {
  name: "listtools",
  input: {
    required: ["name"],
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
};

export type ClassicProviderGateway = {
  sendAndRead(prompt: string, correlationId?: string): Promise<Message>;
};

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

export async function completeOpenCodeRequest(
  value: unknown,
  gateway: ClassicProviderGateway,
  correlationId?: string,
): Promise<OpenAICompletion> {
  const request = decodeOpenCodeProviderRequest(value);
  const turn = providerTurnId(request);
  const compiled = compileClassicTurn(request);
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
    const result = parseOpenCodeToolBlocks(
      message,
      [...compiled.tools, listToolsTool],
      turn,
    );
    if (
      result.kind === "tool-calls" &&
      result.calls.length === 1 &&
      result.calls[0].name === "listtools"
    ) {
      const requestedName = result.calls[0].input.name;
      const requestedTool = compiled.tools.find(
        (tool) => tool.name === requestedName,
      );
      prompt = requestedTool
        ? `Tool definition requested:\n\n${formatTools([requestedTool])}\n\nContinue the current task. Invoke tools only with a fenced \`tools\` block.`
        : `No tool named ${JSON.stringify(requestedName)} is available. Available tool names: ${compiled.tools.map((tool) => tool.name).join(", ")}. Continue the current task.`;
      repairCount -= 1;
      continue;
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

  throw new Error("Unreachable OpenCode provider repair state.");
}

function providerTurnId(request: OpenCodeProviderRequest): string {
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
