import {
  callBridge,
  selectChatGPTApplication,
  selectInteractionPolicy,
  type ChatGPTApplication,
  type InteractionPolicy,
  guardedStageAndSend,
  NoAssistantMessageError,
  normalizeAssistantState,
  participantCreationGateway,
  readAccessibilityAssistantObservation,
  readAccessibilityMessage,
  readComposerState,
} from "./adapters/chatgpt-bridge.ts";
import {
  messageText,
  parseMessage,
  type Block,
  type Message,
} from "./core/message.ts";
import {
  activateModules,
  messageModules,
  type ModuleDescriptor,
} from "./core/module-registry.ts";
import { visitMessage, type MessageModule } from "./core/modules.ts";
import type { ExecutionScope } from "./core/execution-scope.ts";
import { discuss, type DiscussionGateway } from "./modules/discussion.ts";
import { shellModule } from "./modules/shell.ts";
import { chatWorksModule, type ChatWorksGateway } from "./modules/chatworks.ts";
import {
  createParticipant,
  participantChatTitle,
  resolveExistingParticipants,
  resolveParticipants,
} from "./core/participants.ts";
import { participantExecutionScope } from "./core/participant-execution.ts";
import { logError } from "./core/diagnostics.ts";
import { acquireWatchInstance } from "./core/watch-instance.ts";
import {
  recoverTransactionAction,
  WatchTransactionStore,
} from "./core/watch-transaction.ts";
import { assertExecutionAllowed } from "./core/execution-context.ts";
import { parseDiscussionRequest } from "./core/discussion-request.ts";
import {
  newWatchState,
  recoverWatchState,
  runWatchIteration,
  type WatchGateway,
  type WatchState,
} from "./core/watch.ts";
import { runOnce } from "./core/once.ts";
import { withTurnCheckpoint } from "./core/checkpoint.ts";
import { formatTodos, TodoStore } from "./core/todos.ts";
import { messageRequestsAbort } from "./core/chatworks-language.ts";
import { classicProviderGateway } from "./providers/classic-gateway.ts";
import { createProviderServer } from "./providers/provider-http.ts";
import { parseProviderOptions } from "./providers/provider-options.ts";

const pollMilliseconds = 1_000;
const usage = `Usage:
  npm start                         Watch ChatGPT and automatically execute, post, and send results.
  npm start -- once                  Perform one read, execute, post, and send cycle.
  npm start -- recover               Show durable watch recovery state.
  npm start -- recover discard       Discard recovered work without rerunning its command.
  npm start -- recover retry         Retry a failed submission without rerunning its command.
  npm start -- read [message]        Print parsed blocks from a message, or from ChatGPT when omitted.
  npm start -- run [message]         Execute supported blocks from a message, or from ChatGPT when omitted.
  npm start -- write <message>       Stage a message in ChatGPT's composer.
  npm start -- send [message]        Send the staged draft, or stage and send a message.
  npm start -- chats                 List chats in ChatGPT's sidebar.
  npm start -- switch <reference>    Switch by exact name or displayed index.
  npm start -- new                   Create a new ChatGPT chat.
  npm start -- participant list      List ChatWorks participants.
  npm start -- participant create <id> <role...>
                                      Create and initialize a ChatWorks participant.
  npm start -- --app <application> provider [--chat <exact title>] [--port <port>]
                                      Expose the current or selected ChatGPT chat as a local OpenAI-compatible provider.
  npm start -- inspect [label...]    Inspect read-only accessibility controls for maintenance.
  npm start -- discuss <chat...>     Relay the first chat's latest assistant message through participants.
    --participants                   Interpret arguments as ChatWorks participant ids.
    --pass[=N]                      Make N message passes (default: 1).
    --turn[=N]                      Make N full round-robin turns (default: 1).
  --modules <ids>                    Activate comma-separated modules: shell, chatworks, discussion, or none.
  --app <application>                Target "classic" or "desktop" ChatGPT; required when both are open.
  --interaction <policy>             Use "background" (default), "focus", or "pointer" UI interaction.
  --as <participant>                 Execute once/run as a ChatWorks participant.
  --checkpoint                       Check and commit the working tree after each executed turn.`;

