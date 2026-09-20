import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "../src/core/message.ts";
import {
  bindExistingParticipant,
  parseParticipantReference,
  createParticipant,
  resolveExistingParticipants,
  resolveParticipant,
  resolveParticipantReference,
  resolveParticipants,
  type ParticipantCreationGateway,
  type ParticipantResolutionGateway,
} from "../src/core/participants.ts";

function resolutionGateway(
  chats: Array<{ index: number; title: string }>,
): ParticipantResolutionGateway {
  return {
    async listChats() {
      return chats;
    },
  };
}

test("binds an existing participant with an explicit logical id", async () => {
  const participant = await bindExistingParticipant(
    "reviewer",
    "2",
    resolutionGateway([
      { index: 1, title: "One" },
      { index: 2, title: "Review Chat" },
    ]),
  );

  assert.deepEqual(participant, {
    id: "reviewer",
    chat: { title: "Review Chat" },
  });
});

test("resolves existing participants for the legacy CLI", async () => {
  const participants = await resolveExistingParticipants(
    ["one", "2"],
    resolutionGateway([
      { index: 1, title: "One" },
      { index: 2, title: "Two" },
    ]),
  );

  assert.deepEqual(participants, [
    { id: "participant-1", chat: { title: "One" } },
    { id: "participant-2", chat: { title: "Two" } },
  ]);
});

test("can resolve a single existing participant", async () => {
  const participants = await resolveExistingParticipants(
    ["One"],
    resolutionGateway([{ index: 1, title: "One" }]),
  );

  assert.deepEqual(participants, [
    { id: "participant-1", chat: { title: "One" } },
  ]);
});

test("rejects an unknown existing chat", async () => {
  await assert.rejects(
    () =>
      bindExistingParticipant(
        "reviewer",
        "Missing",
        resolutionGateway([{ index: 1, title: "One" }]),
      ),
    /Could not find a chat matching 'Missing'/,
  );
});

test("rejects an ambiguous chat title", async () => {
  await assert.rejects(
    () =>
      bindExistingParticipant(
        "reviewer",
        "Duplicate",
        resolutionGateway([
          { index: 1, title: "Duplicate" },
          { index: 2, title: "Duplicate" },
        ]),
      ),
    /More than one chat is named 'Duplicate'/,
  );
});

test("requires distinct chat bindings in a participant set", async () => {
  await assert.rejects(
    () =>
      resolveExistingParticipants(
        ["1", "2"],
        resolutionGateway([
          { index: 1, title: "Duplicate" },
          { index: 2, title: "Duplicate" },
        ]),
      ),
    /unique titles/,
  );
});

test("resolves a deterministically named participant by logical id", async () => {
  const participant = await resolveParticipant(
    "reviewer",
    resolutionGateway([
      { index: 1, title: "Other" },
      { index: 2, title: "ChatWorks: reviewer" },
    ]),
  );

  assert.deepEqual(participant, {
    id: "reviewer",
    chat: { title: "ChatWorks: reviewer" },
  });
});

test("resolves deterministic participant titles case-insensitively", async () => {
  const participant = await resolveParticipant(
    "reviewer",
    resolutionGateway([{ index: 1, title: "CHATWORKS: REVIEWER" }]),
  );

  assert.deepEqual(participant, {
    id: "reviewer",
    chat: { title: "CHATWORKS: REVIEWER" },
  });
});

test("rejects an unknown deterministic participant", async () => {
  await assert.rejects(
    () =>
      resolveParticipant(
        "reviewer",
        resolutionGateway([{ index: 1, title: "Other" }]),
      ),
    /Could not find participant 'reviewer'/,
  );
});

test("rejects duplicate deterministic participant chats", async () => {
  await assert.rejects(
    () =>
      resolveParticipant(
        "reviewer",
        resolutionGateway([
          { index: 1, title: "ChatWorks: reviewer" },
          { index: 2, title: "CHATWORKS: REVIEWER" },
        ]),
      ),
    /More than one participant chat is named 'ChatWorks: reviewer'/,
  );
});

test("resolves a participant roster from one chat snapshot", async () => {
  let listings = 0;

  const participants = await resolveParticipants(["architect", "reviewer"], {
    async listChats() {
      listings += 1;
      return [
        { index: 1, title: "ChatWorks: reviewer" },
        { index: 2, title: "Other" },
        { index: 3, title: "ChatWorks: architect" },
      ];
    },
  });

  assert.equal(listings, 1);
  assert.deepEqual(participants, [
    {
      id: "architect",
      chat: { title: "ChatWorks: architect" },
    },
    {
      id: "reviewer",
      chat: { title: "ChatWorks: reviewer" },
    },
  ]);
});

test("participant roster preserves requested id order", async () => {
  const participants = await resolveParticipants(
    ["reviewer", "architect"],
    resolutionGateway([
      { index: 1, title: "ChatWorks: architect" },
      { index: 2, title: "ChatWorks: reviewer" },
    ]),
  );

  assert.deepEqual(
    participants.map((participant) => participant.id),
    ["reviewer", "architect"],
  );
});

test("participant roster rejects a missing participant", async () => {
  await assert.rejects(
    () =>
      resolveParticipants(
        ["architect", "missing"],
        resolutionGateway([{ index: 1, title: "ChatWorks: architect" }]),
      ),
    /Could not find participant 'missing'/,
  );
});

