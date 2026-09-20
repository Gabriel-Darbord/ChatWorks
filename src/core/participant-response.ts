import {
  sameAssistantMessage,
  type AssistantObservation,
} from "./assistant-observation.ts";

export type ParticipantResponseGateway = {
  observeAssistant(): Promise<AssistantObservation>;
  composerAvailable(): Promise<boolean>;
};

export type ParticipantResponseOptions = {
  pollMilliseconds?: number;
  timeoutMilliseconds?: number;
};

const defaultPollMilliseconds = 250;
const defaultTimeoutMilliseconds = 120_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForParticipantInitialResponse(
  gateway: ParticipantResponseGateway,
  options: ParticipantResponseOptions = {},
): Promise<void> {
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const deadline =
    Date.now() + (options.timeoutMilliseconds ?? defaultTimeoutMilliseconds);

  let candidate: AssistantObservation | undefined;

  while (Date.now() < deadline) {
    const observation = await gateway.observeAssistant();

    if (observation.latestMessageRole !== "assistant") {
      candidate = undefined;
      await wait(pollMilliseconds);
      continue;
    }

    const available = await gateway.composerAvailable();

    if (!available) {
      candidate = observation;
      await wait(pollMilliseconds);
      continue;
    }

    if (candidate && sameAssistantMessage(candidate, observation)) {
      return;
    }

    candidate = observation;
    await wait(pollMilliseconds);
  }

  throw new Error(
    "Timed out waiting for the participant's initial assistant response.",
  );
}
