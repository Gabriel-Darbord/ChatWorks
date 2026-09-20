import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import type { Message } from "../src/core/message.ts";
import type { SubmissionStatus } from "../src/core/submission.ts";
import {
  durableMessageIdentity,
  newWatchState,
  recoverWatchState,
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
  submissionError?: Error;
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
      if (result.submissionError) throw result.submissionError;
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

test("retries a transient submission while the composer remains available", async () => {
  const h = harness();
  const state = newWatchState();
  h.submissionStatus = "busy";

  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);
  assert.ok(state.pending);

  // busy means guarded submission made no composer mutation, so a later
  // available polling iteration may safely retry.
  h.submissionStatus = "submitted";
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result", "result"]);
  assert.equal(state.pending, undefined);
});

test("submission exception does not cause polling-loop retries", async () => {
  const h = harness();
  const state = newWatchState();
  h.submissionError = new Error("AX submission failed");

  // First observation establishes the stability candidate.
  await observe(h, state, "message");

  // Second observation executes and attempts submission.
  await assert.rejects(
    () => observe(h, state, "message"),
    /AX submission failed/,
  );

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);
  assert.ok(state.pending);
  assert.equal(state.pending?.submissionFailed, true);

  // This is what the real outer watch loop does after catching the exception:
  // continue polling. It must not enter submit() again.
  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);
  assert.ok(state.pending);

  // Even a composer lifecycle transition must not retry an exceptional
  // submission automatically. Its side effects are uncertain.
  h.available = false;
  await observe(h, state, "message");

  h.available = true;
  h.submissionError = undefined;
  h.submissionStatus = "submitted";
  await observe(h, state, "message");

  assert.deepEqual(h.submissions, ["result"]);
  assert.ok(state.pending);
  assert.equal(state.pending?.submissionFailed, true);
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

test("persists executing before entering assistant-provided execution", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  const transactions = {
    async write(
      transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {
      events.push(`write:${transaction.phase}`);
    },
    async clear() {
      events.push("clear");
    },
  };

  const recordingExecutor = {
    async execute(message: Message) {
      h.executions.push(message);
      events.push("execute");
      return "result";
    },
  };

  h.observed.push(observation("message"));
  await runWatchIteration(h.gateway, recordingExecutor, state, transactions);

  h.observed.push(observation("message"));
  await runWatchIteration(h.gateway, recordingExecutor, state, transactions);

  assert.deepEqual(events, [
    "write:executing",
    "execute",
    "write:pending",
    "clear",
  ]);
});

test("persists pending response before attempting submission", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  const transactions = {
    async write(
      transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {
      events.push(`write:${transaction.phase}`);
    },
    async clear() {
      events.push("clear");
    },
  };

  const recordingGateway: WatchGateway = {
    ...h.gateway,
    async submit(response) {
      events.push(`submit:${response}`);
      return "submitted";
    },
  };

  h.observed.push(observation("message"));
  await runWatchIteration(recordingGateway, executor(h), state, transactions);

  h.observed.push(observation("message"));
  await runWatchIteration(recordingGateway, executor(h), state, transactions);

  assert.deepEqual(events, [
    "write:executing",
    "write:pending",
    "submit:result",
    "clear",
  ]);
});

test("persists submission failure before propagating it", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  const transactions = {
    async write(
      transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {
      events.push(`write:${transaction.phase}`);
    },
    async clear() {
      events.push("clear");
    },
  };

  const failingGateway: WatchGateway = {
    ...h.gateway,
    async submit() {
      events.push("submit");
      throw new Error("AX submission failed");
    },
  };

  h.observed.push(observation("message"));
  await runWatchIteration(failingGateway, executor(h), state, transactions);

  h.observed.push(observation("message"));

  await assert.rejects(
    runWatchIteration(failingGateway, executor(h), state, transactions),
    /AX submission failed/,
  );

  assert.deepEqual(events, [
    "write:executing",
    "write:pending",
    "submit",
    "write:submission-failed",
  ]);
  assert.equal(state.pending?.submissionFailed, true);
});

test("clears durable execution state when execution produces no response", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  const transactions = {
    async write(
      transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {
      events.push(`write:${transaction.phase}`);
    },
    async clear() {
      events.push("clear");
    },
  };

  h.executionResponse = "";

  h.observed.push(observation("message"));
  await runWatchIteration(h.gateway, executor(h), state, transactions);

  h.observed.push(observation("message"));
  await runWatchIteration(h.gateway, executor(h), state, transactions);

  assert.deepEqual(events, ["write:executing", "clear"]);
  assert.equal(state.pending, undefined);
  assert.deepEqual(h.submissions, []);
});

test("retains durable executing state when assistant-provided execution throws", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  const transactions = {
    async write(
      transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {
      events.push(`write:${transaction.phase}`);
    },
    async clear() {
      events.push("clear");
    },
  };

  const failingExecutor = {
    async execute(message: Message) {
      h.executions.push(message);
      events.push("execute");
      throw new Error("execution failed");
    },
  };

  h.observed.push(observation("message"));
  await runWatchIteration(h.gateway, failingExecutor, state, transactions);

  h.observed.push(observation("message"));

  await assert.rejects(
    runWatchIteration(h.gateway, failingExecutor, state, transactions),
    /execution failed/,
  );

  assert.deepEqual(events, ["write:executing", "execute"]);
  assert.equal(h.executions.length, 1);
  assert.equal(state.pending, undefined);
});

