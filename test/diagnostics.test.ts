import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  diagnosticEvent,
  errorDiagnostic,
  logDebug,
  logEvent,
} from "../src/core/diagnostics.ts";

test("projects structured diagnostic events without message bodies", () => {
  const event = diagnosticEvent("bridge", "completed", {
    correlationId: "bridge-1",
    fields: { command: "assistant-observation", durationMs: 42, exitCode: 0 },
  });

  assert.equal(event.source, "bridge");
  assert.equal(event.event, "completed");
  assert.equal(event.correlationId, "bridge-1");
  assert.deepEqual(event.fields, {
    command: "assistant-observation",
    durationMs: 42,
    exitCode: 0,
  });
  assert.match(event.timestamp, /^\d{4}-\d\d-\d\dT/);
});

test("writes structured events to the configured persistent log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-diagnostics-"));
  const path = join(directory, "events.jsonl");
  const previousPath = process.env.CHATWORKS_EVENT_LOG;
  process.env.CHATWORKS_EVENT_LOG = path;

  try {
    await logEvent("bridge", "completed", {
      correlationId: "bridge-1",
      fields: { command: "composer-state", stderr: "AX transition detail" },
    });
    const records = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(records.length, 1);
    assert.deepEqual(JSON.parse(records[0]), {
      timestamp: JSON.parse(records[0]).timestamp,
      source: "bridge",
      event: "completed",
      correlationId: "bridge-1",
      fields: { command: "composer-state", stderr: "AX transition detail" },
    });
  } finally {
    if (previousPath === undefined) delete process.env.CHATWORKS_EVENT_LOG;
    else process.env.CHATWORKS_EVENT_LOG = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes debug events only when explicitly enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-debug-"));
  const path = join(directory, "events.jsonl");
  const previousPath = process.env.CHATWORKS_EVENT_LOG;
  const previousDebug = process.env.CHATWORKS_DEBUG;
  process.env.CHATWORKS_EVENT_LOG = path;

  try {
    delete process.env.CHATWORKS_DEBUG;
    await logDebug("provider", "payload", { fields: { body: "secret" } });
    await assert.rejects(readFile(path, "utf8"));

    process.env.CHATWORKS_DEBUG = "true";
    await logDebug("provider", "payload", { fields: { body: "visible" } });
    const text = await readFile(path, "utf8");
    assert.match(text, /visible/);
  } finally {
    if (previousPath === undefined) delete process.env.CHATWORKS_EVENT_LOG;
    else process.env.CHATWORKS_EVENT_LOG = previousPath;
    if (previousDebug === undefined) delete process.env.CHATWORKS_DEBUG;
    else process.env.CHATWORKS_DEBUG = previousDebug;
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects errors into persistent diagnostic records", () => {
  const diagnostic = errorDiagnostic(
    "watch",
    new Error("Could not find an editable ChatGPT input."),
  );

  assert.equal(diagnostic.operation, "watch");
  assert.equal(diagnostic.name, "Error");
  assert.equal(diagnostic.message, "Could not find an editable ChatGPT input.");
  assert.match(diagnostic.timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.match(
    diagnostic.stack ?? "",
    /Could not find an editable ChatGPT input/,
  );
});

test("projects non-Error failures into diagnostic records", () => {
  const diagnostic = errorDiagnostic("watch", "opaque failure");

  assert.equal(diagnostic.operation, "watch");
  assert.equal(diagnostic.message, "opaque failure");
});
