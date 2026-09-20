import type { Participant } from "../core/participants.ts";

export type DiscussionGateway = {
  selectChat: (reference: string) => Promise<void>;
  assistantState: () => Promise<string>;
  scrollToBottom?: () => Promise<void>;
  latestAssistantMessage: () => Promise<string | undefined>;
  send: (message: string) => Promise<void>;
};

export type DiscussionOptions = {
  passes: number;
  pollMilliseconds?: number;
  responseTimeoutMilliseconds?: number;
  maxReplyObservations?: number;
  onProgress?: (message: string) => void;
};

type DiscussionMessage = {
  sender: Participant;
  text: string;
  seenBy: Set<string>;
};

const defaultPollMilliseconds = 1_000;
const defaultResponseTimeoutMilliseconds = 120_000;
const defaultMaxReplyObservations = 8;

function needsScrollToBottom(state: string): boolean {
  try {
    return (
      (JSON.parse(state) as { scrollToBottomVisible?: unknown })
        .scrollToBottomVisible === true
    );
  } catch {
    return false;
  }
}

function promptFor(
  recipient: Participant,
  next: Participant,
  participants: Participant[],
  messages: DiscussionMessage[],
): string {
  const roster = participants.map((participant) => participant.id).join(", ");
  const divider = ["", "", "---", "", ""].join("\n");
  const transcript = messages
    .map((message) => `${divider}${message.sender.id} wrote:\n${message.text}`)
    .join("");
  return `[ChatWorks discussion]
You are ${recipient.id}.
Participants: ${roster}
${transcript}

Add your perspective for ${next.id}. Reply with your contribution only; ChatWorks will forward it.`;
}

async function waitForReply(
  previousState: string,
  gateway: DiscussionGateway,
  options: DiscussionOptions,
): Promise<string> {
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const deadline =
    Date.now() +
    (options.responseTimeoutMilliseconds ?? defaultResponseTimeoutMilliseconds);
  const maxReplyObservations =
    options.maxReplyObservations ?? defaultMaxReplyObservations;
  let candidateReply: string | undefined;
  let observations = 0;
  let attemptedScroll = false;
  let responseStarted = false;

  while (Date.now() < deadline) {
    const state = await gateway.assistantState();

    if (needsScrollToBottom(state) && !attemptedScroll) {
      attemptedScroll = true;
      await gateway.scrollToBottom?.();
      continue;
    }

    responseStarted ||= state !== previousState;

    if (responseStarted) {
      const reply = await gateway.latestAssistantMessage();

      if (reply !== undefined) {
        if (reply === candidateReply) return reply;

        candidateReply = reply;
        observations += 1;
        if (observations > maxReplyObservations) {
          throw new Error(
            `Stopped waiting after ${maxReplyObservations} unstable reply observations.`,
          );
        }
      } else {
        candidateReply = undefined;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }

  throw new Error(
    "Timed out waiting for the participant's assistant response.",
  );
}

export async function discuss(
  participants: Participant[],
  gateway: DiscussionGateway,
  options: DiscussionOptions,
): Promise<void> {
  if (participants.length < 2) {
    throw new Error("A discussion requires at least two participants.");
  }
  if (!Number.isInteger(options.passes) || options.passes < 1)
    throw new Error("passes must be a positive integer.");
  const first = participants[0];
  await gateway.selectChat(first.chat.title);
  let sender = first;
  const opening = await gateway.latestAssistantMessage();
  if (!opening)
    throw new Error(
      `'${first.chat.title}' has no assistant message to start the discussion.`,
    );
  const transcript: DiscussionMessage[] = [
    { sender: first, text: opening, seenBy: new Set([first.id]) },
  ];

  for (let pass = 0; pass < options.passes; pass += 1) {
    const recipient = participants[(pass + 1) % participants.length];
    const next = participants[(pass + 2) % participants.length];
    options.onProgress?.(
      `Pass ${pass + 1}/${options.passes}: ${sender.id} → ${recipient.id}`,
    );
    await gateway.selectChat(recipient.chat.title);
    const previousState = await gateway.assistantState();
    const unread = transcript.filter(
      (message) => !message.seenBy.has(recipient.id),
    );
    await gateway.send(promptFor(recipient, next, participants, unread));
    unread.forEach((message) => message.seenBy.add(recipient.id));
    if (pass + 1 === options.passes) return;
    const reply = await waitForReply(previousState, gateway, options);
    sender = recipient;
    transcript.push({ sender, text: reply, seenBy: new Set([sender.id]) });
  }
}
