import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import { runOnce } from "../src/core/once.ts";

function observation(
  latestMessageRole: "user" | "assistant",
): AssistantObservation {
  return {
    latestMessageRole,
    message: {
      parts: [{ kind: "plain-text", text: "response" }],
    },
  };
}

test("does not execute a stale assistant payload while the latest message is user", async () => {
  let executions = 0;
  let submissions = 0;

  const result = await runOnce(
    observation("user"),
    {
      async execute() {
        executions += 1;
        return "result";
      },
    },
    {
      async submit() {
        submissions += 1;
        return "submitted";
      },
    },
  );

  assert.deepEqual(result, { kind: "not-assistant" });
  assert.equal(executions, 0);
  assert.equal(submissions, 0);
});

test("executes and submits when the latest message is assistant", async () => {
  let executions = 0;

  const result = await runOnce(
    observation("assistant"),
    {
      async execute() {
        executions += 1;
        return "result";
      },
    },
    {
      async submit(response) {
        assert.equal(response, "result");
        return "submitted";
      },
    },
  );

  assert.deepEqual(result, { kind: "submitted" });
  assert.equal(executions, 1);
});

test("does not submit when execution produces no output", async () => {
  let submissions = 0;

  const result = await runOnce(
    observation("assistant"),
    {
      async execute() {
        return "";
      },
    },
    {
      async submit() {
        submissions += 1;
        return "submitted";
      },
    },
  );

  assert.deepEqual(result, { kind: "no-output" });
  assert.equal(submissions, 0);
});

test("reports transient submission status", async () => {
  const result = await runOnce(
    observation("assistant"),
    {
      async execute() {
        return "result";
      },
    },
    {
      async submit() {
        return "busy";
      },
    },
  );

  assert.deepEqual(result, {
    kind: "not-submitted",
    status: "busy",
  });
});
