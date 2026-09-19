import { messageIdentity, type Message } from "./message.ts";

export type MessageRole = "user" | "assistant";

export type AssistantObservation = {
  latestMessageRole?: MessageRole;
  message: Message;
};

export function sameAssistantMessage(
  left: AssistantObservation,
  right: AssistantObservation,
): boolean {
  return messageIdentity(left.message) === messageIdentity(right.message);
}
