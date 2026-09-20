import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage, type Block } from "../src/core/message.ts";
import {
  chatWorksModule,
  type ChatWorksGateway,
} from "../src/modules/chatworks.ts";

function block(source: string): Block {
  const message = parseMessage(`\`\`\`chatworks\n${source}\n\`\`\``);
  const part = message.parts[0];
  assert.equal(part.kind, "block");
  return part as Block;
}

function context(self?: { id: string; chat: { title: string } }) {
  return {
    scope: self ? { self } : {},
    onBlockStart() {},
    onBlockFinish() {},
    onOutput() {},
  };
}

test("sends to a named participant", async () => {
  const operations: string[] = [];

  const gateway: ChatWorksGateway = {
    async listChats() {
      return [
        { index: 1, title: "ChatWorks: reviewer" },
        { index: 2, title: "ChatWorks: architect" },
      ];
    },
    async selectChat(reference) {
      operations.push(`select:${reference}`);
    },
    async send(message) {
      operations.push(`send:${message}`);
    },
  };

  const module = chatWorksModule(gateway);

  const result = await module.visit(
    block("send reviewer Review this design."),
    context(),
  );

  assert.deepEqual(operations, [
    "select:ChatWorks: reviewer",
    "send:Review this design.",
  ]);
  assert.equal(result, "Sent message to reviewer.");
});

test("sends to $self without resolving it from the participant repository", async () => {
  const operations: string[] = [];
  let listed = false;

  const gateway: ChatWorksGateway = {
    async listChats() {
      listed = true;
      return [];
    },
    async selectChat(reference) {
      operations.push(`select:${reference}`);
    },
    async send(message) {
      operations.push(`send:${message}`);
    },
  };

  const module = chatWorksModule(gateway);

  const result = await module.visit(
    block("send $self Reason about UX."),
    context({
      id: "architect",
      chat: { title: "ChatWorks: architect" },
    }),
  );

  assert.equal(listed, false);
  assert.deepEqual(operations, [
    "select:ChatWorks: architect",
    "send:Reason about UX.",
  ]);
  assert.equal(result, "Sent message to $self.");
});

test("rejects $self outside participant execution", async () => {
  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {},
  };

  await assert.rejects(
    () =>
      chatWorksModule(gateway).visit(
        block("send $self Reason about UX."),
        context(),
      ),
    /no participant binding/,
  );
});

test("rejects an unknown named participant before sending", async () => {
  let sent = false;

  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {
      sent = true;
    },
  };

  await assert.rejects(
    () =>
      chatWorksModule(gateway).visit(block("send missing Hello."), context()),
    /Could not find participant 'missing'/,
  );

  assert.equal(sent, false);
});
