export type ChatReference = { index: number; title: string };

export type DiscussionParticipant = {
  id: string;
  name: string;
  index: number;
};

export type DiscussionGateway = {
  listChats: () => Promise<ChatReference[]>;
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
  sender: DiscussionParticipant;
  text: string;
  seenBy: Set<string>;
};

const defaultPollMilliseconds = 1_000;
const defaultResponseTimeoutMilliseconds = 120_000;
const defaultMaxReplyObservations = 8;

function hasCopyControl(state: string): boolean {
  try {
    const parsed = JSON.parse(state) as { copyControlCount?: unknown };
    return typeof parsed.copyControlCount === "number" && parsed.copyControlCount > 0;
  } catch {
    // Test and alternate gateways may provide an opaque state token. A changed
    // token is the only readiness signal available in that case.
    return true;
  }
}

function needsScrollToBottom(state: string): boolean {
  try {
    return (JSON.parse(state) as { scrollToBottomVisible?: unknown }).scrollToBottomVisible === true;
  } catch {
    return false;
  }
}

export async function resolveParticipants(references: string[], gateway: DiscussionGateway): Promise<DiscussionParticipant[]> {
  if (references.length < 2) throw new Error("discuss requires at least two chat references.");
  const chats = await gateway.listChats();
  const participants = references.map((reference) => {
    const index = Number(reference);
    const matches = Number.isInteger(index) && index >= 1
      ? chats.filter((candidate) => candidate.index === index)
      : chats.filter((candidate) => candidate.title.toLocaleLowerCase() === reference.toLocaleLowerCase());
    if (matches.length === 0) throw new Error(`Could not find a chat matching '${reference}'.`);
    if (matches.length > 1) throw new Error(`More than one chat is named '${reference}'; use its displayed index.`);
    const chat = matches[0];
    return { id: `participant-${chat.index}`, name: chat.title, index: chat.index };
  });
  if (new Set(participants.map((participant) => participant.index)).size !== participants.length) {
    throw new Error("A discussion participant may appear only once.");
  }
  if (new Set(participants.map((participant) => participant.name.toLocaleLowerCase())).size !== participants.length) {
    throw new Error("Discussion participants must have unique chat titles so ChatWorks can follow sidebar reordering.");
  }
  return participants;
}

function promptFor(recipient: DiscussionParticipant, next: DiscussionParticipant, participants: DiscussionParticipant[], messages: DiscussionMessage[]): string {
  const roster = participants.map((participant) => participant.id).join(", ");
  const divider = ["", "", "---", "", ""].join("\n");
  const transcript = messages.map((message) => `${divider}${message.sender.id} wrote:\n${message.text}`).join("");
  return `[ChatWorks discussion]
You are ${recipient.id}.
Participants: ${roster}
${transcript}

Add your perspective for ${next.id}. Reply with your contribution only; ChatWorks will forward it.`;
}

async function waitForReply(previousState: string, gateway: DiscussionGateway, options: DiscussionOptions): Promise<string> {
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const deadline = Date.now() + (options.responseTimeoutMilliseconds ?? defaultResponseTimeoutMilliseconds);
  const maxReplyObservations = options.maxReplyObservations ?? defaultMaxReplyObservations;
  let candidateState: string | undefined;
  let observations = 0;
  let attemptedScroll = false;
  while (Date.now() < deadline) {
    const state = await gateway.assistantState();
    if (needsScrollToBottom(state) && !attemptedScroll) {
      attemptedScroll = true;
      await gateway.scrollToBottom?.();
      continue;
    }
    if (state !== previousState && hasCopyControl(state)) {
      // Wait for the candidate control to reappear unchanged. This is a pure AX
      // inspection. Only a stable control may be copied, and a missing control
      // in the next bridge invocation is retried without clicking anything.
      if (state === candidateState) {
        const reply = await gateway.latestAssistantMessage();
        if (reply) return reply;
        candidateState = undefined;
      } else {
        candidateState = state;
        observations += 1;
        if (observations > maxReplyObservations) {
          throw new Error(`Stopped waiting after ${maxReplyObservations} unstable reply-control observations.`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
  throw new Error("Timed out waiting for the participant's assistant response.");
}

export async function discuss(participants: DiscussionParticipant[], gateway: DiscussionGateway, options: DiscussionOptions): Promise<void> {
  if (!Number.isInteger(options.passes) || options.passes < 1) throw new Error("passes must be a positive integer.");
  const first = participants[0];
  await gateway.selectChat(first.name);
  let sender = first;
  const opening = await gateway.latestAssistantMessage();
  if (!opening) throw new Error(`'${first.name}' has no assistant message to start the discussion.`);
  const transcript: DiscussionMessage[] = [{ sender: first, text: opening, seenBy: new Set([first.id]) }];

  for (let pass = 0; pass < options.passes; pass += 1) {
    const recipient = participants[(pass + 1) % participants.length];
    const next = participants[(pass + 2) % participants.length];
    options.onProgress?.(`Pass ${pass + 1}/${options.passes}: ${sender.id} → ${recipient.id}`);
    await gateway.selectChat(recipient.name);
    const previousState = await gateway.assistantState();
    const unread = transcript.filter((message) => !message.seenBy.has(recipient.id));
    await gateway.send(promptFor(recipient, next, participants, unread));
    unread.forEach((message) => message.seenBy.add(recipient.id));
    if (pass + 1 === options.passes) return;
    const reply = await waitForReply(previousState, gateway, options);
    sender = recipient;
    transcript.push({ sender, text: reply, seenBy: new Set([sender.id]) });
  }
}
