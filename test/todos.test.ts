import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatTodos, TodoStore } from "../src/core/todos.ts";

async function store(): Promise<TodoStore> {
  const directory = await mkdtemp(join(tmpdir(), "chatworks-todos-"));
  return new TodoStore(join(directory, ".chatworks"));
}

test("formats TODO state as a fenced block", () => {
  assert.equal(formatTodos([]), "No TODO items.");

  assert.equal(
    formatTodos([
      { id: 1, title: "First", done: false },
      { id: 2, title: "Second", done: true },
    ]),
    "```todo\n1. [ ] First\n2. [x] Second\n```",
  );
});

test("manages TODO lifecycle with stable monotonic ids", async () => {
  const todos = await store();

  await todos.add("First");
  await todos.add("Second");

  assert.deepEqual(await todos.list(), [
    { id: 1, title: "First", done: false },
    { id: 2, title: "Second", done: false },
  ]);

  await todos.done(1);
  await todos.edit(2, "Second updated");
  await todos.delete(1);
  await todos.add("Third");

  assert.deepEqual(await todos.list(), [
    { id: 2, title: "Second updated", done: false },
    { id: 3, title: "Third", done: false },
  ]);
});

test("reopens completed TODO", async () => {
  const todos = await store();
  await todos.add("Item");
  await todos.done(1);
  await todos.reopen(1);

  assert.deepEqual(await todos.list(), [{ id: 1, title: "Item", done: false }]);
});

test("rejects unknown TODO ids", async () => {
  const todos = await store();

  await assert.rejects(() => todos.done(42), /Could not find TODO '42'/);
  await assert.rejects(() => todos.delete(42), /Could not find TODO '42'/);
});
