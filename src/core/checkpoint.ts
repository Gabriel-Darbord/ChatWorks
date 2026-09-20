import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  arguments_: string[],
  cwd: string,
) => Promise<CommandResult>;

export type CheckpointResult =
  | { kind: "not-git" }
  | { kind: "unchanged" }
  | {
      kind: "committed";
      checkSucceeded: boolean;
    };

const runCommand: CommandRunner = (command, arguments_, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });

export async function checkpointWorkingDirectory(
  cwd = process.cwd(),
  run: CommandRunner = runCommand,
): Promise<CheckpointResult> {
  const repository = await run(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
  );

  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") {
    return { kind: "not-git" };
  }

  const status = await run("git", ["status", "--porcelain"], cwd);

  if (status.exitCode !== 0) {
    throw new Error(
      `Could not inspect Git working tree: ${status.stderr.trim()}`,
    );
  }

  if (status.stdout.trim().length === 0) {
    return { kind: "unchanged" };
  }

  // A failed project check is still a useful checkpoint. Its status becomes
  // part of the commit message instead of preventing the commit.
  const check = await run("npm", ["run", "check"], cwd);
  const checkSucceeded = check.exitCode === 0;

  const add = await run("git", ["add", "-A"], cwd);
  if (add.exitCode !== 0) {
    throw new Error(`Could not stage checkpoint: ${add.stderr.trim()}`);
  }

  const prefix = checkSucceeded ? "[success]" : "[failure]";
  const commit = await run(
    "git",
    ["commit", "-m", `${prefix} ChatWorks turn`],
    cwd,
  );

  if (commit.exitCode !== 0) {
    throw new Error(`Could not create checkpoint: ${commit.stderr.trim()}`);
  }

  return {
    kind: "committed",
    checkSucceeded,
  };
}

export type CheckpointExecutor<Message> = {
  execute(message: Message): Promise<string>;
};

export function withTurnCheckpoint<Message>(
  executor: CheckpointExecutor<Message>,
  checkpoint: () => Promise<CheckpointResult> = () =>
    checkpointWorkingDirectory(),
): CheckpointExecutor<Message> {
  return {
    async execute(message) {
      const response = await executor.execute(message);
      await checkpoint();
      return response;
    },
  };
}
