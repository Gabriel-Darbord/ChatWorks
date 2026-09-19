import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import { pendingStillApplies } from "../src/core/watch-pending.ts";

function observation(text: string): AssistantObservation {
  return {
    message: {
      parts: [{ kind: "plain-text", text }],
    },
  };
}

test("keeps pending output before any contradictory message is stable", () => {
  assert.equal(pendingStillApplies(observation("current"), undefined), true);
});

test("keeps pending output for the same stable semantic message", () => {
  assert.equal(
    pendingStillApplies(observation("current"), observation("current")),
    true,
  );
});

test("drops pending output after a different semantic message becomes stable", () => {
  assert.equal(
    pendingStillApplies(observation("current"), observation("later")),
    false,
  );
});
