import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import { parseOpenCodeToolBlocks } from "../src/providers/opencode-tools.ts";

const tools = [
  { name: "read", input: { required: ["path"] } },
  { name: "grep", input: { required: ["pattern"] } },
];

test("preserves ordered JSONL tool calls with stable call ids", () => {
  const result = parseOpenCodeToolBlocks(
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
  const result = parseOpenCodeToolBlocks(
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

test("rejects multiple tools blocks", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      '```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```\n```tools\n{"name":"grep","input":{"pattern":"TODO"}}\n```',
    ),
    tools,
    "turn_7c",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /more than one tools block/);
});

test("returns ordinary assistant text without a tool delimiter", () => {
  assert.deepEqual(
    parseOpenCodeToolBlocks(
      parseMessage("The change is complete."),
      tools,
      "turn_8",
    ),
    { kind: "text", text: "The change is complete." },
  );
});

test("repairs a non-tool block alongside tool calls", () => {
  const result = parseOpenCodeToolBlocks(
    parseMessage(
      'I found the issue.\n\n```ts\nconst answer = 42;\n```\n\n```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n```',
    ),
    tools,
    "turn_8b",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /`ts` block in addition to the tools block/);
  assert.match(result.message, /tools block must be the only fenced block/);
});

test("allows prose alongside the single tools block", () => {
  const result = parseOpenCodeToolBlocks(
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
  const result = parseOpenCodeToolBlocks(
    parseMessage('````tools\n{"name":"grep","input":{"pattern":"```"}}\n````'),
    tools,
    "turn_8c",
  );

  assert.equal(result.kind, "tool-calls");
  assert.deepEqual(result.calls[0].input, { pattern: "```" });
});

test("repairs malformed JSONL without accepting a valid prefix", () => {
  const result = parseOpenCodeToolBlocks(
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
  const result = parseOpenCodeToolBlocks(
    parseMessage('```tools\n{"name":"read","input":{}}\n```'),
    tools,
    "turn_10",
  );

  assert.equal(result.kind, "repair");
  assert.match(result.message, /`input.path` is required/);
  assert.match(result.message, /```tools/);
  assert.match(result.message, /"path":"value"/);
});