function chatWorksGateway(): ChatWorksGateway {
  return {
    async listChats() {
      return JSON.parse(await callBridge(["list-chats"])) as Array<{
        index: number;
        title: string;
      }>;
    },

    async selectChat(reference) {
      await callBridge(["select-chat", reference]);
    },

    async send(message) {
      await callBridge(["stage-and-send"], message);
    },
  };
}

const availableModules: ModuleDescriptor[] = [
  { id: "shell", messageModule: shellModule() },
  { id: "chatworks", messageModule: chatWorksModule(chatWorksGateway()) },
  { id: "discussion" },
];

async function runMessage(
  message: Message,
  modules: MessageModule[],
  scope: ExecutionScope = {},
): Promise<string> {
  if (messageRequestsAbort(message)) {
    return "Aborted.";
  }

  let blockNumber = 0;
  const handled = message.parts.some((part) =>
    modules.some((module) => module.handles(part)),
  );

  const responses = await visitMessage(message, modules, {
    scope,
    onBlockStart(block: Block) {
      blockNumber += 1;
      console.log(`Running block ${blockNumber} (${block.language})...`);
    },
    onBlockFinish() {
      console.log(`Block ${blockNumber} finished.`);
    },
    onOutput(chunk, stream) {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    },
  });
  if (responses.length > 0) {
    return responses.join("\n\n");
  }

  if (!handled) {
    console.log("No configured module handled a message part.");

    const todos = await new TodoStore().list();
    if (todos.length > 0) {
      return formatTodos(todos);
    }
  }

  return "";
}

function printReadResult(raw: string, modules: MessageModule[]): void {
  const message = parseMessage(raw);
  process.stdout.write(`${raw}${raw.endsWith("\n") ? "" : "\n"}`);
  const blocks = message.parts.filter(
    (part): part is Block => part.kind === "block",
  );
  console.log(
    `\nParsed parts (${message.parts.length}); blocks (${blocks.length}):`,
  );
  if (blocks.length === 0) console.log("  none");
  for (const [index, block] of blocks.entries()) {
    const handler = modules.find((module) => module.handles(block));
    console.log(
      `\n[${index + 1}] ${block.language}${block.metadata ? ` ${block.metadata}` : ""}${handler ? ` (${handler.name})` : " (unhandled)"}`,
    );
    console.log(block.source);
  }
}

function watchGateway(state: { waitingForMessage: boolean }): WatchGateway {
  return {
    async observe() {
      try {
        const observation = await readAccessibilityAssistantObservation();
        state.waitingForMessage = false;
        return observation;
      } catch (error) {
        if (error instanceof NoAssistantMessageError) {
          if (!state.waitingForMessage) {
            console.log("Waiting for the first assistant message...");
          }
          state.waitingForMessage = true;
        }
        throw error;
      }
    },

    async composerAvailable() {
      return (await readComposerState()).availability === "available";
    },

    async submit(response) {
      return (await guardedStageAndSend(response)).status;
    },
  };
}

async function watchIteration(
  modules: MessageModule[],
  state: WatchState,
  waiting: { waitingForMessage: boolean },
  transactions: WatchTransactionStore,
  checkpoint: boolean,
): Promise<void> {
  try {
    const executor = {
      execute(message: Message) {
        return runMessage(message, modules);
      },
    };

    await runWatchIteration(
      watchGateway(waiting),
      checkpoint ? withTurnCheckpoint(executor) : executor,
      state,
      transactions,
    );
  } catch (error) {
    if (error instanceof NoAssistantMessageError) return;

    console.error(
      `chatworks: ${error instanceof Error ? error.message : String(error)}`,
    );
    await logError("watch-iteration", error);
  }
}

