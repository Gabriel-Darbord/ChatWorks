import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointWorkingDirectory,
  type CommandResult,
  type CommandRunner,
  withTurnCheckpoint,
} from "../src/core/checkpoint.ts";

function result(exitCode: number, stdout = "", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

test("skips checkpoint outside a Git repository", async () => {
  const calls: string[] = [];

  const run: CommandRunner = async (command, arguments_) => {
    calls.push([command, ...arguments_].join(" "));
    return result(128);
  };

  assert.deepEqual(await checkpointWorkingDirectory("/workspace", run), {
    kind: "not-git",
  });
  assert.deepEqual(calls, ["git rev-parse --is-inside-work-tree"]);
});

test("skips checkpoint when working tree is unchanged", async () => {
  const calls: string[] = [];

  const run: CommandRunner = async (command, arguments_) => {
    calls.push([command, ...arguments_].join(" "));

    if (arguments_[0] === "rev-parse") return result(0, "true\n");
    return result(0, "");
  };

  assert.deepEqual(await checkpointWorkingDirectory("/workspace", run), {
    kind: "unchanged",
  });

  assert.deepEqual(calls, [
    "git rev-parse --is-inside-work-tree",
    "git status --porcelain",
  ]);
});

test("commits a successful checked turn", async () => {
  const calls: string[] = [];

  const run: CommandRunner = async (command, arguments_) => {
    calls.push([command, ...arguments_].join(" "));

    if (arguments_[0] === "rev-parse") return result(0, "true\n");
    if (arguments_[0] === "status") return result(0, " M src/file.ts\n");
    return result(0);
  };

  assert.deepEqual(await checkpointWorkingDirectory("/workspace", run), {
    kind: "committed",
    checkSucceeded: true,
  });

  assert.deepEqual(calls, [
    "git rev-parse --is-inside-work-tree",
    "git status --porcelain",
    "npm run check",
    "git add -A",
    "git commit -m [success] ChatWorks turn",
  ]);
});

test("commits a failed check as a failure checkpoint", async () => {
  const calls: string[] = [];

  const run: CommandRunner = async (command, arguments_) => {
    calls.push([command, ...arguments_].join(" "));

    if (arguments_[0] === "rev-parse") return result(0, "true\n");
    if (arguments_[0] === "status") return result(0, " M broken.ts\n");
    if (command === "npm") return result(1, "", "check failed");
    return result(0);
  };

  assert.deepEqual(await checkpointWorkingDirectory("/workspace", run), {
    kind: "committed",
    checkSucceeded: false,
  });

  assert.equal(calls.at(-1), "git commit -m [failure] ChatWorks turn");
});

test("checkpoint runs after execution and preserves its response", async () => {
  const events: string[] = [];

  const executor = withTurnCheckpoint(
    {
      async execute() {
        events.push("execute");
        return "response";
      },
    },
    async () => {
      events.push("checkpoint");
      return {
        kind: "committed",
        checkSucceeded: true,
      };
    },
  );

  assert.equal(await executor.execute("message"), "response");
  assert.deepEqual(events, ["execute", "checkpoint"]);
});
