export type ListedChat = {
  index: number;
  title: string;
};

export type ChatReference = {
  title: string;
};

export type ChatCreationGateway = {
  listChats(): Promise<ListedChat[]>;
  newChat(): Promise<void>;
  stage(message: string): Promise<void>;
  send(): Promise<void>;
};

export type ChatCreationOptions = {
  pollMilliseconds?: number;
  timeoutMilliseconds?: number;
};

const defaultPollMilliseconds = 250;
const defaultTimeoutMilliseconds = 10_000;

function titleCounts(chats: ListedChat[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const chat of chats) {
    const key = chat.title.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

export function chatsAddedSince(
  before: ListedChat[],
  after: ListedChat[],
): ListedChat[] {
  const remaining = titleCounts(before);
  const result: ListedChat[] = [];

  for (const chat of after) {
    const key = chat.title.toLocaleLowerCase();
    const count = remaining.get(key) ?? 0;

    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      result.push(chat);
    }
  }

  return result;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createChat(
  initialMessage: string,
  gateway: ChatCreationGateway,
  options: ChatCreationOptions = {},
): Promise<ChatReference> {
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const deadline =
    Date.now() + (options.timeoutMilliseconds ?? defaultTimeoutMilliseconds);

  const before = await gateway.listChats();

  await gateway.newChat();
  await gateway.stage(initialMessage);
  await gateway.send();

  while (Date.now() < deadline) {
    const after = await gateway.listChats();
    const appeared = chatsAddedSince(before, after);

    if (appeared.length === 1) {
      const candidate = appeared[0];

      const duplicateTitles = after.filter(
        (chat) =>
          chat.title.localeCompare(candidate.title, undefined, {
            sensitivity: "accent",
          }) === 0,
      );

      if (duplicateTitles.length !== 1) {
        throw new Error(
          `New ChatGPT chat title '${candidate.title}' is not unique.`,
        );
      }

      return { title: candidate.title };
    }

    if (appeared.length > 1) {
      throw new Error(
        "More than one new ChatGPT chat appeared while creating a participant.",
      );
    }

    await wait(pollMilliseconds);
  }

  throw new Error(
    "Timed out waiting for the newly created ChatGPT chat to appear in the sidebar.",
  );
}