async function recover(arguments_: string[]): Promise<void> {
  const transactions = new WatchTransactionStore();
  const transaction = await transactions.read();

  if (!transaction) {
    console.log("No durable ChatWorks watch transaction.");
    return;
  }

  if (arguments_.length === 0) {
    console.log(JSON.stringify(transaction, null, 2));
    return;
  }

  if (
    arguments_.length !== 1 ||
    (arguments_[0] !== "discard" && arguments_[0] !== "retry")
  ) {
    throw new Error("Usage: npm start -- recover [discard|retry]");
  }

  const action = arguments_[0];
  const recovered = recoverTransactionAction(transaction, action);

  await transactions.write(recovered);

  if (action === "discard") {
    console.log(
      `Acknowledged recovered ${transaction.phase} transaction ` +
        `${transaction.messageIdentity}. Its originating command will not ` +
        "be executed automatically again.",
    );
  } else {
    console.log(
      `Rearmed failed submission ${transaction.messageIdentity}. ` +
        "The persisted response may now be submitted without rerunning its command.",
    );
  }
}

async function watch(
  modules: MessageModule[],
  checkpoint: boolean,
): Promise<void> {
  const instance = await acquireWatchInstance();

  let releasing = false;

  const releaseAndExit = (exitCode: number) => {
    if (releasing) return;
    releasing = true;

    void instance
      .release()
      .catch((error) => {
        console.error(
          `chatworks: could not release watch ownership: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };

  const onSigint = () => releaseAndExit(130);
  const onSigterm = () => releaseAndExit(143);

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    console.log(
      `Watching ChatGPT for new assistant messages (PID ${instance.owner.pid}). Press Ctrl-C to stop.`,
    );

    const state = newWatchState();
    const waiting = { waitingForMessage: false };
    const transactions = new WatchTransactionStore();
    const recoveredTransaction = await transactions.read();

    recoverWatchState(state, recoveredTransaction);

    if (recoveredTransaction?.phase === "executing") {
      console.error(
        `ChatWorks recovered an uncertain prior execution (${recoveredTransaction.messageIdentity}). ` +
          "Automatic assistant-provided execution is blocked.",
      );
    }

    for (;;) {
      await watchIteration(modules, state, waiting, transactions, checkpoint);
      await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);

    if (!releasing) {
      await instance.release();
    }
  }
}

async function once(
  modules: MessageModule[],
  scope: ExecutionScope = {},
  checkpoint = false,
): Promise<void> {
  const observation = await readAccessibilityAssistantObservation();
  const executor = {
    execute(message: Message) {
      return runMessage(message, modules, scope);
    },
  };

  const result = await runOnce(
    observation,
    checkpoint ? withTurnCheckpoint(executor) : executor,
    {
      async submit(response) {
        return (await guardedStageAndSend(response)).status;
      },
    },
  );

  switch (result.kind) {
    case "not-assistant":
      console.log(
        "No current assistant response to execute; the latest conversation message is not from the assistant.",
      );
      return;
    case "no-output":
      return;
    case "submitted":
      console.log("Results submitted to ChatGPT.");
      return;
    case "not-submitted":
      console.log(`Results not submitted: composer is ${result.status}.`);
      return;
  }
}

type GlobalOptions = {
  arguments_: string[];
  moduleIds?: string[];
  participantId?: string;
  application?: ChatGPTApplication;
  interactionPolicy: InteractionPolicy;
  checkpoint: boolean;
};

function extractGlobalOptions(arguments_: string[]): GlobalOptions {
  const remaining: string[] = [];
  let moduleIds: string[] | undefined;
  let participantId: string | undefined;
  let application: ChatGPTApplication | undefined;
  let interactionPolicy: InteractionPolicy = "background";
  let checkpoint = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    switch (arguments_[index]) {
      case "--modules": {
        if (moduleIds) throw new Error("--modules may be specified only once.");
        const value = arguments_[index + 1];
        if (!value)
          throw new Error("--modules requires a comma-separated module list.");
        moduleIds = value.split(",").filter(Boolean);
        index += 1;
        break;
      }

      case "--as": {
        if (participantId !== undefined)
          throw new Error("--as may be specified only once.");
        const value = arguments_[index + 1];
        if (!value || value.startsWith("--"))
          throw new Error("--as requires a participant id.");
        participantId = value;
        index += 1;
        break;
      }

      case "--app": {
        if (application !== undefined)
          throw new Error("--app may be specified only once.");
        const value = arguments_[index + 1];
        if (value !== "classic" && value !== "desktop") {
          throw new Error("--app requires 'classic' or 'desktop'.");
        }
        application = value;
        index += 1;
        break;
      }

      case "--checkpoint": {
        if (checkpoint)
          throw new Error("--checkpoint may be specified only once.");
        checkpoint = true;
        break;
      }

      case "--interaction": {
        const value = arguments_[index + 1];
        if (
          value !== "background" &&
          value !== "focus" &&
          value !== "pointer"
        ) {
          throw new Error(
            "--interaction requires 'background', 'focus', or 'pointer'.",
          );
        }
        interactionPolicy = value;
        index += 1;
        break;
      }

      default:
        remaining.push(arguments_[index]);
    }
  }

  return {
    arguments_: remaining,
    moduleIds,
    participantId,
    application,
    interactionPolicy,
    checkpoint,
  };
}

async function participantScope(
  participantId: string | undefined,
): Promise<ExecutionScope> {
  return participantExecutionScope(participantId, {
    async listChats() {
      return JSON.parse(await callBridge(["list-chats"])) as Array<{
        index: number;
        title: string;
      }>;
    },

    async selectChat(reference) {
      await callBridge(["select-chat", reference]);
    },
  });
}

function discussionGateway(): DiscussionGateway {
  return {
    async selectChat(reference) {
      await callBridge(["select-chat", reference]);
    },
    async assistantState() {
      return normalizeAssistantState(await callBridge(["assistant-state"]));
    },
    async scrollToBottom() {
      await callBridge(["scroll-to-bottom"]);
    },
    async latestAssistantMessage() {
      try {
        return messageText(await readAccessibilityMessage());
      } catch (error) {
        if (error instanceof NoAssistantMessageError) return undefined;
        throw error;
      }
    },
    async send(message) {
      await callBridge(["stage-and-send"], message);
    },
  };
}

async function runDiscussion(arguments_: string[]): Promise<void> {
  const request = parseDiscussionRequest(arguments_);

  const resolutionGateway = {
    async listChats() {
      return JSON.parse(await callBridge(["list-chats"])) as Array<{
        index: number;
        title: string;
      }>;
    },
  };

  const participants =
    request.referenceMode === "participants"
      ? await resolveParticipants(request.references, resolutionGateway)
      : await resolveExistingParticipants(
          request.references,
          resolutionGateway,
        );

  const gateway = discussionGateway();
  await discuss(participants, gateway, {
    passes:
      request.turns !== undefined
        ? participants.length * request.turns
        : (request.passes ?? 1),
    onProgress: console.log,
  });

  console.log("Discussion completed.");
}

async function runParticipantCommand(arguments_: string[]): Promise<void> {
  const [subcommand, ...rest] = arguments_;

  switch (subcommand) {
    case "list": {
      if (rest.length > 0) throw new Error(usage);

      const chats: Array<{ index: number; title: string }> = JSON.parse(
        await callBridge(["list-chats"]),
      );

      const prefix = participantChatTitle("").toLocaleLowerCase();
      const participants = chats.flatMap((chat) => {
        if (!chat.title.toLocaleLowerCase().startsWith(prefix)) return [];

        return [
          {
            id: chat.title.slice(prefix.length),
            title: chat.title,
          },
        ];
      });

      if (participants.length === 0) {
        console.log("No ChatWorks participants found.");
      } else {
        participants.forEach((participant) =>
          console.log(`${participant.id}  ${participant.title}`),
        );
      }
      return;
    }

    case "create": {
      const [id, ...roleParts] = rest;
      if (!id || roleParts.length === 0) {
        throw new Error(
          "participant create requires an id and role instructions.\n\n" +
            usage,
        );
      }

      const participant = await createParticipant(
        id,
        { instructions: roleParts.join(" ") },
        participantCreationGateway(),
      );

      console.log(
        `Participant '${participant.id}' created as '${participant.chat.title}'.`,
      );
      return;
    }

    default:
      throw new Error("participant requires 'list' or 'create'.\n\n" + usage);
  }
}

async function runProvider(
  arguments_: string[],
  application: ChatGPTApplication | undefined,
): Promise<void> {
  if (!application) {
    throw new Error("provider requires --app classic or --app desktop.");
  }

  const options = parseProviderOptions(arguments_);
  if (options.chat !== "current") {
    await callBridge(["select-chat", options.chat]);
  }

  const server = createProviderServer(classicProviderGateway());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const target =
    options.chat === "current" ? "the current chat" : `'${options.chat}'`;
  console.log(
    `ChatWorks OpenAI-compatible provider is bound to ${target} at http://127.0.0.1:${options.port}/v1. Press Ctrl-C to stop.`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const options = extractGlobalOptions(process.argv.slice(2));
  const [command, ...arguments_] = options.arguments_;

  if (command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }

  const {
    moduleIds,
    participantId,
    application,
    interactionPolicy,
    checkpoint,
  } = options;
  selectChatGPTApplication(application);
  selectInteractionPolicy(interactionPolicy);
  const active = activateModules(availableModules, moduleIds);
  const modules = messageModules(active);

  if (participantId !== undefined && command !== "once" && command !== "run") {
    throw new Error("--as is currently supported only by 'once' and 'run'.");
  }

  if (!command) {
    assertExecutionAllowed();
    return watch(modules, checkpoint);
  }

  switch (command) {
    case "recover":
      await recover(arguments_);
      return;

    case "once":
      if (arguments_.length > 0) throw new Error(usage);
      assertExecutionAllowed();
      await once(modules, await participantScope(participantId), checkpoint);
      return;
    case "read":
      printReadResult(
        arguments_.length === 0
          ? await callBridge(["read"])
          : arguments_.join(" "),
        modules,
      );
      return;
    case "run":
      assertExecutionAllowed();
      const scope = await participantScope(participantId);
      await runMessage(
        arguments_.length === 0
          ? await readAccessibilityMessage()
          : parseMessage(arguments_.join(" ")),
        modules,
        scope,
      );
      return;
    case "write":
      if (arguments_.length === 0)
        throw new Error("write requires a message.\n\n" + usage);
      await callBridge(["stage"], arguments_.join(" "));
      console.log("Message staged in ChatGPT.");
      return;
    case "send":
      if (arguments_.length === 0) await callBridge(["send"]);
      else await callBridge(["stage-and-send"], arguments_.join(" "));
      console.log("Message submitted to ChatGPT.");
      return;
    case "chats": {
      if (arguments_.length > 0) throw new Error(usage);
      const chats: Array<{ index: number; title: string }> = JSON.parse(
        await callBridge(["list-chats"]),
      );
      if (chats.length === 0)
        console.log("No chats found in the visible ChatGPT sidebar.");
      else chats.forEach((chat) => console.log(`${chat.index}. ${chat.title}`));
      return;
    }
    case "switch": {
      if (arguments_.length === 0)
        throw new Error(
          "switch requires a chat name or displayed index.\n\n" + usage,
        );
      await callBridge(["select-chat", arguments_.join(" ")]);
      console.log("ChatGPT chat selected.");
      return;
    }
    case "new":
      if (arguments_.length > 0) throw new Error(usage);
      await callBridge(["new-chat"]);
      console.log("New ChatGPT chat created.");
      return;
    case "participant":
      await runParticipantCommand(arguments_);
      return;
    case "provider":
      await runProvider(arguments_, application);
      return;
    case "inspect": {
      const controls: Array<Record<string, unknown>> = JSON.parse(
        await callBridge(["inspect", ...arguments_]),
      );
      console.log(JSON.stringify(controls, null, 2));
      return;
    }
    case "discuss":
      if (!active.some((module) => module.id === "discussion"))
        throw new Error(
          "The discussion module is not active. Include it with --modules discussion.",
        );
      await runDiscussion(arguments_);
      return;
    default:
      throw new Error(usage);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof NoAssistantMessageError) {
    console.log("No assistant message is available in this chat yet.");
  } else {
    console.error(
      `chatworks: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
