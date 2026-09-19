import {
  sameAssistantMessage,
  type AssistantObservation,
} from "./assistant-observation.ts";

export type WatchObservationState = {
  candidate?: AssistantObservation;
  stable?: AssistantObservation;
  armed: boolean;
};

export type WatchObservationResult =
  | { kind: "waiting" }
  | { kind: "user-turn" }
  | { kind: "stable"; observation: AssistantObservation }
  | { kind: "execute"; observation: AssistantObservation };

export function observeAssistant(
  state: WatchObservationState,
  current: AssistantObservation,
  readyForExecution: boolean,
): WatchObservationResult {
  if (current.latestMessageRole === "user") {
    // A user-message boundary starts a new executable turn. The message
    // carried by this observation is still the previous assistant payload,
    // so it must not participate in assistant stability.
    state.armed = true;
    state.candidate = undefined;
    state.stable = undefined;
    return { kind: "user-turn" };
  }

  if (!state.candidate || !sameAssistantMessage(state.candidate, current)) {
    state.candidate = current;
    return { kind: "waiting" };
  }

  // The same semantic assistant message has now been observed twice
  // consecutively.
  state.candidate = current;
  state.stable = current;

  if (!state.armed || !readyForExecution) {
    return { kind: "stable", observation: current };
  }

  // Consume this turn before execution. Failures and AX regressions must not
  // make another assistant observation executable until a user turn is seen.
  state.armed = false;
  return { kind: "execute", observation: current };
}