test("participant roster rejects duplicate logical ids", async () => {
  await assert.rejects(
    () =>
      resolveParticipants(
        ["reviewer", "reviewer"],
        resolutionGateway([{ index: 1, title: "ChatWorks: reviewer" }]),
      ),
    /Participant ids must be unique/,
  );
});

test("creates and deterministically names a role-backed participant after its initial response", async () => {
  const operations: string[] = [];
  let submitted = false;
  let responseObservations = 0;

  const participant = await createParticipant(
    "reviewer",
    {
      instructions: "Act as a critical software design reviewer.",
    },
    {
      async listChats() {
        operations.push("list");

        if (!submitted) {
          return [{ index: 1, title: "Creator" }];
        }

        if (responseObservations >= 2) {
          return [
            { index: 1, title: "Acknowledge participant ID" },
            { index: 2, title: "Creator" },
          ];
        }

        return [
          { index: 1, title: "Generated participant title" },
          { index: 2, title: "Creator" },
        ];
      },

      async newChat() {
        operations.push("new");
      },

      async stage(message) {
        operations.push(`stage:${message}`);
      },

      async submitStagedUnconfirmed() {
        submitted = true;
        operations.push("submit");
      },

      async selectChat(reference) {
        operations.push(`select:${reference}`);
      },

      async observeAssistant() {
        responseObservations += 1;
        operations.push(`observe:${responseObservations}`);

        return {
          latestMessageRole: "assistant",
          message: parseMessage("Participant ready."),
        };
      },

      async composerAvailable() {
        operations.push("composer");
        return true;
      },

      async renameChat(reference, newTitle) {
        operations.push(`rename:${reference}->${newTitle}`);
      },
    },
  );

  assert.deepEqual(participant, {
    id: "reviewer",
    chat: { title: "ChatWorks: reviewer" },
  });

  assert.ok(operations.includes("new"));
  assert.ok(
    operations.some((operation) =>
      operation.startsWith("stage:[ChatWorks participant]"),
    ),
  );
  assert.ok(operations.includes("submit"));
  assert.ok(operations.includes("select:Generated participant title"));
  assert.ok(responseObservations >= 2);
  assert.ok(
    operations.includes(
      "rename:Acknowledge participant ID->ChatWorks: reviewer",
    ),
  );

  assert.ok(
    operations.indexOf("submit") <
      operations.indexOf("select:Generated participant title"),
  );
  assert.ok(
    operations.indexOf("select:Generated participant title") <
      operations.indexOf("observe:1"),
  );
});

test("rejects an existing deterministic participant title before creating a chat", async () => {
  let created = false;
  let renamed = false;

  await assert.rejects(
    () =>
      createParticipant(
        "reviewer",
        { instructions: "Review software design." },
        {
          async listChats() {
            return [{ index: 1, title: "ChatWorks: reviewer" }];
          },

          async newChat() {
            created = true;
          },

          async stage() {},

          async submitStagedUnconfirmed() {},

          async observeAssistant() {
            throw new Error("unexpected assistant observation");
          },

          async composerAvailable() {
            throw new Error("unexpected composer observation");
          },

          async selectChat() {
            throw new Error("unexpected chat selection");
          },

          async renameChat() {
            renamed = true;
          },
        },
      ),
    /already exists/,
  );

  assert.equal(created, false);
  assert.equal(renamed, false);
});

test("parses $self as the current-participant metavariable", () => {
  assert.deepEqual(parseParticipantReference("$self"), {
    kind: "metavariable",
    name: "self",
  });
});

test("parses bare self as an ordinary participant id", () => {
  assert.deepEqual(parseParticipantReference("self"), {
    kind: "participant",
    id: "self",
  });
});

test("rejects unknown participant metavariables", () => {
  assert.throws(
    () => parseParticipantReference("$unknown"),
    /Unknown participant metavariable '\$unknown'/,
  );
});

test("resolves $self from the participant execution context", () => {
  const self = {
    id: "architect",
    chat: { title: "ChatWorks: architect" },
  };

  assert.equal(
    resolveParticipantReference(
      { kind: "metavariable", name: "self" },
      { self },
      [],
    ),
    self,
  );
});

test("rejects $self when execution has no participant binding", () => {
  assert.throws(
    () =>
      resolveParticipantReference(
        { kind: "metavariable", name: "self" },
        {},
        [],
      ),
    /no participant binding/,
  );
});

test("allows self as an ordinary participant id", () => {
  const participant = {
    id: "self",
    chat: { title: "ChatWorks: self" },
  };

  assert.equal(
    resolveParticipantReference(parseParticipantReference("self"), {}, [
      participant,
    ]),
    participant,
  );
});

test("resolves a named participant independently of its chat binding", () => {
  const reviewer = {
    id: "reviewer",
    chat: { title: "ChatWorks: reviewer" },
  };

  assert.equal(
    resolveParticipantReference({ kind: "participant", id: "reviewer" }, {}, [
      reviewer,
    ]),
    reviewer,
  );
});

test("rejects an unknown named participant", () => {
  assert.throws(
    () =>
      resolveParticipantReference(
        { kind: "participant", id: "missing" },
        {},
        [],
      ),
    /Could not find participant 'missing'/,
  );
});
