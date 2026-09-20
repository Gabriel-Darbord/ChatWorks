import assert from "node:assert/strict";
import test from "node:test";
import {
  participantExecutionScope,
  type ParticipantExecutionGateway,
} from "../src/core/participant-execution.ts";

function gateway(
  chats: Array<{ index: number; title: string }>,
  selections: string[],
): ParticipantExecutionGateway {
  return {
    async listChats() {
      return chats;
    },

    async selectChat(reference) {
      selections.push(reference);
    },
  };
}

test("unbound execution has no participant and does not navigate", async () => {
  const selections: string[] = [];

  const scope = await participantExecutionScope(
    undefined,
    gateway([{ index: 1, title: "ChatWorks: reviewer" }], selections),
  );

  assert.deepEqual(scope, {});
  assert.deepEqual(selections, []);
});

test("participant execution selects its chat and binds self", async () => {
  const selections: string[] = [];

  const scope = await participantExecutionScope(
    "reviewer",
    gateway(
      [
        { index: 1, title: "Other" },
        { index: 2, title: "ChatWorks: reviewer" },
      ],
      selections,
    ),
  );

  assert.deepEqual(scope, {
    self: {
      id: "reviewer",
      chat: { title: "ChatWorks: reviewer" },
    },
  });
  assert.deepEqual(selections, ["ChatWorks: reviewer"]);
});

test("participant execution selects the actual resolved title", async () => {
  const selections: string[] = [];

  const scope = await participantExecutionScope(
    "reviewer",
    gateway([{ index: 1, title: "CHATWORKS: REVIEWER" }], selections),
  );

  assert.equal(scope.self?.chat.title, "CHATWORKS: REVIEWER");
  assert.deepEqual(selections, ["CHATWORKS: REVIEWER"]);
});

test("participant resolution failure does not navigate", async () => {
  const selections: string[] = [];

  await assert.rejects(
    () =>
      participantExecutionScope(
        "missing",
        gateway([{ index: 1, title: "Other" }], selections),
      ),
    /Could not find participant 'missing'/,
  );

  assert.deepEqual(selections, []);
});
