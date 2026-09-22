import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeArguments,
  decodeAccessibilityAssistantObservation,
  decodeComposerState,
  decodeGuardedSubmissionResult,
  selectChatGPTApplication,
  selectInteractionPolicy,
  decodeAccessibilityMessageParts,
  normalizeAssistantState,
} from "../src/adapters/chatgpt-bridge.ts";

test("adds an explicit bundle target when an application is selected", () => {
  selectInteractionPolicy("background");
  selectChatGPTApplication("classic");
  assert.deepEqual(bridgeArguments(["composer-state"]), [
    "--bundle-id",
    "com.openai.chat",
    "--interaction",
    "background",
    "composer-state",
  ]);

  selectInteractionPolicy("pointer");
  selectChatGPTApplication("desktop");
  assert.deepEqual(bridgeArguments(["composer-state"]), [
    "--bundle-id",
    "com.openai.codex",
    "--interaction",
    "pointer",
    "composer-state",
  ]);

  selectChatGPTApplication(undefined);
  selectInteractionPolicy("background");
});

test("normalizes assistant-state from structural readiness fields only", () => {
  const first = normalizeAssistantState(
    '{"responseHeadingCount":4,"scrollToBottomVisible":false,"copyControlCount":1,"latestCopyControlY":866}',
  );
  const second = normalizeAssistantState(
    '{"latestCopyControlY":null,"copyControlCount":0,"scrollToBottomVisible":false,"responseHeadingCount":4}',
  );

  assert.equal(first, second);
  assert.equal(
    first,
    '{"responseHeadingCount":4,"scrollToBottomVisible":false}',
  );
});

test("validates accessibility message-parts wire data", () => {
  assert.deepEqual(
    decodeAccessibilityMessageParts([
      { kind: "text", text: "before", language: null, source: null },
      { kind: "code", text: null, language: "Bash", source: "pwd" },
    ]),
    [
      { kind: "text", text: "before" },
      { kind: "code", language: "Bash", source: "pwd" },
    ],
  );

  assert.throws(
    () => decodeAccessibilityMessageParts({ kind: "text", text: "no array" }),
    /not an array/,
  );
  assert.throws(
    () => decodeAccessibilityMessageParts([{ kind: "text" }]),
    /missing text/,
  );
  assert.throws(
    () => decodeAccessibilityMessageParts([{ kind: "code", language: "bash" }]),
    /missing source/,
  );
  assert.deepEqual(
    decodeAccessibilityMessageParts([
      { kind: "code", language: null, source: "pwd" },
    ]),
    [{ kind: "code", source: "pwd" }],
  );
  assert.throws(
    () =>
      decodeAccessibilityMessageParts([
        { kind: "code", language: 42, source: "pwd" },
      ]),
    /invalid language/,
  );
  assert.throws(
    () => decodeAccessibilityMessageParts([{ kind: "other" }]),
    /unsupported kind/,
  );
});

test("decodes an atomic accessibility assistant observation", () => {
  const observation = decodeAccessibilityAssistantObservation({
    latestMessageRole: "assistant",
    parts: [{ kind: "code", language: "bash", source: "pwd" }],
  });

  assert.deepEqual(observation, {
    latestMessageRole: "assistant",
    message: {
      parts: [{ kind: "block", language: "bash", source: "pwd" }],
    },
  });

  assert.throws(
    () =>
      decodeAccessibilityAssistantObservation({
        parts: "not parts",
      }),
    /not an array/,
  );

  assert.throws(
    () =>
      decodeAccessibilityAssistantObservation({
        latestMessageRole: "other",
        parts: [],
      }),
    /invalid latest message role/,
  );
});

test("decodes composer state", () => {
  assert.deepEqual(decodeComposerState({ availability: "available" }), {
    availability: "available",
  });
  assert.deepEqual(decodeComposerState({ availability: "busy" }), {
    availability: "busy",
  });
  assert.deepEqual(decodeComposerState({ availability: "unavailable" }), {
    availability: "unavailable",
  });
  assert.throws(
    () => decodeComposerState({ availability: "ready" }),
    /invalid availability/,
  );
  assert.throws(() => decodeComposerState(null), /not an object/);
});

test("decodes guarded submission results", () => {
  assert.deepEqual(decodeGuardedSubmissionResult({ status: "submitted" }), {
    status: "submitted",
  });
  assert.deepEqual(decodeGuardedSubmissionResult({ status: "busy" }), {
    status: "busy",
  });
  assert.deepEqual(decodeGuardedSubmissionResult({ status: "unavailable" }), {
    status: "unavailable",
  });
  assert.throws(
    () => decodeGuardedSubmissionResult({ status: "ready" }),
    /invalid status/,
  );
});
