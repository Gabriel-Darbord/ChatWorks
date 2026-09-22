import assert from "node:assert/strict";
import test from "node:test";

import {
  compileClassicTurn,
  decodeOpenCodeProviderRequest,
} from "../src/providers/opencode-request.ts";

test("compiles the current request, active tool schemas, and newest context", () => {
  const request = decodeOpenCodeProviderRequest({
    model: "chatworks-classic",
    messages: [
      { role: "system", content: "Work carefully." },
      { role: "user", content: "Old request" },
      { role: "assistant", content: "I will inspect it." },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "src/app.ts contains one TODO.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a UTF-8 text file.",
          parameters: { type: "object", required: ["path"] },
        },
      },
    ],
  });

  const compiled = compileClassicTurn(request);

  assert.deepEqual(compiled.tools, [
    {
      name: "read",
      description: "Read a UTF-8 text file.",
      input: {
        required: ["path"],
        schema: { type: "object", required: ["path"] },
      },
    },
  ]);
  assert.match(compiled.prompt, /one or more fenced `tool` blocks/);
  assert.match(compiled.prompt, /name: read/);
  assert.match(compiled.prompt, /Work carefully\./);
  assert.match(compiled.prompt, /src\/app\.ts contains one TODO\./);
  assert.doesNotMatch(compiled.prompt, /Old request/);
});

test("renders tool descriptions with their original line breaks", () => {
  const request = decodeOpenCodeProviderRequest({
    model: "chatworks",
    messages: [{ role: "user", content: "Inspect the project." }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file.\nKeep line numbers.",
        },
      },
    ],
  });

  const prompt = compileClassicTurn(request).prompt;
  assert.match(prompt, /Read a file\.\nKeep line numbers\./);
  assert.doesNotMatch(prompt, /Read a file\\nKeep line numbers\./);
});

test("accepts OpenAI text-content arrays", () => {
  const request = decodeOpenCodeProviderRequest({
    model: "chatworks-classic",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect " },
          { type: "text", text: "this file." },
        ],
      },
    ],
  });

  assert.equal(
    compileClassicTurn(request).prompt.includes("Inspect this file."),
    true,
  );
});

test("preserves every result in a batched tool response", () => {
  const request = decodeOpenCodeProviderRequest({
    model: "chatworks-classic",
    messages: [
      { role: "user", content: "Inspect these files." },
      { role: "assistant", content: "I will read them." },
      { role: "tool", content: "first file contents" },
      { role: "tool", content: "second file contents" },
      { role: "tool", content: "third file contents" },
    ],
  });

  const prompt = compileClassicTurn(request).prompt;
  assert.match(
    prompt,
    /Tool result 1:\n\nfirst file contents\n\nTool result 2:\n\nsecond file contents\n\nTool result 3:\n\nthird file contents/,
  );
});

test("rejects an unsupported content part with an actionable error", () => {
  assert.throws(
    () =>
      decodeOpenCodeProviderRequest({
        model: "chatworks-classic",
        messages: [
          { role: "user", content: [{ type: "image", image_url: "..." }] },
        ],
      }),
    /content part 1 must be a text part/,
  );
});

test("rejects malformed tool schemas before contacting Classic", () => {
  assert.throws(
    () =>
      decodeOpenCodeProviderRequest({
        model: "chatworks-classic",
        messages: [{ role: "user", content: "Read a file." }],
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { required: "path" } },
          },
        ],
      }),
    /parameters.required must be a string array/,
  );
});
