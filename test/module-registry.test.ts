import assert from "node:assert/strict";
import test from "node:test";
import {
  activateModules,
  messageModules,
} from "../src/core/module-registry.ts";

test("activates only requested modules and exposes their message handlers", () => {
  const handler = {
    name: "handler",
    handles: () => false,
    async visit() {
      return undefined;
    },
  };
  const active = activateModules(
    [{ id: "shell", messageModule: handler }, { id: "discussion" }],
    ["shell"],
  );
  assert.deepEqual(
    active.map((module) => module.id),
    ["shell"],
  );
  assert.deepEqual(messageModules(active), [handler]);
});
