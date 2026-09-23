import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import { createProviderServer } from "../src/providers/provider-http.ts";

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

async function withServer(
  reply: string | string[],
  run: (url: string, prompts: string[]) => Promise<void>,
): Promise<void> {
  const prompts: string[] = [];
  const replies = Array.isArray(reply) ? [...reply] : [reply];
  const server = createProviderServer({
    async sendAndRead(prompt) {
      prompts.push(prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error("Unexpected provider read.");
      return parseMessage(next);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, prompts);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("persists provider lifecycle transitions without request bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-provider-"));
  const path = join(directory, "events.jsonl");
  const previousPath = process.env.CHATWORKS_EVENT_LOG;
  process.env.CHATWORKS_EVENT_LOG = path;

  try {
    await withServer(
      '```tools\n{"name":"finish","input":{"conclusion":"All set."}}\n```',
      async (url) => {
        const response = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        assert.equal(response.status, 200);
      },
    );

    const text = await readFile(path, "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ["received", "queued", "started", "completed"],
    );
    assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
    assert.doesNotMatch(text, /Inspect src\/app\.ts\./);
    assert.doesNotMatch(text, /All set\./);
  } finally {
    if (previousPath === undefined) delete process.env.CHATWORKS_EVENT_LOG;
    else process.env.CHATWORKS_EVENT_LOG = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves a non-streaming OpenAI-compatible completion", async () => {
  await withServer(
    '```tools\n{"name":"finish","input":{"conclusion":"All set."}}\n```',
    async (url, prompts) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });

      assert.equal(response.status, 200);
      const completion = (await response.json()) as {
        object: string;
        choices: Array<{ message: { content: string }; finish_reason: string }>;
      };
      assert.equal(completion.object, "chat.completion");
      assert.equal(completion.choices[0].message.content, "All set.");
      assert.equal(completion.choices[0].finish_reason, "stop");
      assert.equal(prompts.length, 1);
    },
  );
});

test("streams tool calls in OpenAI-compatible SSE", async () => {
  await withServer(
    'I will inspect it.\n\n```tools\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
    async (url) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: true }),
      });

      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
      );
      const body = await response.text();
      assert.match(body, /"tool_calls"/);
      assert.match(body, /"finish_reason":"tool_calls"/);
      const prose = '"content":"I will inspect it."';
      assert.equal(body.split(prose).length - 1, 1);
      assert.ok(body.indexOf(prose) < body.indexOf('"tool_calls"'));
      assert.match(body, /data: \[DONE\]/);
    },
  );
});

test("streams prose-only internal iterations before the final response", async () => {
  await withServer(
    [
      "Partial finding.",
      '```tools\n{"name":"finish","input":{"conclusion":"Done."}}\n```',
    ],
    async (url, prompts) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: true }),
      });

      assert.equal(response.status, 200);
      const body = await response.text();
      const intermediateIndex = body.indexOf('"content":"Partial finding."');
      const finalIndex = body.indexOf('"content":"Done."');
      assert.ok(intermediateIndex >= 0);
      assert.ok(finalIndex >= 0);
      assert.ok(intermediateIndex < finalIndex);
      assert.equal(body.split('"content":"Partial finding."').length - 1, 1);
      assert.equal(body.split('"content":"Done."').length - 1, 1);
      assert.match(
        body,
        /"content":"Partial finding\."[^\n]*"finish_reason":null/,
      );
      assert.match(body, /"finish_reason":"stop"/);
      assert.equal(prompts.length, 2);
    },
  );
});

test("accepts requests larger than the former 10 MB transport limit", async () => {
  await withServer(
    '```tools\n{"name":"finish","input":{"conclusion":"All set."}}\n```',
    async (url, prompts) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          messages: [{ role: "user", content: "x".repeat(10_000_001) }],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(prompts.length, 1);
    },
  );
});

test("reports malformed requests without contacting Classic", async () => {
  await withServer("Unexpected.", async (url, prompts) => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatworks-classic", messages: [] }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /at least one message/);
    assert.equal(prompts.length, 0);
  });
});
