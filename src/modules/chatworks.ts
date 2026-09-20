import type { ExecutionScope } from "../core/execution-scope.ts";
import {
  resolveParticipant,
  resolveParticipantReference,
  type Participant,
  type ParticipantReference,
  type ParticipantResolutionGateway,
} from "../core/participants.ts";
import {
  parseChatWorksCommand,
  type ChatWorksCommand,
} from "../core/chatworks-language.ts";
import type { Block, MessagePart } from "../core/message.ts";
import type { MessageModule } from "../core/modules.ts";

export type ChatWorksGateway = ParticipantResolutionGateway & {
  selectChat(reference: string): Promise<void>;
  send(message: string): Promise<void>;
};

async function resolveRecipient(
  reference: ParticipantReference,
  scope: ExecutionScope,
  gateway: ChatWorksGateway,
): Promise<Participant> {
  if (reference.kind === "metavariable") {
    return resolveParticipantReference(reference, scope, []);
  }

  return resolveParticipant(reference.id, gateway);
}

async function executeCommand(
  command: ChatWorksCommand,
  scope: ExecutionScope,
  gateway: ChatWorksGateway,
): Promise<void> {
  switch (command.kind) {
    case "send": {
      const recipient = await resolveRecipient(
        command.recipient,
        scope,
        gateway,
      );

      await gateway.selectChat(recipient.chat.title);
      await gateway.send(command.message);
      return;
    }
  }
}

export function chatWorksModule(gateway: ChatWorksGateway): MessageModule {
  const handlesChatWorks = (part: MessagePart): part is Block =>
    part.kind === "block" && part.language === "chatworks";

  return {
    name: "chatworks",

    handles: handlesChatWorks,

    async visit(part, context) {
      if (!handlesChatWorks(part)) return undefined;

      const command = parseChatWorksCommand(part.source);

      context.onBlockStart(part);
      try {
        await executeCommand(command, context.scope, gateway);
      } finally {
        context.onBlockFinish(part);
      }

      return `Sent message to ${
        command.recipient.kind === "metavariable"
          ? `$${command.recipient.name}`
          : command.recipient.id
      }.`;
    },
  };
}
