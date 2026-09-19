import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import type { Message } from "../src/core/message.ts";
import type { SubmissionStatus } from "../src/core/submission.ts";
import {
  newWatchState,
  runWatchIteration,
  type WatchGateway,
} from "../src/core/watch.ts";

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

type Harness = {
  gateway: WatchGateway;
  observed: AssistantObservation[];
  available: boolean;
  composerReads: number;
  composerError?: Error;
  submissionStatus: SubmissionStatus;
  executions: Message[];
  submissions: string[];
  executionResponse: string;
};

function harness(): Harness {
  const result: Harness = {
    observed: [],
    available: true,
    composerReads: 0,
    submissionStatus: "submitted",
    executions: [],
    submissions: [],
    executionResponse: "result",
    gateway: undefined as unknown as WatchGateway,
  };

  result.gateway = {
    async observe() {
      const next = result.observed.shift();
      if (!next) throw new Error("No queued observation.");
      return next;
    },
    async composerAvailable() {
      result.composerReads += 1;
      if (result.composerError) throw result.composerError;
      return result.available;
    },
    async submit(response) {
      result.submissions.push(response);
      return result.submissionStatus;
    },
  };

  return result;
}

function executor(h: Harness) {
  return {
    async execute(message: Message) {
      h.executions.push(message);
      return h.executionResponse;
    },
  };
}

async function observe(
  h: Harness,
  state: ReturnType<typeof newWatchState>,
  text: string,
  latestMessageRole: "user" | "assistant" = "assistant",
): Promise<void> {
  h.observed.push(observation(text, latestMessageRole));
  await runWatchIteration(h.gateway, executor(h), state);
}

test("executes and submits a stable available message once", async () => {
  const h = harness();
  const state = newWatchState();

  await observe(h, state, "message");
  assert.equal(h.executions.length, 0);

  await observe(h, state, "message");
  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);

  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);
});

test("does not consume execution while composer is busy", async () => {
  const h = harness();
  const state = newWatchState();
  h.available = false;

  await observe(h, state, "message");
  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 0);

  h.available = true;
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
});

test("retains pending output while submission is busy", async () => {
  const h = harness();
  const state = newWatchState();
  h.submissionStatus = "busy";

  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.ok(state.pending);

  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.ok(state.pending);

  h.submissionStatus = "submitted";
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.equal(state.pending, undefined);
});

test("one AX regression does not discard pending output", async () => {
  const h = harness();
  const state = newWatchState();
  h.submissionStatus = "busy";

  await observe(h, state, "current");
  await observe(h, state, "current");
  assert.ok(state.pending);

  await observe(h, state, "old");

  assert.ok(state.pending);
  assert.equal(h.executions.length, 1);
});

test("a user turn invalidates pending output and permits an identical later response", async () => {
  const h = harness();
  const state = newWatchState();
  h.submissionStatus = "busy";

  await observe(h, state, "same");
  await observe(h, state, "same");

  assert.equal(h.executions.length, 1);
  assert.ok(state.pending);

  await observe(h, state, "same", "user");

  assert.equal(state.pending, undefined);
  assert.equal(state.observation.armed, true);

  await observe(h, state, "same");
  await observe(h, state, "same");

  assert.equal(h.executions.length, 2);
});

test("different assistant content cannot execute without a user turn", async () => {
  const h = harness();
  const state = newWatchState();

  await observe(h, state, "first");
  await observe(h, state, "first");

  await observe(h, state, "different");
  await observe(h, state, "different");

  assert.equal(h.executions.length, 1);
});

test("records a user turn without consulting transient composer state", async () => {
  const h = harness();
  const state = newWatchState();

  await observe(h, state, "previous");
  await observe(h, state, "previous");
  assert.equal(state.observation.armed, false);

  const readsBeforeUserTurn = h.composerReads;
  h.composerError = new Error("transient composer failure");

  await observe(h, state, "previous", "user");

  assert.equal(h.composerReads, readsBeforeUserTurn);
  assert.equal(state.observation.armed, true);
  assert.equal(state.observation.candidate, undefined);
  assert.equal(state.observation.stable, undefined);
});
