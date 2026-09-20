import assert from "node:assert/strict";
import test from "node:test";
import { parseChatWorksCommand } from "../src/core/chatworks-language.ts";

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
