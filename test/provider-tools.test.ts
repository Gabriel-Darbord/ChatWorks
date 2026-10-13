import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import { parseProviderToolBlocks } from "../src/providers/provider-tools.ts";

const tools = [
  { name: "read", input: { required: ["path"] } },
  { name: "grep", input: { required: ["pattern"] } },
];

test("preserves ordered JSONL tool calls with stable call ids", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      'I will inspect both files.\n\n```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n{"name":"grep","input":{"pattern":"TODO"}}\n```',
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

test("recognizes a tools block even when AX reports prose after it", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      '```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\nI will inspect it.',
    ),
    tools,
    "turn_7b",
  );

  assert.deepEqual(result, {
    kind: "tool-calls",
    text: "I will inspect it.",
    calls: [
      {
        id: "chatworks_turn_7b_1",
        name: "read",
        input: { path: "src/a.ts" },
      },
    ],
  });
});

test("accepts multiple tools blocks in encounter order", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      'First call.\n\n```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\nThen search.\n\n```tools\n{"name":"grep","input":{"pattern":"TODO"}}\n```',
    ),
    tools,
    "turn_7c",
  );

  assert.deepEqual(result, {
    kind: "tool-calls",
    text: "First call.\n\nThen search.",
    calls: [
      {
        id: "chatworks_turn_7c_1",
        name: "read",
        input: { path: "src/a.ts" },
      },
      {
        id: "chatworks_turn_7c_2",
        name: "grep",
        input: { pattern: "TODO" },
      },
    ],
  });
});

test("returns ordinary assistant text without a tool delimiter", () => {
  assert.deepEqual(
    parseProviderToolBlocks(
      parseMessage("The change is complete."),
      tools,
      "turn_8",
    ),
    { kind: "text", text: "The change is complete." },
  );
});

test("rejects adjacent bare JSON calls without executing them", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      '{"name":"read","input":{"path":"src/a.ts"}}{"name":"grep","input":{"pattern":"TODO"}}',
    ),
    tools,
    "turn_bare",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /no fenced `tools` block was found/);
  assert.match(result.message, /Nothing was executed/);
  assert.doesNotMatch(JSON.stringify(result), /chatworks_turn_bare_1/);
});

test("rejects JSON calls in a code fence without the tools marker", () => {
  const result = parseProviderToolBlocks(
    parseMessage('```json\n{"name":"read","input":{"path":"src/a.ts"}}\n```'),
    tools,
    "turn_unmarked",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /no fenced `tools` block was found/);
  assert.match(result.message, /Nothing was executed/);
});

test("does not extract bare JSON tool calls from surrounding prose", () => {
  assert.deepEqual(
    parseProviderToolBlocks(
      parseMessage('Try this: {"name":"read","input":{"path":"src/a.ts"}}'),
      tools,
      "turn_bare_prose",
    ),
    {
      kind: "text",
      text: 'Try this: {"name":"read","input":{"path":"src/a.ts"}}',
    },
  );
});

test("preserves ordinary fenced blocks alongside tool calls", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      'I found the issue.\n\n```ts\nconst answer = 42;\n```\n\n```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```',
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

test("allows prose alongside a tools block", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      'I found the issue.\n\n```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n\nI will inspect the file.',
    ),
    tools,
    "turn_8d",
  );

  assert.deepEqual(result, {
    kind: "tool-calls",
    text: "I found the issue.\n\nI will inspect the file.",
    calls: [
      {
        id: "chatworks_turn_8d_1",
        name: "read",
        input: { path: "src/a.ts" },
      },
    ],
  });
});

test("does not interpret closing-fence text inside tool JSON", () => {
  const result = parseProviderToolBlocks(
    parseMessage('````tools\n{"name":"grep","input":{"pattern":"```"}}\n````'),
    tools,
    "turn_8c",
  );

  assert.equal(result.kind, "tool-calls");
  assert.deepEqual(result.calls[0].input, { pattern: "```" });
});

test("repairs malformed JSONL without accepting a valid prefix", () => {
  const result = parseProviderToolBlocks(
    parseMessage(
      '```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n{"name":"grep","input":[]}\n```',
    ),
    tools,
    "turn_9",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /Tool request 2 was rejected/);
  assert.match(result.message, /`input` must be a JSON object/);
});

test("repairs missing required input with a minimal replacement", () => {
  const result = parseProviderToolBlocks(
    parseMessage('```tools\n{"name":"read","input":{}}\n```'),
    tools,
    "turn_10",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /`input.path` is required/);
  assert.match(result.message, /```tools/);
  assert.match(result.message, /"path":"value"/);
});
