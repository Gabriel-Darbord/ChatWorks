import { presentOpenCodeTool } from "./opencode-tool-transformations.ts";
import type { OpenCodeTool } from "./opencode-tools.ts";

export type OpenCodeChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  text: string;
  toolCallId?: string;
};

export type OpenCodeProviderRequest = {
  model: string;
  messages: OpenCodeChatMessage[];
  tools: OpenCodeTool[];
};

export type CompiledClassicTurn = {
  prompt: string;
  tools: OpenCodeTool[];
};

type UnknownRecord = Record<string, unknown>;

/**
 * Decode the small OpenAI-compatible request surface ChatWorks consumes.
 * Rejecting unknown content shapes keeps the Classic prompt from silently
 * dropping agent context when OpenCode changes its transport.
 */
export function decodeOpenCodeProviderRequest(
  value: unknown,
): OpenCodeProviderRequest {
  const request = record(value, "Chat completion request");
  const model = string(request.model, "Chat completion request model");
  const messages = array(
    request.messages,
    "Chat completion request messages",
  ).map(decodeMessage);

  if (messages.length === 0) {
    throw new Error(
      "Chat completion request must contain at least one message.",
    );
  }

  return {
    model,
    messages,
    tools: request.tools === undefined ? [] : decodeTools(request.tools),
  };
}

const agentInstructionsTokenInterval = 12_000;

export function compileClassicTurn(
  request: OpenCodeProviderRequest,
  includeToolCatalog = isInitialTurn(request.messages),
  internalToolResults: string[] = [],
): CompiledClassicTurn {
  const { toolResults, update } = newestConversationUpdate(request.messages);
  const system = request.messages.filter(
    (message) => message.role === "system" || message.role === "developer",
  );
  const includeAgentInstructions =
    includeToolCatalog || shouldIncludeAgentInstructions(request.messages);
  const sections = [
    [
      "You are the model for one coding-agent turn.",
      "You have access to the tools listed below. Use them when needed to complete the user's request. A tool call is performed by writing it in a fenced `tools` block. Tool calls will be executed and their results returned to you so you can continue the task.",
      // "Use them when needed to complete the user's request." -> "Use tools rather than claiming you cannot access the environment."?
      "When the user's request requires investigation, implementation, verification, or another operation, continue using the available tools until the requested work is complete or you are genuinely blocked by information or action only the user can provide. Do not stop merely because you have partial findings, an intermediate result, or a clear next step. If further available tool calls can materially advance the request, make them instead of ending the turn.",
      "When using tools:",
      "- Emit exactly one fenced `tools` block in your response.",
      "- Do not use any other fenced blocks in that response.",
      "- You may include ordinary prose outside the `tools` block.",
      "- Write one JSON object with `name` and `input` fields per tool call, one per line.",
      "- Put multiple independent tool calls in the same block. When a later call depends on an earlier result, wait for that result before requesting it.",
      "- Only call tools listed under Active tools.",
    ].join("\n"),
    includeToolCatalog
      ? formatSection("Active tools", formatTools(request.tools))
      : formatSection("Active tools", formatCompactTools(request.tools)),
  ];

  if (system.length > 0 && includeAgentInstructions) {
    sections.push(
      formatSection(
        "Agent instructions",
        system.map((message) => message.text).join("\n\n"),
      ),
    );
  }

  sections.push(...internalToolResults);
  if (toolResults.length > 0) sections.push(toolResults);

  if (update.length > 0) {
    sections.push("EVERYTHING BELOW IS CONVERSATION UPDATE:");
    sections.push(update);
  }

  return { prompt: sections.join("\n\n"), tools: request.tools };
}

