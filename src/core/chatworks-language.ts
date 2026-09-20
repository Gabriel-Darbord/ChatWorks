import {
  parseParticipantReference,
  type ParticipantReference,
} from "./participants.ts";

export type ChatWorksCommand = {
  kind: "send";
  recipient: ParticipantReference;
  message: string;
};

export function parseChatWorksCommand(source: string): ChatWorksCommand {
  const trimmed = source.trim();

  const match = /^send\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      "Expected a ChatWorks command of the form: send <participant> <message>",
    );
  }

  const [, recipient, message] = match;

  return {
    kind: "send",
    recipient: parseParticipantReference(recipient),
    message,
  };
}
