import { createHash } from "node:crypto";
import type { AssistantObservation } from "./assistant-observation.ts";
import type { Message } from "./message.ts";
import type { SubmissionStatus } from "./submission.ts";
import { messageIdentity } from "./message.ts";
import type { WatchTransaction } from "./watch-transaction.ts";
import {
  observeAssistant,
  type WatchObservationState,
} from "./watch-observation.ts";
import { pendingStillApplies } from "./watch-pending.ts";

export type WatchGateway = {
  observe(): Promise<AssistantObservation>;
  composerAvailable(): Promise<boolean>;
  submit(response: string): Promise<SubmissionStatus>;
};

export type WatchExecutor = {
  execute(message: Message): Promise<string>;
};

export type WatchTransactionGateway = {
  write(transaction: WatchTransaction): Promise<void>;
  clear(): Promise<void>;
};

export function durableMessageIdentity(message: Message): string {
  return `sha256:${createHash("sha256")
    .update(messageIdentity(message))
    .digest("hex")}`;
}

export type WatchState = {
  observation: WatchObservationState;
  recovery?: WatchTransaction;
  pending?: {
    observation: AssistantObservation;
    response: string;
    submissionFailed: boolean;
  };
};

export function newWatchState(): WatchState {
  return {
    observation: {
      armed: true,
    },
  };
}

export function recoverWatchState(
  state: WatchState,
  transaction: WatchTransaction | undefined,
): void {
  state.recovery = transaction;
}

export async function runWatchIteration(
  gateway: WatchGateway,
  executor: WatchExecutor,
  state: WatchState,
  transactions?: WatchTransactionGateway,
): Promise<void> {
  const current = await gateway.observe();

  // A user-message boundary is structural and must be recorded even while the
  // composer is transitioning. Composer readiness matters only when deciding
  // whether a stable assistant response may execute.
  const readyForExecution =
    current.latestMessageRole === "user"
      ? false
      : await gateway.composerAvailable();

  const observed = observeAssistant(
    state.observation,
    current,
    readyForExecution,
  );

  let recoveredPendingThisIteration = false;

  if (
    state.recovery &&
    (state.recovery.phase === "pending" ||
      state.recovery.phase === "submission-failed") &&
    state.observation.stable
  ) {
    const recovered = state.recovery;
    const stable = state.observation.stable;

    if (durableMessageIdentity(stable.message) === recovered.messageIdentity) {
      state.pending = {
        observation: stable,
        response: recovered.response,
        submissionFailed: recovered.phase === "submission-failed",
      };
      state.recovery = undefined;
      recoveredPendingThisIteration = true;
    }
  }

  if (observed.kind === "user-turn") {
    // A new user turn makes any unsent result for the preceding assistant
    // response obsolete. It also establishes a structural boundary beyond an
    // explicitly acknowledged uncertain execution.
    state.pending = undefined;

    if (state.recovery?.phase !== "executing") {
      state.recovery = undefined;
      await transactions?.clear();
    }

    return;
  }

  if (observed.kind === "execute") {
    if (recoveredPendingThisIteration) {
      // The originating assistant message already executed before the
      // previous process persisted this response. Continue below with the
      // reconstructed pending submission.
    } else if (state.recovery) {
      // Never execute new assistant work while a durable transaction remains
      // unresolved. This preserves ordering across crashes and restarts.
      return;
    } else {
      const identity = durableMessageIdentity(observed.observation.message);

      await transactions?.write({
        messageIdentity: identity,
        phase: "executing",
      });

      const response = await executor.execute(observed.observation.message);

      if (response) {
        state.pending = {
          observation: observed.observation,
          response,
          submissionFailed: false,
        };

        await transactions?.write({
          messageIdentity: identity,
          phase: "pending",
          response,
        });
      } else {
        await transactions?.clear();
      }
    }
  }

  if (!state.pending) return;

  if (
    !pendingStillApplies(state.pending.observation, state.observation.stable)
  ) {
    state.pending = undefined;
    await transactions?.clear();
    return;
  }

  if (state.pending.submissionFailed) {
    return;
  }

  const pending = state.pending;

  try {
    const status = await gateway.submit(pending.response);
    if (status === "submitted" && state.pending === pending) {
      state.pending = undefined;
      await transactions?.clear();
    }
  } catch (error) {
    // Submission exceptions may occur after the AX layer has already modified
    // the composer. Retain the result, but never repeat that potentially
    // destructive operation automatically.
    pending.submissionFailed = true;

    await transactions?.write({
      messageIdentity: durableMessageIdentity(pending.observation.message),
      phase: "submission-failed",
      response: pending.response,
    });

    throw error;
  }
}