function decodeMessage(value: unknown, index: number): OpenCodeChatMessage {
  const message = record(value, `Chat completion message ${index + 1}`);
  const role = message.role;
  if (
    role !== "system" &&
    role !== "developer" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    throw new Error(
      `Chat completion message ${index + 1} has an unsupported role.`,
    );
  }

  const toolCallId =
    message.tool_call_id === undefined
      ? undefined
      : string(
        message.tool_call_id,
        `Chat completion message ${index + 1} tool call id`,
      );

  return {
    role,
    text: decodeContent(
      message.content,
      `Chat completion message ${index + 1}`,
    ),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function decodeTools(value: unknown): OpenCodeTool[] {
  return array(value, "Chat completion tools").map((candidate, index) => {
    const tool = record(candidate, `Chat completion tool ${index + 1}`);
    if (tool.type !== "function") {
      throw new Error(`Chat completion tool ${index + 1} must be a function.`);
    }

    const definition = record(
      tool.function,
      `Chat completion tool ${index + 1} function`,
    );
    const name = string(
      definition.name,
      `Chat completion tool ${index + 1} function name`,
    );
    const description =
      definition.description === undefined
        ? undefined
        : string(
          definition.description,
          `Chat completion tool ${index + 1} function description`,
        );
    const parameters =
      definition.parameters === undefined
        ? undefined
        : record(
          definition.parameters,
          `Chat completion tool ${index + 1} parameters`,
        );
    const required = parameters?.required;
    if (
      required !== undefined &&
      (!Array.isArray(required) ||
        required.some((field) => typeof field !== "string"))
    ) {
      throw new Error(
        `Chat completion tool ${index + 1} parameters.required must be a string array.`,
      );
    }

    return {
      name,
      ...(description ? { description } : {}),
      ...(parameters
        ? {
          input: {
            ...(Array.isArray(required) ? { required } : {}),
            schema: parameters,
          },
        }
        : {}),
    };
  });
}

function decodeContent(value: unknown, label: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((part, index) => {
        const content = record(part, `${label} content part ${index + 1}`);
        if (content.type !== "text" || typeof content.text !== "string") {
          throw new Error(
            `${label} content part ${index + 1} must be a text part.`,
          );
        }
        return content.text;
      })
      .join("");
  }

  throw new Error(`${label} content must be text.`);
}

function newestConversationUpdate(messages: OpenCodeChatMessage[]): {
  toolResults: string;
  update: string;
} {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "assistant") start -= 1;

  const updates = messages
    .slice(start + 1)
    .filter((message) => message.role === "user" || message.role === "tool");

  if (updates.length === 0) {
    throw new Error(
      "Chat completion request must contain a user or tool message for this turn.",
    );
  }

  const toolResults = updates
    .filter((message) => message.role === "tool")
    .map((message, index) => `Tool result ${index + 1}:\n\n${message.text}`)
    .join("\n\n");
  const conversationUpdates = updates.filter(
    (message) => message.role === "user",
  );

  return {
    toolResults,
    update: conversationUpdates.map((message) => message.text).join("\n\n"),
  };
}

export function formatTools(tools: OpenCodeTool[]): string {
  if (tools.length === 0) return "No tools are available for this turn.";

  return tools
    .map(presentOpenCodeTool)
    .map((tool) => {
      const sections = [`name: ${tool.name}`];
      if (tool.description) sections.push(`description:\n${tool.description}`);
      if (tool.input?.schema) {
        sections.push(
          `input schema:\n${JSON.stringify(tool.input.schema, null, 2)}`,
        );
      }
      return sections.join("\n");
    })
    .join("\n\n");
}

function formatCompactTools(tools: OpenCodeTool[]): string {
  if (tools.length === 0) return "No tools are available for this turn.";
  return `Available tool names: ${tools.map((tool) => tool.name).join(", ")}. If you need the full tool definitions and input schemas, call listtools with an empty input object.`;
}

function isInitialTurn(messages: OpenCodeChatMessage[]): boolean {
  return !messages.some(
    (message) => message.role === "assistant" || message.role === "tool",
  );
}

function shouldIncludeAgentInstructions(
  messages: OpenCodeChatMessage[],
): boolean {
  if (isInitialTurn(messages)) return true;

  const conversation = messages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const currentStart = newestTurnStart(conversation);
  const previousTokens = estimateTokens(conversation.slice(0, currentStart));
  const currentTokens = estimateTokens(conversation);

  return (
    Math.floor(previousTokens / agentInstructionsTokenInterval) <
    Math.floor(currentTokens / agentInstructionsTokenInterval)
  );
}

function newestTurnStart(messages: OpenCodeChatMessage[]): number {
  if (messages.at(-1)?.role === "tool") {
    let index = messages.length - 1;
    while (index > 0 && messages[index - 1].role === "tool") index -= 1;
    return index;
  }
  return Math.max(0, messages.length - 1);
}

function estimateTokens(messages: OpenCodeChatMessage[]): number {
  const characters = messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  return Math.floor(characters / 4);
}

function formatSection(label: string, source: string): string {
  return `${label}:\n\`\`\`text\n${source}\n\`\`\``;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
