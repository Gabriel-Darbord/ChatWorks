import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../../.build/debug/chatworks-ax", import.meta.url));

export class NoAssistantMessageError extends Error {
  constructor() {
    super("No assistant message is available to copy.");
    this.name = "NoAssistantMessageError";
  }
}

/**
 * Swift's JSONEncoder does not guarantee object-key order between bridge
 * processes. Discussions compare assistant states across separate invocations,
 * so turn the structured state into a deterministic JSON representation first.
 */
export function normalizeAssistantState(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.copyControlCount !== "number") return raw;
    return JSON.stringify({
      copyControlCount: value.copyControlCount,
      latestCopyControlY: typeof value.latestCopyControlY === "number" ? value.latestCopyControlY : null,
      responseHeadingCount: typeof value.responseHeadingCount === "number" ? value.responseHeadingCount : null,
      scrollToBottomVisible: value.scrollToBottomVisible === true,
    });
  } catch {
    return raw;
  }
}

export function callBridge(arguments_: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CHATWORKS_AX_BRIDGE ?? bridgePath, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (code === 2) reject(new NoAssistantMessageError());
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `AX bridge exited ${code}`));
    });
    child.stdin.end(input);
  });
}
