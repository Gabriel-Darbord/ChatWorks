import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWatchInstance,
  WatchAlreadyRunningError,
} from "../src/core/watch-instance.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chatworks-watch-instance-"));
}

test("acquires and releases watch ownership", async () => {
  const directory = await temporaryDirectory();

  try {
    const instance = await acquireWatchInstance(directory);

    const owner = JSON.parse(
      await readFile(join(directory, "watch.lock", "owner.json"), "utf8"),
    ) as { pid: number };

    assert.equal(owner.pid, process.pid);

    await instance.release();

    await assert.rejects(
      readFile(join(directory, "watch.lock", "owner.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a second live owner", async () => {
  const directory = await temporaryDirectory();

  try {
    const first = await acquireWatchInstance(directory);

    await assert.rejects(
      acquireWatchInstance(directory),
      (error: unknown) =>
        error instanceof WatchAlreadyRunningError &&
        error.owner.pid === process.pid,
    );

    await first.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses malformed ownership instead of deleting it", async () => {
  const directory = await temporaryDirectory();
  const lock = join(directory, "watch.lock");

  try {
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), "{bad json\n", "utf8");

    await assert.rejects(
      acquireWatchInstance(directory),
      /Could not read ChatWorks watch ownership/,
    );

    assert.equal(
      await readFile(join(lock, "owner.json"), "utf8"),
      "{bad json\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
