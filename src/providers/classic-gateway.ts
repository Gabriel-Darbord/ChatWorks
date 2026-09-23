import {
  guardedStageAndSend,
  NoAssistantMessageError,
  readAccessibilityAssistantObservation,
  readComposerState,
  scrollToBottom,
  shouldScrollToBottom,
} from "../adapters/chatgpt-bridge.ts";
import {
  sameAssistantMessage,
  type AssistantObservation,
} from "../core/assistant-observation.ts";
import { logDebug } from "../core/diagnostics.ts";
import { messageText } from "../core/message.ts";
import type { ClassicProviderGateway } from "./provider.ts";

export type ClassicProviderOperations = {
  observeAssistant(): Promise<AssistantObservation | undefined>;
  composerAvailable(): Promise<boolean>;
  maintainBottom(): Promise<boolean>;
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
    async sendAndRead(prompt, correlationId) {
      const previous = await operations.observeAssistant();
      await logDebug("classic", "pre-submit-observation", {
        correlationId,
        fields: {
          role: previous?.latestMessageRole ?? null,
          message: previous ? messageText(previous.message) : null,
        },
      });
      const submission = await operations.submit(prompt);
      await logDebug("classic", "submission", {
        correlationId,
        fields: { status: submission },
      });
      if (submission !== "submitted") {
        throw new Error(`ChatGPT Classic composer is ${submission}.`);
      }

      return waitForNewAssistantMessage(
        previous,
        operations,
        pollMilliseconds,
        timeoutMilliseconds,
        correlationId,
      );
    },
  };
}

async function waitForNewAssistantMessage(
  previous: AssistantObservation | undefined,
  operations: ClassicProviderOperations,
  pollMilliseconds: number,
  timeoutMilliseconds: number,
  correlationId?: string,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let candidate: AssistantObservation | undefined;
  let poll = 0;

  while (Date.now() < deadline) {
    poll += 1;
    const scrolled = await operations.maintainBottom();
    if (scrolled) {
      await logDebug("classic", "scrolled-to-bottom", {
        correlationId,
        fields: { poll },
      });
    }
    const observation = await operations.observeAssistant();
    await logDebug("classic", "observation", {
      correlationId,
      fields: {
        poll,
        role: observation?.latestMessageRole ?? null,
        message: observation ? messageText(observation.message) : null,
        sameAsPrevious: Boolean(
          observation &&
          previous &&
          sameAssistantMessage(previous, observation),
        ),
      },
    });
    if (
      !observation ||
      observation.latestMessageRole !== "assistant" ||
      (previous && sameAssistantMessage(previous, observation))
    ) {
      candidate = undefined;
      await operations.wait(pollMilliseconds);
      continue;
    }

    const composerAvailable = await operations.composerAvailable();
    await logDebug("classic", "composer-state", {
      correlationId,
      fields: { poll, available: composerAvailable },
    });
    if (!composerAvailable) {
      candidate = undefined;
      await operations.wait(pollMilliseconds);
      continue;
    }

    if (candidate && sameAssistantMessage(candidate, observation)) {
      await logDebug("classic", "accepted", {
        correlationId,
        fields: { poll, message: messageText(observation.message) },
      });
      return observation.message;
    }

    candidate = observation;
    await operations.wait(pollMilliseconds);
  }

  await logDebug("classic", "timeout", {
    correlationId,
    fields: {
      polls: poll,
      candidate: candidate ? messageText(candidate.message) : null,
    },
  });
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
    async maintainBottom() {
      if (!(await shouldScrollToBottom())) return false;
      await scrollToBottom();
      return true;
    },
    async submit(prompt) {
      return (await guardedStageAndSend(prompt)).status;
    },
    async wait(milliseconds) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}
