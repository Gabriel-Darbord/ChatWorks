import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import {
  completeOpenCodeRequest,
  type ClassicProviderGateway,
} from "../src/providers/opencode-provider.ts";

const request = {
  model: "chatworks-classic",
  messages: [{ role: "user", content: "Inspect src/app.ts." }],
  tools: [
    {
      type: "function",
      function: {
        name: "read",
        parameters: { type: "object", required: ["path"] },
      },
    },
  ],
};

function gateway(...replies: string[]): {
  gateway: ClassicProviderGateway;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    gateway: {
      async sendAndRead(prompt) {
        prompts.push(prompt);
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected provider read.");
        return parseMessage(reply);
      },
    },
  };
}

test("maps ordered Classic tool blocks to an OpenAI completion", async () => {
  const fixture = gateway(
    'I will inspect it.\n\n```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const result = await completeOpenCodeRequest(request, fixture.gateway);

  assert.equal(fixture.prompts.length, 1);
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.equal(result.choices[0].message.content, "I will inspect it.");
  assert.deepEqual(result.choices[0].message.tool_calls?.[0], {
    id: result.choices[0].message.tool_calls?.[0].id,
    type: "function",
    function: { name: "read", arguments: '{"path":"src/app.ts"}' },
  });
  assert.match(
    result.choices[0].message.tool_calls?.[0].id ?? "",
    /^chatworks_/,
  );
});

test("returns a Classic-generated OpenCode title", async () => {
  const fixture = gateway("Available tools overview");
  const result = await completeOpenCodeRequest(
    {
      model: "chatworks",
      messages: [
        {
          role: "system",
          content:
            "You are a title generator. You output ONLY a thread title. Nothing else.",
        },
        {
          role: "user",
          content: "Generate a title for this conversation:",
        },
        { role: "user", content: "How do I list files?" },
      ],
      tools: [],
    },
    fixture.gateway,
  );

  assert.equal(result.choices[0].message.content, "Available tools overview");
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0], /title generator/);
});

test("serves an individual tool schema through listtools", async () => {
  const fixture = gateway(
    '```tools\n{"name":"listtools","input":{"name":"read"}}\n```',
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const result = await completeOpenCodeRequest(
    {
      ...request,
      messages: [
        { role: "user", content: "Inspect src/app.ts." },
        { role: "assistant", content: "I will inspect it." },
        { role: "user", content: "Continue." },
      ],
    },
    fixture.gateway,
  );

  assert.equal(fixture.prompts.length, 2);
  assert.doesNotMatch(fixture.prompts[0], /input schema/);
  assert.match(fixture.prompts[0], /call listtools/);
  assert.match(fixture.prompts[1], /name: read/);
  assert.match(fixture.prompts[1], /input schema/);
  assert.equal(result.choices[0].message.tool_calls?.[0].function.name, "read");
});

test("repairs an invalid block before returning a response", async () => {
  const fixture = gateway(
    '```tools\n{"name":"read","input":[]}\n```',
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const result = await completeOpenCodeRequest(request, fixture.gateway);

  assert.equal(fixture.prompts.length, 2);
  assert.match(fixture.prompts[1], /Tool request 1 was rejected/);
  assert.equal(result.choices[0].finish_reason, "tool_calls");
});

test("fails after two bounded repair turns", async () => {
  const fixture = gateway(
    "```tools\nnot json\n```",
    "```tools\nnot json\n```",
    "```tools\nnot json\n```",
  );

  await assert.rejects(
    completeOpenCodeRequest(request, fixture.gateway),
    /after 2 repairs/,
  );
  assert.equal(fixture.prompts.length, 3);
});
