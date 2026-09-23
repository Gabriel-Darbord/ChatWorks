import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AssistantObservation } from "../src/core/assistant-observation.ts";
import { parseMessage } from "../src/core/message.ts";
import {
  classicProviderGateway,
  type ClassicProviderOperations,
} from "../src/providers/classic-gateway.ts";

function observation(
  text: string,
  role: "user" | "assistant" = "assistant",
): AssistantObservation {
  return { latestMessageRole: role, message: parseMessage(text) };
}

function operations(
  observations: Array<AssistantObservation | undefined>,
  availability: boolean[] = [],
): { operations: ClassicProviderOperations; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    operations: {
      async observeAssistant() {
        return observations.shift();
      },
      async composerAvailable() {
        return availability.shift() ?? true;
      },
      async submit(prompt) {
        prompts.push(prompt);
        return "submitted";
      },
      async wait() {},
    },
  };
}

test("returns only a new, stable Classic assistant response", async () => {
  const fixture = operations([
    observation("Old response"),
    observation("Old response"),
    observation("New response"),
    observation("New response"),
  ]);
  const gateway = classicProviderGateway(fixture.operations, {
    pollMilliseconds: 0,
    timeoutMilliseconds: 100,
  });

  const result = await gateway.sendAndRead("Provider prompt");

  assert.equal(fixture.prompts[0], "Provider prompt");
  assert.equal(result.raw, "New response");
});

test("waits for the composer before accepting a stable reply", async () => {
  const fixture = operations(
    [
      observation("Old response"),
      observation("New response"),
      observation("New response"),
      observation("New response"),
    ],
    [false, true, true],
  );
  const gateway = classicProviderGateway(fixture.operations, {
    pollMilliseconds: 0,
    timeoutMilliseconds: 100,
  });

  const result = await gateway.sendAndRead("Provider prompt");

  assert.equal(result.raw, "New response");
});

test("debug trace records Classic observations through acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-classic-debug-"));
  const path = join(directory, "events.jsonl");
  const previousPath = process.env.CHATWORKS_EVENT_LOG;
  const previousDebug = process.env.CHATWORKS_DEBUG;
  process.env.CHATWORKS_EVENT_LOG = path;
  process.env.CHATWORKS_DEBUG = "1";

  try {
    const fixture = operations([
      observation("Old response"),
      observation("New response"),
      observation("New response"),
    ]);
    const gateway = classicProviderGateway(fixture.operations, {
      pollMilliseconds: 0,
      timeoutMilliseconds: 100,
    });

    await gateway.sendAndRead("Provider prompt", "provider-7");

    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      [
        "pre-submit-observation",
        "submission",
        "observation",
        "composer-state",
        "observation",
        "composer-state",
        "accepted",
      ],
    );
    assert.ok(events.every((event) => event.correlationId === "provider-7"));
    assert.equal(events.at(-1).fields.message, "New response");
  } finally {
    if (previousPath === undefined) delete process.env.CHATWORKS_EVENT_LOG;
    else process.env.CHATWORKS_EVENT_LOG = previousPath;
    if (previousDebug === undefined) delete process.env.CHATWORKS_DEBUG;
    else process.env.CHATWORKS_DEBUG = previousDebug;
    await rm(directory, { recursive: true, force: true });
  }
});

test("surfaces a busy composer without waiting for a response", async () => {
  const fixture = operations([observation("Old response")]);
  fixture.operations.submit = async () => "busy";
  const gateway = classicProviderGateway(fixture.operations, {
    pollMilliseconds: 0,
    timeoutMilliseconds: 100,
  });

  await assert.rejects(
    gateway.sendAndRead("Provider prompt"),
    /composer is busy/,
  );
});
