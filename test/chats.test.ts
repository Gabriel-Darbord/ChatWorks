import assert from "node:assert/strict";
import test from "node:test";
import {
  createChat,
  chatsAddedSince,
  type ChatCreationGateway,
  type ListedChat,
} from "../src/core/chats.ts";

test("identifies a newly appeared chat independently of sidebar ordering", () => {
  const before: ListedChat[] = [
    { index: 1, title: "One" },
    { index: 2, title: "Two" },
  ];
  const after: ListedChat[] = [
    { index: 1, title: "New" },
    { index: 2, title: "One" },
    { index: 3, title: "Two" },
  ];

  assert.deepEqual(chatsAddedSince(before, after), [
    { index: 1, title: "New" },
  ]);
});

test("accounts for duplicate pre-existing titles", () => {
  const before: ListedChat[] = [
    { index: 1, title: "Same" },
    { index: 2, title: "Same" },
  ];
  const after: ListedChat[] = [
    { index: 1, title: "New" },
    { index: 2, title: "Same" },
    { index: 3, title: "Same" },
  ];

  assert.deepEqual(chatsAddedSince(before, after), [
    { index: 1, title: "New" },
  ]);
});

test("creates, initializes, and binds a new chat by its generated title", async () => {
  let chats: ListedChat[] = [{ index: 1, title: "Existing" }];
  const operations: string[] = [];
  let polls = 0;

  const gateway: ChatCreationGateway = {
    async listChats() {
      polls += 1;

      if (polls >= 3) {
        chats = [
          { index: 1, title: "Generated participant title" },
          { index: 2, title: "Existing" },
        ];
      }

      return chats;
    },

    async newChat() {
      operations.push("new");
    },

    async stage(message) {
      operations.push(`stage:${message}`);
    },

    async submitStagedUnconfirmed() {
      operations.push("send");
    },
  };

  const reference = await createChat("participant initialization", gateway, {
    pollMilliseconds: 0,
    timeoutMilliseconds: 1_000,
  });

  assert.deepEqual(reference, {
    title: "Generated participant title",
  });
  assert.deepEqual(operations, [
    "new",
    "stage:participant initialization",
    "send",
  ]);
});

test("rejects ambiguous simultaneous chat creation", async () => {
  let reads = 0;

  const gateway: ChatCreationGateway = {
    async listChats() {
      reads += 1;

      if (reads === 1) {
        return [{ index: 1, title: "Existing" }];
      }

      return [
        { index: 1, title: "First new" },
        { index: 2, title: "Second new" },
        { index: 3, title: "Existing" },
      ];
    },

    async newChat() {},
    async stage() {},
    async submitStagedUnconfirmed() {},
  };

  await assert.rejects(
    () =>
      createChat("initialize", gateway, {
        pollMilliseconds: 0,
        timeoutMilliseconds: 1_000,
      }),
    /More than one new ChatGPT chat appeared/,
  );
});
