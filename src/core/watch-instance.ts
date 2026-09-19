import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WatchOwner = {
  pid: number;
  startedAt: string;
};

export type WatchInstance = {
  owner: WatchOwner;
  release(): Promise<void>;
};

export class WatchAlreadyRunningError extends Error {
  readonly owner: WatchOwner;

  constructor(owner: WatchOwner) {
    super(`ChatWorks watch is already running with PID ${owner.pid}.`);
    this.name = "WatchAlreadyRunningError";
    this.owner = owner;
  }
}

function isWatchOwner(value: unknown): value is WatchOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.pid) &&
    (candidate.pid as number) > 0 &&
    typeof candidate.startedAt === "string"
  );
}

async function readOwner(ownerPath: string): Promise<WatchOwner> {
  let value: unknown;

  try {
    value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read ChatWorks watch ownership from ${ownerPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isWatchOwner(value)) {
    throw new Error(
      `ChatWorks watch lock has invalid ownership data: ${ownerPath}`,
    );
  }

  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (code === "ESRCH") return false;

    // EPERM or an unknown error does not prove that the process is dead.
    return true;
  }
}

export async function acquireWatchInstance(
  runtimeDirectory = ".chatworks-runtime",
): Promise<WatchInstance> {
  await mkdir(runtimeDirectory, { recursive: true });

  const lockDirectory = join(runtimeDirectory, "watch.lock");
  const ownerPath = join(lockDirectory, "owner.json");
  const owner: WatchOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // mkdir is the atomic ownership operation.
      await mkdir(lockDirectory);

      try {
        await writeFile(ownerPath, JSON.stringify(owner) + "\n", "utf8");
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }

      let released = false;

      return {
        owner,

        async release() {
          if (released) return;

          const current = await readOwner(ownerPath);

          if (
            current.pid !== owner.pid ||
            current.startedAt !== owner.startedAt
          ) {
            throw new Error(
              `Refusing to release ChatWorks watch lock owned by PID ${current.pid}.`,
            );
          }

          await rm(lockDirectory, { recursive: true });
          released = true;
        },
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;

      if (code !== "EEXIST") throw error;

      const existing = await readOwner(ownerPath);

      if (processExists(existing.pid)) {
        throw new WatchAlreadyRunningError(existing);
      }

      if (attempt !== 0) {
        throw new Error(
          "Could not acquire ChatWorks watch lock after removing a stale lock.",
        );
      }

      await rm(lockDirectory, { recursive: true });
    }
  }

  throw new Error("Could not acquire ChatWorks watch lock.");
}
