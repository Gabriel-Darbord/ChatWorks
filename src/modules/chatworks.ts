import type { ExecutionScope } from "../core/execution-scope.ts";
import {
  resolveParticipant,
  resolveParticipantReference,
  type Participant,
  type ParticipantReference,
  type ParticipantResolutionGateway,
} from "../core/participants.ts";
import {
  parseChatWorksCommands,
  type ChatWorksCommand,
} from "../core/chatworks-language.ts";
import type { Block, MessagePart } from "../core/message.ts";
import type { MessageModule } from "../core/modules.ts";
import { formatTodos, TodoStore } from "../core/todos.ts";

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
  todos: TodoStore,
): Promise<string> {
  switch (command.kind) {
    case "abort":
      return "Aborted.";

    case "reason":
      return "Continue reasoning about the current task.";

    case "send": {
      const recipient = await resolveRecipient(
        command.recipient,
        scope,
        gateway,
      );

      await gateway.selectChat(recipient.chat.title);
      await gateway.send(command.message);

      return `Sent message to ${
        command.recipient.kind === "metavariable"
          ? `$${command.recipient.name}`
          : command.recipient.id
      }.`;
    }

    case "todo-list":
      break;

    case "todo-add":
      await todos.add(command.title);
      break;

    case "todo-edit":
      await todos.edit(command.id, command.title);
      break;

    case "todo-done":
      await todos.done(command.id);
      break;

    case "todo-reopen":
      await todos.reopen(command.id);
      break;

    case "todo-delete":
      await todos.delete(command.id);
      break;
  }

  return formatTodos(await todos.list());
}

export function chatWorksModule(
  gateway: ChatWorksGateway,
  todos = new TodoStore(),
): MessageModule {
  const handlesChatWorks = (part: MessagePart): part is Block =>
    part.kind === "block" && part.language === "chatworks";

  return {
    name: "chatworks",

    handles: handlesChatWorks,

    async visit(part, context) {
      if (!handlesChatWorks(part)) return undefined;

      context.onBlockStart(part);
      try {
        let commands: ChatWorksCommand[];
        try {
          commands = parseChatWorksCommands(part.source);
        } catch (error) {
          return `\`\`\`text\nChatWorks command failed: ${
            error instanceof Error ? error.message : String(error)
          }\n\`\`\``;
        }

        const responses: string[] = [];
        for (const command of commands) {
          try {
            responses.push(
              await executeCommand(command, context.scope, gateway, todos),
            );
          } catch (error) {
            responses.push(
              `ChatWorks command failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        const response = responses.join("\n\n");
        return response ? `\`\`\`text\n${response}\n\`\`\`` : undefined;
      } finally {
        context.onBlockFinish(part);
      }
    },
  };
}
