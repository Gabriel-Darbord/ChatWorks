import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import {
  completeProviderRequest,
  createProviderState,
  type ClassicProviderGateway,
} from "../src/providers/provider.ts";

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

  const result = await completeProviderRequest(request, fixture.gateway);

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

test("uses distinct tool-call ids for identical provider requests", async () => {
  const fixture = gateway(
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const first = await completeProviderRequest(request, fixture.gateway);
  const second = await completeProviderRequest(request, fixture.gateway);

  assert.notEqual(
    first.choices[0].message.tool_calls?.[0].id,
    second.choices[0].message.tool_calls?.[0].id,
  );
  assert.notEqual(first.id, second.id);
});

test("dynamically namespaces internal tools away from client tools", async () => {
  const collidingRequest = {
    model: "chatworks",
    messages: [
      { role: "user", content: "Begin the task." },
      { role: "assistant", content: "I started it." },
      { role: "user", content: "Use the appropriate finish tool." },
    ],
    tools: [
      "finish",
      "listtools",
      "chatworks_internal_finish",
      "chatworks_internal_listtools",
    ].map((name) => ({
      type: "function",
      function: { name },
    })),
  };
  const externalFixture = gateway(
    '```tools\n{"name":"finish","input":{}}\n{"name":"listtools","input":{}}\n```',
  );

  const external = await completeProviderRequest(
    collidingRequest,
    externalFixture.gateway,
  );

  assert.deepEqual(
    external.choices[0].message.tool_calls?.map((call) => call.function.name),
    ["finish", "listtools"],
  );
  assert.match(externalFixture.prompts[0], /`chatworks_internal_2_finish`/);
  assert.match(
    externalFixture.prompts[0],
    /call chatworks_internal_2_listtools/,
  );

  const internalFixture = gateway(
    '```tools\n{"name":"chatworks_internal_2_finish","input":{"conclusion":"Done."}}\n```',
  );
  const internal = await completeProviderRequest(
    collidingRequest,
    internalFixture.gateway,
  );
  assert.equal(internal.choices[0].message.content, "Done.");
  assert.equal(internal.choices[0].finish_reason, "stop");
});

test("returns a Classic-generated client title", async () => {
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Available tools overview"}}\n```',
  );
  const result = await completeProviderRequest(
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

test("serves the full tool catalog through listtools", async () => {
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_listtools","input":{}}\n```',
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const result = await completeProviderRequest(
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
  assert.doesNotMatch(fixture.prompts[0], /input schema:/);
  assert.match(fixture.prompts[0], /call chatworks_internal_listtools/);
  assert.match(fixture.prompts[1], /Full tool catalog requested/);
  assert.match(fixture.prompts[1], /name: read/);
  assert.match(fixture.prompts[1], /input schema/);
  assert.equal(result.choices[0].message.tool_calls?.[0].function.name, "read");
});

test("composes listtools with surrounding real tool calls", async () => {
  const fixture = gateway(
    '```tools\n{"name":"read","input":{"path":"src/a.ts"}}\n{"name":"chatworks_internal_listtools","input":{}}\n{"name":"read","input":{"path":"src/b.ts"}}\n```',
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Done."}}\n```',
  );
  const state = createProviderState();
  const continuedRequest = {
    ...request,
    messages: [
      { role: "user", content: "Inspect both files." },
      { role: "assistant", content: "I will inspect them." },
      { role: "user", content: "Continue." },
    ],
  };

  const first = await completeProviderRequest(
    continuedRequest,
    fixture.gateway,
    undefined,
    state,
  );
  const calls = first.choices[0].message.tool_calls ?? [];

  assert.equal(fixture.prompts.length, 1);
  assert.deepEqual(
    calls.map((call) => call.function.name),
    ["read", "read"],
  );

  const second = await completeProviderRequest(
    {
      ...continuedRequest,
      messages: [
        ...continuedRequest.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: calls,
        },
        { role: "tool", tool_call_id: calls[0].id, content: "result A" },
        { role: "tool", tool_call_id: calls[1].id, content: "result B" },
      ],
    },
    fixture.gateway,
    undefined,
    state,
  );

  assert.equal(second.choices[0].message.content, "Done.");
  assert.equal(fixture.prompts.length, 2);
  const followUp = fixture.prompts[1];
  const catalogIndex = followUp.indexOf("Full tool catalog requested");
  const resultAIndex = followUp.indexOf("result A");
  const resultBIndex = followUp.indexOf("result B");
  assert.ok(catalogIndex >= 0);
  assert.ok(catalogIndex < resultAIndex);
  assert.ok(resultAIndex < resultBIndex);
});

test("bounds and expires abandoned pending provider state", async () => {
  let now = 1_000_000;
  const state = createProviderState(() => now);
  for (let index = 0; index < 600; index += 1) {
    state.pendingByToolCall.set(`abandoned-${index}`, {
      createdAt: now,
      internalResult: `stale context ${index}`,
    });
  }
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"First."}}\n```',
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Second."}}\n```',
  );

  await completeProviderRequest(request, fixture.gateway, undefined, state);
  assert.equal(state.pendingByToolCall.size, 512);

  now += 30 * 60 * 1_000 + 1;
  await completeProviderRequest(
    {
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: "Waiting for a tool." },
        {
          role: "tool",
          tool_call_id: "abandoned-599",
          content: "current result",
        },
      ],
    },
    fixture.gateway,
    undefined,
    state,
  );

  assert.equal(state.pendingByToolCall.size, 0);
  assert.doesNotMatch(fixture.prompts[1], /stale context/);
  assert.match(fixture.prompts[1], /current result/);
});

