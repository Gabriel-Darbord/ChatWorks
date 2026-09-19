import type { AssistantObservation } from "./assistant-observation.ts";
import type { Message } from "./message.ts";
import type { SubmissionStatus } from "./submission.ts";
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

export type WatchState = {
  observation: WatchObservationState;
  pending?: {
    observation: AssistantObservation;
    response: string;
  };
};

export function newWatchState(): WatchState {
  return {
    observation: {
      armed: true,
    },
  };
}

export async function runWatchIteration(
  gateway: WatchGateway,
  executor: WatchExecutor,
  state: WatchState,
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

  if (observed.kind === "user-turn") {
    // A new user turn makes any unsent result for the preceding assistant
    // response obsolete.
    state.pending = undefined;
    return;
  }

  if (observed.kind === "execute") {
    const response = await executor.execute(observed.observation.message);
    if (response) {
      state.pending = {
        observation: observed.observation,
        response,
      };
    }
  }

  if (!state.pending) return;

  if (
    !pendingStillApplies(state.pending.observation, state.observation.stable)
  ) {
    state.pending = undefined;
    return;
  }

  const status = await gateway.submit(state.pending.response);
  if (status === "submitted") {
    state.pending = undefined;
  }
}
