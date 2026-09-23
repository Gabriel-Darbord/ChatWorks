import { presentOpenCodeTool } from "./opencode-tool-transformations.ts";
import type { OpenCodeTool } from "./opencode-tools.ts";

export type OpenCodeChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  text: string;
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
      "To request or perform any operation, your response MUST contain exactly one fenced `tools` block. This is the only way to invoke tools.",
      "When invoking tools:",
      "- Use exactly one fenced block in your entire response: the `tools` block.",
      "- Do not use any other fenced blocks.",
      "- You may include ordinary prose outside the `tools` block.",
      "- Put multiple tool calls in the same `tools` block, one JSON object with `name` and `input` fields per line, in execution order.",
      "- Batch only independent operations; prefer fewer calls when later work depends on an earlier result.",
      "- Only use the available tools.",
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

  if (toolResults.length > 0) sections.push(toolResults);
  sections.push("EVERYTHING BELOW IS CONVERSATION UPDATE:");
  sections.push(update);

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

  return {
    role,
    text: decodeContent(
      message.content,
      `Chat completion message ${index + 1}`,
    ),
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
  return `Available tool names: ${tools.map((tool) => tool.name).join(", ")}. If you need details for a tool, call listtools with its name.`;
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
  return `${label}:\n\n\`\`\`text\n${source}\n\`\`\``;
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
