import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import { parseOpenCodeToolBlocks } from "../src/providers/opencode-tools.ts";

const tools = [
  { name: "read", input: { required: ["path"] } },
  { name: "grep", input: { required: ["pattern"] } },
];

test("preserves ordered multiple tool blocks with stable call ids", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      'I will inspect both files.\n\n```tool\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\n```tool\n{"name":"grep","input":{"pattern":"TODO"}}\n```',
    ),
    tools,
    "turn_7",
  );

  assert.deepEqual(result, {
    kind: "tool-calls",
    text: "I will inspect both files.",
    calls: [
      {
        id: "chatworks_turn_7_1",
        name: "read",
        input: { path: "src/a.ts" },
      },
      {
        id: "chatworks_turn_7_2",
        name: "grep",
        input: { pattern: "TODO" },
      },
    ],
  });
});

test("preserves text on both sides of a tool request", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      'Before the operation.\n\n```tool\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\nAfter the operation.',
    ),
    tools,
    "turn_7b",
  );

  assert.equal(result.kind, "tool-calls");
  assert.equal(result.text, "Before the operation.\n\nAfter the operation.");
});

test("returns ordinary assistant text when no tool block is present", () => {
  assert.deepEqual(
    parseOpenCodeToolBlocks(
      parseMessage("The change is complete."),
      tools,
      "turn_8",
    ),
    { kind: "text", text: "The change is complete." },
  );
});

test("preserves non-tool code alongside a tool request", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      'I found the issue.\n\n```ts\nconst answer = 42;\n```\n\n```tool\n{"name":"read","input":{"path":"src/a.ts"}}\n```',
    ),
    tools,
    "turn_8b",
  );

  assert.deepEqual(result, {
    kind: "tool-calls",
    text: "I found the issue.\n\n```ts\nconst answer = 42;\n```",
    calls: [
      {
        id: "chatworks_turn_8b_1",
        name: "read",
        input: { path: "src/a.ts" },
      },
    ],
  });
});

test("repairs malformed blocks without accepting a valid prefix", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      '```tool\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\n```tool\n{"name":"grep","input":[] }\n```',
    ),
    tools,
    "turn_9",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /Tool request 2 was rejected/);
  assert.match(result.message, /`input` must be a JSON object/);
});

test("repairs missing required input with a minimal replacement", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage('```tool\n{"name":"read","input":{}}\n```'),
    tools,
    "turn_10",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /`input.path` is required/);
  assert.match(result.message, /"path":"value"/);
});
