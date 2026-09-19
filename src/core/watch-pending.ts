import {
  sameAssistantMessage,
  type AssistantObservation,
} from "./assistant-observation.ts";

export function pendingStillApplies(
  pending: AssistantObservation,
  stable: AssistantObservation | undefined,
): boolean {
  return stable === undefined || sameAssistantMessage(pending, stable);
}