test("finishes internally with prose as the final response", async () => {
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Implementation complete."}}\n```',
  );

  const result = await completeProviderRequest(request, fixture.gateway);

  assert.equal(result.choices[0].message.content, "Implementation complete.");
  assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.equal(result.choices[0].finish_reason, "stop");
});

test("rejects finish without a conclusion", async () => {
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_finish","input":{}}\n```',
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Done."}}\n```',
  );

  const result = await completeProviderRequest(request, fixture.gateway);

  assert.equal(fixture.prompts.length, 2);
  assert.match(fixture.prompts[1], /conclusion/);
  assert.equal(result.choices[0].message.content, "Done.");
  assert.equal(result.choices[0].finish_reason, "stop");
});

test("emits all Classic prose while continuing internally until finish", async () => {
  const fixture = gateway(
    "Partial finding.",
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Done."}}\n```',
  );

  const intermediate: string[] = [];
  const result = await completeProviderRequest(
    request,
    fixture.gateway,
    undefined,
    undefined,
    (text) => intermediate.push(text),
  );

  assert.equal(fixture.prompts.length, 2);
  assert.match(fixture.prompts[1], /coding-agent turn is still active/i);
  assert.deepEqual(intermediate, ["Partial finding."]);
  assert.equal(result.choices[0].message.content, "Done.");
  assert.equal(result.choices[0].finish_reason, "stop");
});

test("bounds internal turns when Classic never finishes", async () => {
  const fixture = gateway(
    ...Array.from({ length: 16 }, () => "Still working."),
  );

  await assert.rejects(
    completeProviderRequest(request, fixture.gateway),
    /stopped after 16 internal turns without a valid finish call/,
  );
  assert.equal(fixture.prompts.length, 16);
});

test("ignores finish alongside another tool and executes the other tool", async () => {
  const fixture = gateway(
    'Still checking.\n\n```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n{"name":"chatworks_internal_finish","input":{"conclusion":"Premature conclusion"}}\n```',
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Done."}}\n```',
  );
  const state = createProviderState();

  const first = await completeProviderRequest(
    request,
    fixture.gateway,
    undefined,
    state,
  );
  const calls = first.choices[0].message.tool_calls ?? [];

  assert.equal(first.choices[0].finish_reason, "tool_calls");
  assert.equal(first.choices[0].message.content, "Still checking.");
  assert.deepEqual(
    calls.map((call) => call.function.name),
    ["read"],
  );

  const second = await completeProviderRequest(
    {
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: first.choices[0].message.content,
          tool_calls: calls,
        },
        { role: "tool", tool_call_id: calls[0].id, content: "file contents" },
      ],
    },
    fixture.gateway,
    undefined,
    state,
  );

  assert.match(fixture.prompts[1], /finish.*ignored/i);
  assert.match(fixture.prompts[1], /file contents/);
  assert.equal(second.choices[0].finish_reason, "stop");
});

test("ignores finish alongside listtools and serves the catalog", async () => {
  const fixture = gateway(
    '```tools\n{"name":"chatworks_internal_listtools","input":{}}\n{"name":"chatworks_internal_finish","input":{"conclusion":"Premature conclusion"}}\n```',
    '```tools\n{"name":"chatworks_internal_finish","input":{"conclusion":"Done."}}\n```',
  );

  const result = await completeProviderRequest(request, fixture.gateway);

  assert.equal(fixture.prompts.length, 2);
  assert.match(fixture.prompts[1], /Full tool catalog requested/);
  assert.match(fixture.prompts[1], /finish.*ignored/i);
  assert.equal(result.choices[0].finish_reason, "stop");
});

test("repairs an invalid block before returning a response", async () => {
  const fixture = gateway(
    '```tools\n{"name":"read","input":[]}\n```',
    '```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
  );

  const result = await completeProviderRequest(request, fixture.gateway);

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
    completeProviderRequest(request, fixture.gateway),
    /after 2 repairs/,
  );
  assert.equal(fixture.prompts.length, 3);
});
