import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "../src/core/message.ts";

test("models plain text and explicit matching fenced blocks in order", () => {
  assert.deepEqual(parseMessage("before\n```sh\npwd\n```\nafter\n````bash\necho hi\n````").parts, [
    { kind: "plain-text", text: "before" },
    { kind: "block", language: "sh", source: "pwd" },
    { kind: "plain-text", text: "after" },
    { kind: "block", language: "bash", source: "echo hi" },
  ]);
});

test("preserves malformed and incomplete fences as plain text", () => {
  assert.deepEqual(parseMessage("```\necho ignored\n```\n```zsh\necho open").parts, [
    { kind: "plain-text", text: "```\necho ignored\n```\n```zsh\necho open" },
  ]);
});

test("models fenced-block metadata without changing its language", () => {
  assert.deepEqual(parseMessage("```sh id=\"shell-test\"\necho hello\n```").parts, [
    { kind: "block", language: "sh", metadata: "id=\"shell-test\"", source: "echo hello" },
  ]);
});
