import { messageText, type Message } from "../core/message.ts";
import {
  presentOpenCodeTool,
  restoreOpenCodeToolInput,
} from "./opencode-tool-transformations.ts";

export type OpenCodeTool = {
  name: string;
  description?: string;
  input?: {
    required?: string[];
    schema?: Record<string, unknown>;
  };
};

export type ProviderToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolProtocolResult =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "tool-calls";
      text: string;
      calls: ProviderToolCall[];
    }
  | {
      kind: "repair";
      message: string;
    };

type ToolEnvelope = {
  name?: unknown;
  input?: unknown;
};

export function parseOpenCodeToolBlocks(
  message: Message,
  tools: OpenCodeTool[],
  providerTurn: string,
): ToolProtocolResult {
  const parts = [...message.parts];

  while (true) {
    const lastPart = parts.at(-1);
    if (lastPart?.kind !== "plain-text" || lastPart.text.trim().length !== 0) {
      break;
    }
    parts.pop();
  }

  const toolPartIndexes = parts.flatMap((part, index) =>
    part.kind === "block" && part.language === "tools" ? [index] : [],
  );
  if (toolPartIndexes.length === 0) {
    return { kind: "text", text: messageText(message).trim() };
  }
  if (toolPartIndexes.length > 1) {
    return repair(
      1,
      "the response contains more than one tools block",
      exampleFor(tools[0]),
    );
  }

  const otherBlock = parts.find(
    (part): part is Extract<typeof part, { kind: "block" }> =>
      part.kind === "block" && part.language !== "tools",
  );
  if (otherBlock) {
    return repair(
      1,
      `the response contains a \`${otherBlock.language || "text"}\` block in addition to the tools block; when invoking tools, the tools block must be the only fenced block`,
      exampleFor(tools[0]),
    );
  }

  const toolPartIndex = toolPartIndexes[0];
  const toolsPart = parts[toolPartIndex];
  if (toolsPart.kind !== "block") throw new Error("Unreachable tools part.");

  const text = messageText({
    parts: parts
      .filter((_, index) => index !== toolPartIndex)
      .map((part) =>
        part.kind === "plain-text" ? { ...part, text: part.text.trim() } : part,
      ),
  }).trim();
  const callLines = toolsPart.source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (callLines.length === 0)
    return repair(
      1,
      "the tools block contains no tool calls",
      exampleFor(tools[0]),
    );

  const presentedTools = tools.map(presentOpenCodeTool);
  const available = new Map(presentedTools.map((tool) => [tool.name, tool]));
  const calls: ProviderToolCall[] = [];

  for (const [index, line] of callLines.entries()) {
    const parsed = parseEnvelope(line, index + 1, presentedTools);
    if (parsed.kind === "repair") return parsed;

    const tool = available.get(parsed.name);
    if (!tool) return repairUnknownTool(index + 1, parsed.name, presentedTools);

    const missing = (tool.input?.required ?? []).filter(
      (field) => !(field in parsed.input),
    );
    if (missing.length > 0)
      return repairMissingInput(index + 1, tool, missing[0]);

    calls.push({
      id: `chatworks_${providerTurn}_${index + 1}`,
      name: parsed.name,
      input: restoreOpenCodeToolInput(parsed.name, parsed.input),
    });
  }

  return { kind: "tool-calls", text, calls };
}

function parseEnvelope(
  source: string,
  index: number,
  tools: OpenCodeTool[],
):
  | { kind: "ok"; name: string; input: Record<string, unknown> }
  | Extract<ToolProtocolResult, { kind: "repair" }> {
  let parsed: ToolEnvelope;
  try {
    parsed = JSON.parse(source) as ToolEnvelope;
  } catch {
    return repair(index, "the line is not valid JSON", exampleFor(tools[0]));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return repair(
      index,
      "the line must be one JSON object",
      exampleFor(tools[0]),
    );
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    return repair(
      index,
      "`name` must be a non-empty string",
      exampleFor(tools[0]),
    );
  }
  if (
    !parsed.input ||
    typeof parsed.input !== "object" ||
    Array.isArray(parsed.input)
  ) {
    return repair(
      index,
      "`input` must be a JSON object",
      exampleForName(parsed.name),
    );
  }

  return {
    kind: "ok",
    name: parsed.name,
    input: parsed.input as Record<string, unknown>,
  };
}

function repairUnknownTool(
  index: number,
  name: string,
  tools: OpenCodeTool[],
): Extract<ToolProtocolResult, { kind: "repair" }> {
  const names =
    tools.map((tool) => `\`${tool.name}\``).join(", ") || "no tools";
  return repair(
    index,
    `\`${name}\` is not available. Available tools: ${names}.`,
    exampleFor(tools[0]),
  );
}

function repairMissingInput(
  index: number,
  tool: OpenCodeTool,
  field: string,
): Extract<ToolProtocolResult, { kind: "repair" }> {
  return repair(
    index,
    `\`input.${field}\` is required for \`${tool.name}\`.`,
    exampleFor(tool, field),
  );
}

function repair(
  index: number,
  reason: string,
  example: string,
): Extract<ToolProtocolResult, { kind: "repair" }> {
  return {
    kind: "repair",
    message: `Tool request ${index} was rejected: ${reason}\n\nRetry with:\n\n\`\`\`tools\n${example}\n\`\`\``,
  };
}

function exampleFor(
  tool: OpenCodeTool | undefined,
  requiredField?: string,
): string {
  if (!tool) return '{"name":"tool-name","input":{}}';
  return exampleForName(tool.name, requiredField ?? tool.input?.required?.[0]);
}

function exampleForName(name: string, requiredField?: string): string {
  return JSON.stringify({
    name,
    input: requiredField ? { [requiredField]: "value" } : {},
  });
}
