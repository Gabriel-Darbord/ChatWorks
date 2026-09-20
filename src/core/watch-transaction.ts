import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type WatchTransaction =
  | {
      messageIdentity: string;
      phase: "executing";
    }
  | {
      messageIdentity: string;
      phase: "acknowledged";
    }
  | {
      messageIdentity: string;
      phase: "pending";
      response: string;
    }
  | {
      messageIdentity: string;
      phase: "submission-failed";
      response: string;
    };

function isWatchTransaction(value: unknown): value is WatchTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.messageIdentity !== "string") {
    return false;
  }

  if (candidate.phase === "executing" || candidate.phase === "acknowledged") {
    return candidate.response === undefined;
  }

  if (
    candidate.phase === "pending" ||
    candidate.phase === "submission-failed"
  ) {
    return typeof candidate.response === "string";
  }

  return false;
}

export class WatchTransactionStore {
  readonly path: string;

  constructor(runtimeDirectory = ".chatworks-runtime") {
    this.path = join(runtimeDirectory, "watch-transaction.json");
  }

  async read(): Promise<WatchTransaction | undefined> {
    let contents: string;

    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;

      if (code === "ENOENT") return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error(
        `Could not parse ChatWorks watch transaction ${this.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!isWatchTransaction(value)) {
      throw new Error(
        `ChatWorks watch transaction has invalid data: ${this.path}`,
      );
    }

    return value;
  }

  async write(transaction: WatchTransaction): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temporaryPath = `${this.path}.tmp-${process.pid}`;

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(transaction) + "\n",
        "utf8",
      );
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export function recoverTransactionAction(
  transaction: WatchTransaction,
  action: "discard" | "retry",
): WatchTransaction {
  if (action === "discard") {
    if (transaction.phase === "acknowledged") {
      throw new Error("This watch transaction is already acknowledged.");
    }

    return {
      messageIdentity: transaction.messageIdentity,
      phase: "acknowledged",
    };
  }

  if (transaction.phase !== "submission-failed") {
    throw new Error(
      `Cannot retry a watch transaction in phase '${transaction.phase}'.`,
    );
  }

  return {
    messageIdentity: transaction.messageIdentity,
    phase: "pending",
    response: transaction.response,
  };
}
