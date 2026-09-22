import {
  guardedStageAndSend,
  NoAssistantMessageError,
  readAccessibilityAssistantObservation,
  readComposerState,
} from "../adapters/chatgpt-bridge.ts";
import {
  sameAssistantMessage,
  type AssistantObservation,
} from "../core/assistant-observation.ts";
import type { ClassicProviderGateway } from "./opencode-provider.ts";

export type ClassicProviderOperations = {
  observeAssistant(): Promise<AssistantObservation | undefined>;
  composerAvailable(): Promise<boolean>;
  submit(prompt: string): Promise<"submitted" | "busy" | "unavailable">;
  wait(milliseconds: number): Promise<void>;
};

export type ClassicProviderGatewayOptions = {
  pollMilliseconds?: number;
  timeoutMilliseconds?: number;
};

const defaultPollMilliseconds = 250;
const defaultTimeoutMilliseconds = 120_000;

export function classicProviderGateway(
  operations: ClassicProviderOperations = accessibilityOperations(),
  options: ClassicProviderGatewayOptions = {},
): ClassicProviderGateway {
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;

  return {
    async sendAndRead(prompt) {
      const previous = await operations.observeAssistant();
      const submission = await operations.submit(prompt);
      if (submission !== "submitted") {
        throw new Error(`ChatGPT Classic composer is ${submission}.`);
      }

      return waitForNewAssistantMessage(
        previous,
        operations,
        pollMilliseconds,
        timeoutMilliseconds,
      );
    },
  };
}

async function waitForNewAssistantMessage(
  previous: AssistantObservation | undefined,
  operations: ClassicProviderOperations,
  pollMilliseconds: number,
  timeoutMilliseconds: number,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let candidate: AssistantObservation | undefined;

  while (Date.now() < deadline) {
    const observation = await operations.observeAssistant();
    if (
      !observation ||
      observation.latestMessageRole !== "assistant" ||
      (previous && sameAssistantMessage(previous, observation))
    ) {
      candidate = undefined;
      await operations.wait(pollMilliseconds);
      continue;
    }

    if (!(await operations.composerAvailable())) {
      candidate = observation;
      await operations.wait(pollMilliseconds);
      continue;
    }

    if (candidate && sameAssistantMessage(candidate, observation)) {
      return observation.message;
    }

    candidate = observation;
    await operations.wait(pollMilliseconds);
  }

  throw new Error(
    "Timed out waiting for a new stable ChatGPT Classic response.",
  );
}

function accessibilityOperations(): ClassicProviderOperations {
  return {
    async observeAssistant() {
      try {
        return await readAccessibilityAssistantObservation();
      } catch (error) {
        if (error instanceof NoAssistantMessageError) return undefined;
        throw error;
      }
    },
    async composerAvailable() {
      return (await readComposerState()).availability === "available";
    },
    async submit(prompt) {
      return (await guardedStageAndSend(prompt)).status;
    },
    async wait(milliseconds) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}
