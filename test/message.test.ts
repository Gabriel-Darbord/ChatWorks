import assert from "node:assert/strict";
import test from "node:test";
import {
  messageFromAccessibilityParts,
  messageIdentity,
  messageText,
  parseMessage,
} from "../src/core/message.ts";

test("models plain text and explicit matching fenced blocks in order", () => {
  assert.deepEqual(
    parseMessage("before\n```sh\npwd\n```\nafter\n````bash\necho hi\n````")
      .parts,
    [
      { kind: "plain-text", text: "before" },
      { kind: "block", language: "sh", source: "pwd" },
      { kind: "plain-text", text: "after" },
      { kind: "block", language: "bash", source: "echo hi" },
    ],
  );
});

test("preserves malformed and incomplete fences as plain text", () => {
  assert.deepEqual(
    parseMessage("```\necho ignored\n```\n```zsh\necho open").parts,
    [{ kind: "plain-text", text: "```\necho ignored\n```\n```zsh\necho open" }],
  );
});

test("models fenced-block metadata without changing its language", () => {
  assert.deepEqual(
    parseMessage('```sh id="shell-test"\necho hello\n```').parts,
    [
      {
        kind: "block",
        language: "sh",
        metadata: 'id="shell-test"',
        source: "echo hello",
      },
    ],
  );
});

test("constructs a message directly from accessibility parts", () => {
  const message = messageFromAccessibilityParts([
    { kind: "text", text: "before" },
    { kind: "code", language: "Bash", source: "printf 'hello\\n'" },
    { kind: "text", text: "after" },
  ]);

  assert.equal(message.raw, undefined);
  assert.deepEqual(message.parts, [
    { kind: "plain-text", text: "before" },
    { kind: "block", language: "bash", source: "printf 'hello\\n'" },
    { kind: "plain-text", text: "after" },
  ]);
});

test("preserves accessibility code when its language is unavailable", () => {
  assert.deepEqual(
    messageFromAccessibilityParts([{ kind: "code", source: "echo hello" }])
      .parts,
    [{ kind: "block", language: "", source: "echo hello" }],
  );

  assert.throws(
    () => messageFromAccessibilityParts([{ kind: "code", language: "bash" }]),
    /missing source/,
  );
});

test("identifies messages from their ordered semantic parts", () => {
  const first = {
    parts: [
      { kind: "plain-text" as const, text: "before" },
      { kind: "block" as const, language: "bash", source: "pwd" },
    ],
  };
  const sameWithRaw = {
    raw: "a representation that does not define identity",
    parts: first.parts,
  };
  const changed = {
    parts: [
      { kind: "plain-text" as const, text: "before" },
      { kind: "block" as const, language: "bash", source: "whoami" },
    ],
  };

  assert.equal(messageIdentity(first), messageIdentity(sameWithRaw));
  assert.notEqual(messageIdentity(first), messageIdentity(changed));
});

test("renders semantic message parts for textual transport", () => {
  assert.equal(
    messageText({
      parts: [
        { kind: "plain-text", text: "before" },
        { kind: "block", language: "bash", source: "pwd" },
        { kind: "plain-text", text: "after" },
        { kind: "block", language: "", source: "opaque source" },
      ],
    }),
    "before\n\n```bash\npwd\n```\n\nafter\n\n```text\nopaque source\n```",
  );
});
