import type { ExecutionScope } from "./execution-scope.ts";
import {
  chatsAddedSince,
  createChat,
  type ChatCreationGateway,
  type ChatReference,
  type ListedChat,
} from "./chats.ts";
import {
  waitForParticipantInitialResponse,
  type ParticipantResponseGateway,
} from "./participant-response.ts";

export type Participant = {
  id: string;
  chat: ChatReference;
};

export type ParticipantRole = {
  instructions: string;
};

export type ParticipantResolutionGateway = {
  listChats(): Promise<ListedChat[]>;
};

export type ParticipantCreationGateway = ParticipantResolutionGateway &
  ChatCreationGateway &
  ParticipantResponseGateway & {
    selectChat(reference: string): Promise<void>;
    renameChat(reference: string, newTitle: string): Promise<void>;
  };

function resolveChat(reference: string, chats: ListedChat[]): ListedChat {
  const index = Number(reference);
  const matches =
    Number.isInteger(index) && index >= 1
      ? chats.filter((candidate) => candidate.index === index)
      : chats.filter(
          (candidate) =>
            candidate.title.toLocaleLowerCase() ===
            reference.toLocaleLowerCase(),
        );

  if (matches.length === 0) {
    throw new Error(`Could not find a chat matching '${reference}'.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `More than one chat is named '${reference}'; use its displayed index.`,
    );
  }

  return matches[0];
}

export async function bindExistingParticipant(
  id: string,
  reference: string,
  gateway: ParticipantResolutionGateway,
): Promise<Participant> {
  const chat = resolveChat(reference, await gateway.listChats());

  return {
    id,
    chat: { title: chat.title },
  };
}

export async function resolveExistingParticipants(
  references: string[],
  gateway: ParticipantResolutionGateway,
): Promise<Participant[]> {
  const chats = await gateway.listChats();

  const participants = references.map((reference, index) => {
    const chat = resolveChat(reference, chats);

    return {
      id: `participant-${index + 1}`,
      chat: { title: chat.title },
    };
  });

  if (
    new Set(
      participants.map((participant) =>
        participant.chat.title.toLocaleLowerCase(),
      ),
    ).size !== participants.length
  ) {
    throw new Error("Participant chat bindings must have unique titles.");
  }

  return participants;
}

export function participantChatTitle(id: string): string {
  return `ChatWorks: ${id}`;
}

function resolveParticipantFromChats(
  id: string,
  chats: ListedChat[],
): Participant {
  const title = participantChatTitle(id);
  const matches = chats.filter(
    (chat) => chat.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
  );

  if (matches.length === 0) {
    throw new Error(`Could not find participant '${id}'.`);
  }

  if (matches.length > 1) {
    throw new Error(`More than one participant chat is named '${title}'.`);
  }

  return {
    id,
    chat: { title: matches[0].title },
  };
}

export async function resolveParticipant(
  id: string,
  gateway: ParticipantResolutionGateway,
): Promise<Participant> {
  return resolveParticipantFromChats(id, await gateway.listChats());
}

function participantInitialization(id: string, role: ParticipantRole): string {
  return `[ChatWorks participant]
You are ${id}.

Role:
${role.instructions}

You are participating through ChatWorks. Follow this role in subsequent messages.`;
}

export async function resolveParticipants(
  ids: string[],
  gateway: ParticipantResolutionGateway,
): Promise<Participant[]> {
  if (new Set(ids.map((id) => id.toLocaleLowerCase())).size !== ids.length) {
    throw new Error("Participant ids must be unique.");
  }

  const chats = await gateway.listChats();
  return ids.map((id) => resolveParticipantFromChats(id, chats));
}

export async function createParticipant(
  id: string,
  role: ParticipantRole,
  gateway: ParticipantCreationGateway,
): Promise<Participant> {
  const title = participantChatTitle(id);
  const before = await gateway.listChats();

  if (
    before.some(
      (chat) => chat.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
    )
  ) {
    throw new Error(`A participant chat named '${title}' already exists.`);
  }

  const created = await createChat(
    participantInitialization(id, role),
    gateway,
  );

  // First-message submission may leave ChatGPT displaying New Chat rather than
  // the committed conversation. Select the chat identified by createChat's
  // sidebar confirmation before observing its initial assistant response.
  await gateway.selectChat(created.title);
  await waitForParticipantInitialResponse(gateway);

  // The generated title may change while the initial response is produced.
  // Resolve the created conversation again relative to the original sidebar.
  const after = await gateway.listChats();
  const appeared = chatsAddedSince(before, after);

  if (appeared.length === 0) {
    throw new Error(
      "Could not find the newly created participant chat after its initial response.",
    );
  }

  if (appeared.length > 1) {
    throw new Error(
      "More than one new ChatGPT chat appeared while creating a participant.",
    );
  }

  const generatedTitle = appeared[0].title;
  const duplicateTitles = after.filter(
    (chat) =>
      chat.title.localeCompare(generatedTitle, undefined, {
        sensitivity: "accent",
      }) === 0,
  );

  if (duplicateTitles.length !== 1) {
    throw new Error(
      `New ChatGPT chat title '${generatedTitle}' is not unique.`,
    );
  }

  await gateway.renameChat(generatedTitle, title);

  return {
    id,
    chat: { title },
  };
}

export type ParticipantReference =
  { kind: "metavariable"; name: "self" } | { kind: "participant"; id: string };

export function parseParticipantReference(
  source: string,
): ParticipantReference {
  if (source === "$self") {
    return { kind: "metavariable", name: "self" };
  }

  if (source.startsWith("$")) {
    throw new Error(`Unknown participant metavariable '${source}'.`);
  }

  return { kind: "participant", id: source };
}

export function resolveParticipantReference(
  reference: ParticipantReference,
  context: ExecutionScope,
  participants: Participant[],
): Participant {
  if (reference.kind === "metavariable") {
    if (!context.self) {
      throw new Error(
        "Cannot resolve '$self' because this ChatWorks execution has no participant binding.",
      );
    }

    return context.self;
  }

  const matches = participants.filter(
    (participant) => participant.id === reference.id,
  );

  if (matches.length === 0) {
    throw new Error(`Could not find participant '${reference.id}'.`);
  }

  if (matches.length > 1) {
    throw new Error(`More than one participant is named '${reference.id}'.`);
  }

  return matches[0];
}
