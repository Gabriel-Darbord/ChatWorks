import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WatchTransactionStore,
  type WatchTransaction,
} from "../src/core/watch-transaction.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chatworks-watch-transaction-"));
}

test("persists and reads each watch transaction phase", async () => {
  const directory = await temporaryDirectory();

  try {
    const store = new WatchTransactionStore(directory);

    const transactions: WatchTransaction[] = [
      {
        messageIdentity: "message-1",
        phase: "executing",
      },
      {
        messageIdentity: "message-1",
        phase: "acknowledged",
      },
      {
        messageIdentity: "message-1",
        phase: "pending",
        response: "result",
      },
      {
        messageIdentity: "message-1",
        phase: "submission-failed",
        response: "result",
      },
    ];

    for (const transaction of transactions) {
      await store.write(transaction);
      assert.deepEqual(await store.read(), transaction);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clear removes the durable transaction", async () => {
  const directory = await temporaryDirectory();

  try {
    const store = new WatchTransactionStore(directory);

    await store.write({
      messageIdentity: "message-1",
      phase: "pending",
      response: "result",
    });

    await store.clear();

    assert.equal(await store.read(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses malformed durable transaction state", async () => {
  const directory = await temporaryDirectory();

  try {
    const store = new WatchTransactionStore(directory);

    await writeFile(store.path, "{bad json\n", "utf8");

    await assert.rejects(
      store.read(),
      /Could not parse ChatWorks watch transaction/,
    );

    assert.equal(await readFile(store.path, "utf8"), "{bad json\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses structurally invalid durable transaction state", async () => {
  const directory = await temporaryDirectory();

  try {
    const store = new WatchTransactionStore(directory);

    await writeFile(
      store.path,
      JSON.stringify({
        messageIdentity: "message-1",
        phase: "pending",
      }),
      "utf8",
    );

    await assert.rejects(store.read(), /watch transaction has invalid data/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discard acknowledges executing without preserving executable state", async () => {
  const { recoverTransactionAction } =
    await import("../src/core/watch-transaction.ts");

  assert.deepEqual(
    recoverTransactionAction(
      {
        messageIdentity: "message-1",
        phase: "executing",
      },
      "discard",
    ),
    {
      messageIdentity: "message-1",
      phase: "acknowledged",
    },
  );
});

test("discard acknowledges pending without preserving its response", async () => {
  const { recoverTransactionAction } =
    await import("../src/core/watch-transaction.ts");

  assert.deepEqual(
    recoverTransactionAction(
      {
        messageIdentity: "message-1",
        phase: "pending",
        response: "result",
      },
      "discard",
    ),
    {
      messageIdentity: "message-1",
      phase: "acknowledged",
    },
  );
});

test("discard acknowledges failed submission without preserving its response", async () => {
  const { recoverTransactionAction } =
    await import("../src/core/watch-transaction.ts");

  assert.deepEqual(
    recoverTransactionAction(
      {
        messageIdentity: "message-1",
        phase: "submission-failed",
        response: "result",
      },
      "discard",
    ),
    {
      messageIdentity: "message-1",
      phase: "acknowledged",
    },
  );
});

test("retry rearms only a failed submission", async () => {
  const { recoverTransactionAction } =
    await import("../src/core/watch-transaction.ts");

  assert.deepEqual(
    recoverTransactionAction(
      {
        messageIdentity: "message-1",
        phase: "submission-failed",
        response: "result",
      },
      "retry",
    ),
    {
      messageIdentity: "message-1",
      phase: "pending",
      response: "result",
    },
  );

  for (const transaction of [
    {
      messageIdentity: "message-1",
      phase: "executing" as const,
    },
    {
      messageIdentity: "message-1",
      phase: "acknowledged" as const,
    },
    {
      messageIdentity: "message-1",
      phase: "pending" as const,
      response: "result",
    },
  ]) {
    assert.throws(
      () => recoverTransactionAction(transaction, "retry"),
      /Cannot retry/,
    );
  }
});

test("cannot discard an already acknowledged transaction", async () => {
  const { recoverTransactionAction } =
    await import("../src/core/watch-transaction.ts");

  assert.throws(
    () =>
      recoverTransactionAction(
        {
          messageIdentity: "message-1",
          phase: "acknowledged",
        },
        "discard",
      ),
    /already acknowledged/,
  );
});
