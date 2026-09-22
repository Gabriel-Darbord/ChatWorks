import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { parseMessage } from "../src/core/message.ts";
import { createOpenCodeProviderServer } from "../src/providers/opencode-http.ts";

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
  reply: string,
  run: (url: string, prompts: string[]) => Promise<void>,
): Promise<void> {
  const prompts: string[] = [];
  const server = createOpenCodeProviderServer({
    async sendAndRead(prompt) {
      prompts.push(prompt);
      return parseMessage(reply);
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

test("serves a non-streaming OpenAI-compatible completion", async () => {
  await withServer("All set.", async (url, prompts) => {
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
  });
});

test("streams tool calls in OpenAI-compatible SSE", async () => {
  await withServer(
    '```tool\n{"name":"read","input":{"path":"src/app.ts"}}\n```',
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
      assert.ok(
        body.indexOf('"content":"I will inspect it."') <
          body.indexOf('"tool_calls"'),
      );
      assert.match(body, /data: \[DONE\]/);
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
