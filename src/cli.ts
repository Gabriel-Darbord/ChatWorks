import {
  callBridge,
  guardedStageAndSend,
  NoAssistantMessageError,
  normalizeAssistantState,
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
import {
  discuss,
  resolveParticipants,
  type DiscussionGateway,
} from "./modules/discussion.ts";
import { shellModule } from "./modules/shell.ts";
import { logError } from "./core/diagnostics.ts";
import { acquireWatchInstance } from "./core/watch-instance.ts";
import { assertExecutionAllowed } from "./core/execution-context.ts";
import {
  newWatchState,
  runWatchIteration,
  type WatchGateway,
  type WatchState,
} from "./core/watch.ts";
import { runOnce } from "./core/once.ts";

const pollMilliseconds = 1_000;
const usage = `Usage:
  npm start                         Watch ChatGPT and automatically execute, post, and send results.
  npm start -- once                  Perform one read, execute, post, and send cycle.
  npm start -- read [message]        Print parsed blocks from a message, or from ChatGPT when omitted.
  npm start -- run [message]         Execute supported blocks from a message, or from ChatGPT when omitted.
  npm start -- write <message>       Stage a message in ChatGPT's composer.
  npm start -- send [message]        Send the staged draft, or stage and send a message.
  npm start -- chats                 List chats in ChatGPT's sidebar.
  npm start -- switch <reference>    Switch by exact name or displayed index.
  npm start -- new                   Create a new ChatGPT chat.
  npm start -- inspect [label...]    Inspect read-only accessibility controls for maintenance.
  npm start -- discuss <chat...>     Relay the first chat's latest assistant message through participants.
    --pass [n]                       Make n message passes (default: 1).
    --turn [n]                       Make n full round-robin turns (default: 1).
  --modules <ids>                    Activate comma-separated modules: shell, discussion, or none.`;

const availableModules: ModuleDescriptor[] = [
  { id: "shell", messageModule: shellModule() },
  { id: "discussion" },
];

async function runMessage(
  message: Message,
  modules: MessageModule[],
): Promise<string> {
  let blockNumber = 0;
  const responses = await visitMessage(message, modules, {
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
  if (responses.length === 0) {
    console.log("No configured module handled a message part.");
    return "";
  }
  return responses.join("\n\n");
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
): Promise<void> {
  try {
    await runWatchIteration(
      watchGateway(waiting),
      {
        execute(message) {
          return runMessage(message, modules);
        },
      },
      state,
    );
  } catch (error) {
    if (error instanceof NoAssistantMessageError) return;

    console.error(
      `chatworks: ${error instanceof Error ? error.message : String(error)}`,
    );
    await logError("watch-iteration", error);
  }
}

async function watch(modules: MessageModule[]): Promise<void> {
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

    for (;;) {
      await watchIteration(modules, state, waiting);
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

async function once(modules: MessageModule[]): Promise<void> {
  const observation = await readAccessibilityAssistantObservation();

  const result = await runOnce(
    observation,
    {
      execute(message) {
        return runMessage(message, modules);
      },
    },
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

function extractModuleSelection(arguments_: string[]): {
  arguments_: string[];
  moduleIds?: string[];
} {
  const remaining: string[] = [];
  let moduleIds: string[] | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--modules") {
      remaining.push(arguments_[index]);
      continue;
    }
    if (moduleIds) throw new Error("--modules may be specified only once.");
    const value = arguments_[index + 1];
    if (!value)
      throw new Error("--modules requires a comma-separated module list.");
    moduleIds = value.split(",").filter(Boolean);
    index += 1;
  }
  return { arguments_: remaining, moduleIds };
}

function discussionGateway(): DiscussionGateway {
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
  let passes: number | undefined;
  let turns: number | undefined;
  const references: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    switch (arguments_[index]) {
      case "--pass": {
        const value = arguments_[index + 1];
        if (passes !== undefined)
          throw new Error("--pass may be specified only once.");
        if (!value || value.startsWith("--")) {
          passes = 1;
          break;
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1)
          throw new Error("--pass accepts an optional positive integer.");
        passes = parsed;
        index += 1;
        break;
      }
      case "--turn":
        if (turns !== undefined)
          throw new Error("--turn may be specified only once.");
        const value = arguments_[index + 1];
        if (!value || value.startsWith("--")) {
          turns = 1;
          break;
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1)
          throw new Error("--turn accepts an optional positive integer.");
        turns = parsed;
        index += 1;
        break;
      default:
        references.push(arguments_[index]);
    }
  }
  if (turns !== undefined && passes !== undefined)
    throw new Error("Use either --turn or --pass, not both.");
  const gateway = discussionGateway();
  const participants = await resolveParticipants(references, gateway);
  await discuss(participants, gateway, {
    passes: turns !== undefined ? participants.length * turns : (passes ?? 1),
    onProgress: console.log,
  });
  console.log("Discussion completed.");
}

async function main(): Promise<void> {
  const [command, ...rawArguments] = process.argv.slice(2);
  const { arguments_, moduleIds } = extractModuleSelection(rawArguments);
  const active = activateModules(availableModules, moduleIds);
  const modules = messageModules(active);

  if (!command) {
    assertExecutionAllowed();
    return watch(modules);
  }

  switch (command) {
    case "once":
      if (arguments_.length > 0) throw new Error(usage);
      assertExecutionAllowed();
      await once(modules);
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
      await runMessage(
        arguments_.length === 0
          ? await readAccessibilityMessage()
          : parseMessage(arguments_.join(" ")),
        modules,
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
