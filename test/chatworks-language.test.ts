import assert from "node:assert/strict";
import test from "node:test";
import {
  messageRequestsAbort,
  parseChatWorksCommand,
  parseChatWorksCommands,
} from "../src/core/chatworks-language.ts";

test("parses send to a named participant", () => {
  assert.deepEqual(
    parseChatWorksCommand("send reviewer Review the current implementation."),
    {
      kind: "send",
      recipient: { kind: "participant", id: "reviewer" },
      message: "Review the current implementation.",
    },
  );
});

test("parses send to $self", () => {
  assert.deepEqual(parseChatWorksCommand("send $self Reason about UX."), {
    kind: "send",
    recipient: { kind: "metavariable", name: "self" },
    message: "Reason about UX.",
  });
});

test("preserves a multiline message", () => {
  assert.deepEqual(
    parseChatWorksCommand("send reviewer First line.\nSecond line."),
    {
      kind: "send",
      recipient: { kind: "participant", id: "reviewer" },
      message: "First line.\nSecond line.",
    },
  );
});

test("rejects an empty send message", () => {
  assert.throws(
    () => parseChatWorksCommand("send reviewer"),
    /Expected a ChatWorks command/,
  );
});

test("rejects unknown commands", () => {
  assert.throws(
    () => parseChatWorksCommand("discuss reviewer architect"),
    /Expected a ChatWorks command/,
  );
});

test("rejects unknown participant metavariables", () => {
  assert.throws(
    () => parseChatWorksCommand("send $sender Hello."),
    /Unknown participant metavariable '\$sender'/,
  );
});

test("parses TODO management commands", () => {
  assert.deepEqual(parseChatWorksCommand("todo list"), {
    kind: "todo-list",
  });
  assert.deepEqual(parseChatWorksCommand("todo add New work"), {
    kind: "todo-add",
    title: "New work",
  });
  assert.deepEqual(parseChatWorksCommand("todo edit 3 Better work"), {
    kind: "todo-edit",
    id: 3,
    title: "Better work",
  });
  assert.deepEqual(parseChatWorksCommand("todo done 3"), {
    kind: "todo-done",
    id: 3,
  });
  assert.deepEqual(parseChatWorksCommand("todo reopen 3"), {
    kind: "todo-reopen",
    id: 3,
  });
  assert.deepEqual(parseChatWorksCommand("todo delete 3"), {
    kind: "todo-delete",
    id: 3,
  });
});

test("parses line-oriented TODO commands followed by a multiline send", () => {
  assert.deepEqual(
    parseChatWorksCommands(
      "todo add First\n" +
        "todo done 3\n" +
        "send reviewer First line.\n" +
        "todo handling is part of this message.\n" +
        "send semantics are too.",
    ),
    [
      { kind: "todo-add", title: "First" },
      { kind: "todo-done", id: 3 },
      {
        kind: "send",
        recipient: { kind: "participant", id: "reviewer" },
        message:
          "First line.\ntodo handling is part of this message.\nsend semantics are too.",
      },
    ],
  );
});

test("rejects unrecognized command lines before send", () => {
  assert.throws(
    () => parseChatWorksCommands("todo list\nordinary text\ntodo list"),
    /Expected a ChatWorks command at line 2/,
  );
});

test("parses abort and reason commands", () => {
  assert.deepEqual(parseChatWorksCommand("abort"), { kind: "abort" });
  assert.deepEqual(parseChatWorksCommand("reason"), { kind: "reason" });
});

test("detects abort anywhere in ChatWorks blocks", () => {
  assert.equal(
    messageRequestsAbort({
      parts: [
        {
          kind: "block",
          language: "bash",
          source: ["#!chatworks", "printf should-never-run"].join("\n"),
        },
        {
          kind: "block",
          language: "chatworks",
          source: ["todo list", "abort", "todo list"].join("\n"),
        },
      ],
    }),
    true,
  );
});

test("does not treat reason or ordinary abort text as turn abort", () => {
  assert.equal(
    messageRequestsAbort({
      parts: [
        { kind: "plain-text", text: "abort" },
        { kind: "block", language: "chatworks", source: "reason" },
      ],
    }),
    false,
  );
});
