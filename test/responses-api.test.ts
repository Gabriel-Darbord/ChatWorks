import assert from "node:assert/strict";
import test from "node:test";

import type { OpenAICompletion } from "../src/providers/provider.ts";
import {
  decodeResponsesRequest,
  ResponsesEventStream,
} from "../src/providers/responses-api.ts";

test("decodes Responses messages, function outputs, and function tools", () => {
  const decoded = decodeResponsesRequest({
    model: "chatworks",
    instructions: "Follow the project instructions.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read the file." }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"src/app.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: { contents: "file contents" },
      },
    ],
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    stream: true,
  });

  assert.equal(decoded.stream, true);
  assert.deepEqual(decoded.request.messages, [
    { role: "developer", text: "Follow the project instructions." },
    { role: "user", text: "Read the file." },
    { role: "assistant", text: "" },
    {
      role: "tool",
      text: '{"contents":"file contents"}',
      toolCallId: "call_1",
    },
  ]);
  assert.deepEqual(decoded.request.tools, [
    {
      name: "read",
      description: "Read a file.",
      input: {
        required: ["path"],
        schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ]);
});

test("rejects provider-native Responses tools with a repairable error", () => {
  assert.throws(
    () =>
      decodeResponsesRequest({
        model: "chatworks",
        input: "Search the web.",
        tools: [{ type: "web_search_preview" }],
      }),
    /Disable provider-native tools in the Codex ChatWorks profile/,
  );
});

test("emits a Responses event sequence for text and function output", () => {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const stream = new ResponsesEventStream(
    "chatworks",
    "resp_test",
    (event) => events.push(event),
    123,
  );
  stream.start();
  stream.complete({
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 123,
    model: "chatworks",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I will inspect it.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"src/app.ts"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  } satisfies OpenAICompletion);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.deepEqual((events.at(-1)?.response as { output: unknown[] }).output, [
    {
      id: "msg_resp_test_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: "I will inspect it.", annotations: [] },
      ],
    },
    {
      id: "fc_call_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "read",
      arguments: '{"path":"src/app.ts"}',
    },
  ]);
});
