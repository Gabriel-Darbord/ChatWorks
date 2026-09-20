import {
  parseParticipantReference,
  type ParticipantReference,
} from "./participants.ts";

export type ChatWorksCommand =
  | { kind: "abort" }
  | { kind: "reason" }
  | {
      kind: "send";
      recipient: ParticipantReference;
      message: string;
    }
  | { kind: "todo-list" }
  | { kind: "todo-add"; title: string }
  | { kind: "todo-edit"; id: number; title: string }
  | { kind: "todo-done"; id: number }
  | { kind: "todo-reopen"; id: number }
  | { kind: "todo-delete"; id: number };

function todoId(source: string): number {
  const id = Number(source);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid TODO id '${source}'.`);
  }
  return id;
}

export function parseChatWorksCommands(source: string): ChatWorksCommand[] {
  const lines = source.split(/\r?\n/);
  const commands: ChatWorksCommand[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) continue;

    if (/^send(?:\s|$)/.test(line)) {
      const sendSource = [line, ...lines.slice(index + 1)].join("\n");
      commands.push(parseChatWorksCommand(sendSource));
      return commands;
    }

    if (/^(?:todo|abort|reason)(?:\s|$)/.test(line)) {
      commands.push(parseChatWorksCommand(line));
      continue;
    }

    throw new Error(
      `Expected a ChatWorks command at line ${index + 1}: ${line}`,
    );
  }

  return commands;
}

export function parseChatWorksCommand(source: string): ChatWorksCommand {
  const trimmed = source.trim();

  if (trimmed === "abort") {
    return { kind: "abort" };
  }

  if (trimmed === "reason") {
    return { kind: "reason" };
  }

  if (trimmed === "todo list") {
    return { kind: "todo-list" };
  }

  let match = /^todo add\s+([\s\S]+)$/.exec(trimmed);
  if (match) {
    return {
      kind: "todo-add",
      title: match[1],
    };
  }

  match = /^todo edit\s+(\d+)\s+([\s\S]+)$/.exec(trimmed);
  if (match) {
    return {
      kind: "todo-edit",
      id: todoId(match[1]),
      title: match[2],
    };
  }

  match = /^todo (done|reopen|delete)\s+(\d+)$/.exec(trimmed);
  if (match) {
    const id = todoId(match[2]);

    switch (match[1]) {
      case "done":
        return { kind: "todo-done", id };
      case "reopen":
        return { kind: "todo-reopen", id };
      case "delete":
        return { kind: "todo-delete", id };
    }
  }

  match = /^send\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (match) {
    const [, recipient, message] = match;
    return {
      kind: "send",
      recipient: parseParticipantReference(recipient),
      message,
    };
  }

  throw new Error(
    "Expected a ChatWorks command: send <participant> <message> or todo <list|add|edit|done|reopen|delete>.",
  );
}

export function messageRequestsAbort(
  message: import("./message.ts").Message,
): boolean {
  return message.parts.some(
    (part) =>
      part.kind === "block" &&
      part.language === "chatworks" &&
      typeof part.source === "string" &&
      part.source.split(/\r?\n/).some((line) => line.trim() === "abort"),
  );
}
