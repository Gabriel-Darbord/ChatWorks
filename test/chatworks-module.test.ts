import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMessage, type Block } from "../src/core/message.ts";
import { TodoStore } from "../src/core/todos.ts";
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
  assert.equal(result, "```text\nSent message to reviewer.\n```");
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
  assert.equal(result, "```text\nSent message to $self.\n```");
});

test("rejects $self outside participant execution", async () => {
  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {},
  };

  const result = await chatWorksModule(gateway).visit(
    block("send $self Reason about UX."),
    context(),
  );

  assert.match(
    result ?? "",
    /ChatWorks command failed: .*no participant binding/,
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

  const result = await chatWorksModule(gateway).visit(
    block("send missing Hello."),
    context(),
  );

  assert.match(
    result ?? "",
    /ChatWorks command failed: Could not find participant 'missing'/,
  );
  assert.equal(sent, false);
});

test("executes multiple commands in one block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-todos-"));
  const todos = new TodoStore(directory);
  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {},
  };

  const result = await chatWorksModule(gateway, todos).visit(
    block("todo add First\ntodo add Second"),
    context(),
  );

  assert.match(result ?? "", /1\. \[ \] First/);
  assert.match(result ?? "", /2\. \[ \] Second/);
});

test("reports one command failure and continues later commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-todos-"));
  const todos = new TodoStore(directory);
  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {},
  };

  const result = await chatWorksModule(gateway, todos).visit(
    block("todo done 99\ntodo add Survived"),
    context(),
  );

  assert.match(
    result ?? "",
    /ChatWorks command failed: Could not find TODO '99'\./,
  );
  assert.match(result ?? "", /1\. \[ \] Survived/);
});

test("reason requests another reasoning turn", async () => {
  const gateway: ChatWorksGateway = {
    async listChats() {
      return [];
    },
    async selectChat() {},
    async send() {},
  };

  const result = await chatWorksModule(gateway).visit(
    block("reason"),
    context(),
  );

  assert.equal(
    result,
    "```text\nContinue reasoning about the current task.\n```",
  );
});
