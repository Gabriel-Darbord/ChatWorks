import type { Message, MessagePart } from "./message.ts";

export type ModuleContext = {
  onBlockStart: (block: Extract<MessagePart, { kind: "block" }>) => void;
  onBlockFinish: (block: Extract<MessagePart, { kind: "block" }>) => void;
  onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => void;
};

export type MessageModule = {
  name: string;
  handles: (part: MessagePart) => boolean;
  visit: (
    part: MessagePart,
    context: ModuleContext,
  ) => Promise<string | undefined>;
};

export async function visitMessage(
  message: Message,
  modules: MessageModule[],
  context: ModuleContext,
): Promise<string[]> {
  const responses: string[] = [];
  for (const part of message.parts) {
    const module = modules.find((candidate) => candidate.handles(part));
    if (!module) continue;
    const response = await module.visit(part, context);
    if (response) responses.push(response);
  }
  return responses;
}
