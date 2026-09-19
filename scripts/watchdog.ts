import { appendFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(
  new URL("../.build/debug/chatworks-ax", import.meta.url),
);

const outputPath =
  process.env.CHATWORKS_WATCHDOG_LOG
  ?? ".chatworks-probes/watchdog.jsonl";

const rawDuration = process.argv[2] ?? "60";
const durationSeconds = Number(rawDuration);

if (
  !Number.isFinite(durationSeconds)
  || durationSeconds <= 0
  || durationSeconds > 3600
) {
  throw new Error(
    "watchdog duration must be greater than 0 and at most 3600 seconds",
  );
}

function spawnCapture(
  command: string,
  args: string[],
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on(
      "data",
      (chunk: Buffer) => stdout.push(chunk),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => stderr.push(chunk),
    );

    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/*
 * This is intentionally NOT a generic bridge helper.
 *
 * These are the only ChatGPT operations the watchdog is capable of invoking.
 * Both are read-only observations.
 */
async function readOnlyBridge(
  operation: "assistant-observation" | "composer-state",
): Promise<unknown> {
  const result = await spawnCapture(
    process.env.CHATWORKS_AX_BRIDGE ?? bridgePath,
    [operation],
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim()
      || `read-only AX bridge exited ${result.status}`,
    );
  }

  return JSON.parse(result.stdout) as unknown;
}

type WatchProcess = {
  pid: number;
  ppid: number;
  command: string;
};

async function productionWatchProcesses():
Promise<WatchProcess[]> {
  const result = await spawnCapture(
    "ps",
    ["-axo", "pid=,ppid=,command="],
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || "could not inspect processes",
    );
  }

  const processes: WatchProcess[] = [];

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];

    // Count the actual long-lived TypeScript watch only.
    // npm wrappers, watchdogs, Swift builds and chatworks-ax probes
    // are deliberately excluded.
    if (!/node .*src\/cli\.ts(?:\s|$)/.test(command)) {
      continue;
    }

    processes.push({ pid, ppid, command });
  }

  return processes;
}

async function watchOwner(): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(
        ".chatworks-runtime/watch.lock/owner.json",
        "utf8",
      ),
    ) as unknown;
  } catch (error) {
    const code =
      typeof error === "object"
      && error !== null
      && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (code === "ENOENT") return null;
    throw error;
  }
}

async function append(record: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await appendFile(
    outputPath,
    JSON.stringify(record) + "\n",
    "utf8",
  );
}

const deadline = Date.now() + durationSeconds * 1000;

while (Date.now() < deadline) {
  const timestamp = new Date().toISOString();

  try {
    const [
      processes,
      owner,
      assistantObservation,
      composerState,
    ] = await Promise.all([
      productionWatchProcesses(),
      watchOwner(),
      readOnlyBridge("assistant-observation"),
      readOnlyBridge("composer-state"),
    ]);

    await append({
      timestamp,
      productionWatchCount: processes.length,
      productionWatches: processes,
      owner,
      assistantObservation,
      composerState,
    });

    if (processes.length > 1) {
      console.error(
        `chatworks-watchdog: WARNING: ${processes.length} production watches detected`,
      );
    }
  } catch (error) {
    await append({
      timestamp,
      error: error instanceof Error
        ? error.message
        : String(error),
    });
  }

  await new Promise(
    (resolve) => setTimeout(resolve, 1000),
  );
}

console.log(
  `chatworks-watchdog: completed ${durationSeconds}s observation`,
);
