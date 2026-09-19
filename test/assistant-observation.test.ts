import assert from "node:assert/strict";
import test from "node:test";
import {
  sameAssistantMessage,
  type AssistantObservation,
} from "../src/core/assistant-observation.ts";

function observation(
  text: string,
  latestMessageRole: "user" | "assistant" = "assistant",
): AssistantObservation {
  return {
    latestMessageRole,
    message: {
      parts: [{ kind: "plain-text", text }],
    },
  };
}

test("compares assistant observations by semantic message content", () => {
  assert.equal(
    sameAssistantMessage(observation("same"), observation("same")),
    true,
  );
  assert.equal(
    sameAssistantMessage(observation("first"), observation("second")),
    false,
  );
});

test("message role does not change assistant semantic equality", () => {
  assert.equal(
    sameAssistantMessage(
      observation("same", "assistant"),
      observation("same", "user"),
    ),
    true,
  );
});
