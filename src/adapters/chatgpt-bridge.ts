import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  messageFromAccessibilityParts,
  type AccessibilityMessagePart,
  type Message,
} from "../core/message.ts";

const bridgePath = fileURLToPath(
  new URL("../../.build/debug/chatworks-ax", import.meta.url),
);

export class NoAssistantMessageError extends Error {
  constructor() {
    super("No assistant message is available to copy.");
    this.name = "NoAssistantMessageError";
  }
}

/**
 * Swift's JSONEncoder does not guarantee object-key order between bridge
 * processes. Discussions compare assistant states across separate invocations,
 * so turn the structured state into a deterministic JSON representation first.
 */
export function normalizeAssistantState(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.responseHeadingCount !== "number") return raw;
    return JSON.stringify({
      responseHeadingCount: value.responseHeadingCount,
      scrollToBottomVisible: value.scrollToBottomVisible === true,
    });
  } catch {
    return raw;
  }
}

export function decodeAccessibilityMessageParts(
  value: unknown,
): AccessibilityMessagePart[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "Accessibility message-parts bridge response is not an array.",
    );
  }

  return value.map((candidate, index): AccessibilityMessagePart => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error(`Accessibility message part ${index} is not an object.`);
    }

    const part = candidate as Record<string, unknown>;

    if (part.kind === "text") {
      if (typeof part.text !== "string") {
        throw new Error(`Accessibility text part ${index} is missing text.`);
      }
      return { kind: "text", text: part.text };
    }

    if (part.kind === "code") {
      if (typeof part.source !== "string") {
        throw new Error(`Accessibility code part ${index} is missing source.`);
      }
      if (
        part.language !== null &&
        part.language !== undefined &&
        typeof part.language !== "string"
      ) {
        throw new Error(
          `Accessibility code part ${index} has an invalid language.`,
        );
      }
      return {
        kind: "code",
        ...(typeof part.language === "string" && part.language.length > 0
          ? { language: part.language }
          : {}),
        source: part.source,
      };
    }

    throw new Error(
      `Accessibility message part ${index} has an unsupported kind.`,
    );
  });
}

export type AccessibilityAssistantObservation = {
  latestMessageRole?: "user" | "assistant";
  message: Message;
};

export function decodeAccessibilityAssistantObservation(
  value: unknown,
): AccessibilityAssistantObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Accessibility assistant observation is not an object.");
  }

  const observation = value as Record<string, unknown>;
  const latestMessageRole = observation.latestMessageRole;

  if (
    latestMessageRole !== undefined &&
    latestMessageRole !== null &&
    latestMessageRole !== "user" &&
    latestMessageRole !== "assistant"
  ) {
    throw new Error(
      "Accessibility assistant observation has an invalid latest message role.",
    );
  }

  return {
    ...(latestMessageRole === "user" || latestMessageRole === "assistant"
      ? { latestMessageRole }
      : {}),
    message: messageFromAccessibilityParts(
      decodeAccessibilityMessageParts(observation.parts),
    ),
  };
}

export async function readAccessibilityAssistantObservation(): Promise<AccessibilityAssistantObservation> {
  const raw = await callBridge(["assistant-observation"]);
  return decodeAccessibilityAssistantObservation(JSON.parse(raw) as unknown);
}

export async function readAccessibilityMessage(): Promise<Message> {
  const raw = await callBridge(["message-parts"]);
  return messageFromAccessibilityParts(
    decodeAccessibilityMessageParts(JSON.parse(raw) as unknown),
  );
}

export type ComposerAvailability = "available" | "busy" | "unavailable";

export type ComposerState = {
  availability: ComposerAvailability;
};

export function decodeComposerState(value: unknown): ComposerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Composer state is not an object.");
  }

  const availability = (value as Record<string, unknown>).availability;
  if (
    availability !== "available" &&
    availability !== "busy" &&
    availability !== "unavailable"
  ) {
    throw new Error("Composer state has an invalid availability.");
  }

  return { availability };
}

export async function readComposerState(): Promise<ComposerState> {
  const raw = await callBridge(["composer-state"]);
  return decodeComposerState(JSON.parse(raw) as unknown);
}

export type GuardedSubmissionResult = {
  status: "submitted" | "busy" | "unavailable";
};

export function decodeGuardedSubmissionResult(
  value: unknown,
): GuardedSubmissionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Guarded submission response is not an object.");
  }

  const status = (value as Record<string, unknown>).status;
  if (status !== "submitted" && status !== "busy" && status !== "unavailable") {
    throw new Error("Guarded submission response has an invalid status.");
  }

  return { status };
}

export async function guardedStageAndSend(
  text: string,
): Promise<GuardedSubmissionResult> {
  const raw = await callBridge(["guarded-stage-and-send"], text);
  return decodeGuardedSubmissionResult(JSON.parse(raw) as unknown);
}

export function callBridge(
  arguments_: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CHATWORKS_AX_BRIDGE ?? bridgePath,
      arguments_,
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (code === 2) reject(new NoAssistantMessageError());
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `AX bridge exited ${code}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}