test("durable message identity is fixed-size, stable, and content-sensitive", () => {
  const first = observation("same").message;
  const second = observation("same").message;
  const different = observation("different").message;

  const firstIdentity = durableMessageIdentity(first);

  assert.match(firstIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(firstIdentity.length, 71);
  assert.equal(firstIdentity, durableMessageIdentity(second));
  assert.notEqual(firstIdentity, durableMessageIdentity(different));
});

test("durable message identity stays compact for large messages", () => {
  const message = observation("x".repeat(10_000)).message;

  assert.equal(durableMessageIdentity(message).length, 71);
  assert.ok(
    durableMessageIdentity(message).length <
      JSON.stringify(message.parts).length,
  );
});

test("recovered uncertain execution blocks later assistant execution", async () => {
  const h = harness();
  const state = newWatchState();

  recoverWatchState(state, {
    messageIdentity: "sha256:uncertain",
    phase: "executing",
  });

  await observe(h, state, "new-message");
  await observe(h, state, "new-message");

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, []);
  assert.equal(state.recovery?.phase, "executing");
});

test("watch state has no recovery barrier without a durable transaction", async () => {
  const h = harness();
  const state = newWatchState();

  recoverWatchState(state, undefined);

  await observe(h, state, "message");
  await observe(h, state, "message");

  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.submissions, ["result"]);
});

test("recovered acknowledged message is not executed again", async () => {
  const h = harness();
  const state = newWatchState();
  const message = observation("acknowledged");

  recoverWatchState(state, {
    messageIdentity: durableMessageIdentity(message.message),
    phase: "acknowledged",
  });

  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, []);
  assert.equal(state.recovery?.phase, "acknowledged");
});

test("user turn clears an acknowledged recovery barrier", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  recoverWatchState(state, {
    messageIdentity: "sha256:acknowledged",
    phase: "acknowledged",
  });

  const transactions = {
    async write(
      _transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {},
    async clear() {
      events.push("clear");
    },
  };

  h.observed.push({
    latestMessageRole: "user",
    message: observation("user").message,
  });

  await runWatchIteration(h.gateway, executor(h), state, transactions);

  assert.equal(state.recovery, undefined);
  assert.deepEqual(events, ["clear"]);
});

test("user turn does not clear uncertain executing recovery", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  recoverWatchState(state, {
    messageIdentity: "sha256:uncertain",
    phase: "executing",
  });

  const transactions = {
    async write(
      _transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {},
    async clear() {
      events.push("clear");
    },
  };

  h.observed.push({
    latestMessageRole: "user",
    message: observation("user").message,
  });

  await runWatchIteration(h.gateway, executor(h), state, transactions);

  assert.equal(state.recovery?.phase, "executing");
  assert.deepEqual(events, []);
});

test("recovered pending response resumes without re-executing its message", async () => {
  const h = harness();
  const state = newWatchState();
  const message = observation("recover-pending");

  recoverWatchState(state, {
    messageIdentity: durableMessageIdentity(message.message),
    phase: "pending",
    response: "recovered-result",
  });

  // First capture is not stable yet and must not submit.
  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, []);

  // Once the same observation is stable, restore the durable response and
  // submit it without executing the assistant message again.
  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, ["recovered-result"]);
  assert.equal(state.pending, undefined);
  assert.equal(state.recovery, undefined);
});

test("recovered submission failure remains retained without automatic retry", async () => {
  const h = harness();
  const state = newWatchState();
  const message = observation("recover-failed");

  recoverWatchState(state, {
    messageIdentity: durableMessageIdentity(message.message),
    phase: "submission-failed",
    response: "recovered-result",
  });

  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, []);
  assert.equal(state.recovery, undefined);
  assert.equal(state.pending?.response, "recovered-result");
  assert.equal(state.pending?.submissionFailed, true);

  // Continued polling must neither execute nor retry submission.
  h.observed.push(message);
  await runWatchIteration(h.gateway, executor(h), state);

  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.submissions, []);
});

test("recovered pending response is not applied to a different assistant message", async () => {
  const h = harness();
  const state = newWatchState();

  recoverWatchState(state, {
    messageIdentity: durableMessageIdentity(
      observation("original-message").message,
    ),
    phase: "pending",
    response: "old-result",
  });

  await observe(h, state, "different-message");
  await observe(h, state, "different-message");

  assert.deepEqual(h.submissions, []);
  assert.equal(state.recovery?.phase, "pending");

  // Recovery must not post the old response or execute newer assistant work
  // while the prior durable transaction remains unresolved.
  assert.deepEqual(h.submissions, []);
  assert.equal(h.executions.length, 0);
});

test("user turn clears stale recovered pending response", async () => {
  const h = harness();
  const state = newWatchState();
  const events: string[] = [];

  recoverWatchState(state, {
    messageIdentity: "sha256:old",
    phase: "pending",
    response: "old-result",
  });

  const transactions = {
    async write(
      _transaction: import("../src/core/watch-transaction.ts").WatchTransaction,
    ) {},
    async clear() {
      events.push("clear");
    },
  };

  h.observed.push({
    latestMessageRole: "user",
    message: observation("new-user-turn").message,
  });

  await runWatchIteration(h.gateway, executor(h), state, transactions);

  assert.equal(state.recovery, undefined);
  assert.equal(state.pending, undefined);
  assert.deepEqual(events, ["clear"]);
});
