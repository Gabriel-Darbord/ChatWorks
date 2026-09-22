import { createHash } from "node:crypto";
import type { Message } from "../core/message.ts";
import {
  compileClassicTurn,
  decodeOpenCodeProviderRequest,
  type OpenCodeProviderRequest,
} from "./opencode-request.ts";
import {
  parseOpenCodeToolBlocks,
  type ToolProtocolResult,
} from "./opencode-tools.ts";

const repairLimit = 2;

export type ClassicProviderGateway = {
  sendAndRead(prompt: string): Promise<Message>;
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
): Promise<OpenAICompletion> {
  const request = decodeOpenCodeProviderRequest(value);
  const turn = providerTurnId(request);
  const compiled = compileClassicTurn(request);
  let prompt = compiled.prompt;

  for (let repairCount = 0; repairCount <= repairLimit; repairCount += 1) {
    const result = parseOpenCodeToolBlocks(
      await gateway.sendAndRead(prompt),
      compiled.tools,
      turn,
    );
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
