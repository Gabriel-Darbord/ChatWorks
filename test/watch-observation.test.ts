import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import {
  observeAssistant,
  type WatchObservationState,
} from "../src/core/watch-observation.ts";

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

function state(): WatchObservationState {
  return { armed: true };
}

test("requires two consecutive equal semantic observations", () => {
  const watch = state();

  assert.equal(
    observeAssistant(watch, observation("reply"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("reply"), true).kind,
    "execute",
  );
});

test("waits while semantic content evolves", () => {
  const watch = state();

  assert.equal(
    observeAssistant(watch, observation("partial"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("more complete"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("complete"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("complete"), true).kind,
    "execute",
  );
});

test("stable content does not consume the turn while composer is busy", () => {
  const watch = state();

  observeAssistant(watch, observation("reply"), false);
  assert.equal(
    observeAssistant(watch, observation("reply"), false).kind,
    "stable",
  );
  assert.equal(watch.armed, true);

  assert.equal(
    observeAssistant(watch, observation("reply"), true).kind,
    "execute",
  );
  assert.equal(watch.armed, false);
});

test("no assistant observation executes again while the turn is disarmed", () => {
  const watch = state();

  observeAssistant(watch, observation("first"), true);
  assert.equal(
    observeAssistant(watch, observation("first"), true).kind,
    "execute",
  );

  assert.equal(
    observeAssistant(watch, observation("first"), true).kind,
    "stable",
  );

  assert.equal(
    observeAssistant(watch, observation("different"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("different"), true).kind,
    "stable",
  );
});

test("a user-message boundary rearms and resets assistant stability", () => {
  const watch = state();

  observeAssistant(watch, observation("same"), true);
  assert.equal(
    observeAssistant(watch, observation("same"), true).kind,
    "execute",
  );

  assert.equal(
    observeAssistant(watch, observation("same", "user"), true).kind,
    "user-turn",
  );
  assert.equal(watch.armed, true);
  assert.equal(watch.candidate, undefined);
  assert.equal(watch.stable, undefined);

  assert.equal(
    observeAssistant(watch, observation("same"), true).kind,
    "waiting",
  );
  assert.equal(
    observeAssistant(watch, observation("same"), true).kind,
    "execute",
  );
});

test("one contradictory AX capture does not replace the stable observation", () => {
  const watch = state();

  observeAssistant(watch, observation("current"), false);
  assert.equal(
    observeAssistant(watch, observation("current"), false).kind,
    "stable",
  );

  assert.equal(
    observeAssistant(watch, observation("old"), false).kind,
    "waiting",
  );

  assert.deepEqual(watch.stable?.message.parts, [
    { kind: "plain-text", text: "current" },
  ]);
});
