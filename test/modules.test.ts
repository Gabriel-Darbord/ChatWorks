import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "../src/core/message.ts";
import { visitMessage, type MessageModule } from "../src/core/modules.ts";

test("configured modules visit matching parts in message order", async () => {
  const visited: string[] = [];
  const module: MessageModule = {
    name: "recorder",
    handles: () => true,
    async visit(part) {
      visited.push(part.kind);
      return part.kind;
    },
  };
  const message = parseMessage("before\n```mcp\n{}\n```\nafter");
  const responses = await visitMessage(message, [module], {
    scope: {},
    onBlockStart: () => undefined,
    onBlockFinish: () => undefined,
    onOutput: () => undefined,
  });

  assert.equal(message.raw, "before\n```mcp\n{}\n```\nafter");
  assert.deepEqual(visited, ["plain-text", "block", "plain-text"]);
  assert.deepEqual(responses, ["plain-text", "block", "plain-text"]);
});
