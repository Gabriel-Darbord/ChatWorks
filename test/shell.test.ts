import assert from "node:assert/strict";
import test from "node:test";
import type { Block } from "../src/core/message.ts";
import {
  formatCommandPreview,
  formatOutputChunks,
  formatResult,
  runShell,
  shellModule,
} from "../src/modules/shell.ts";

test("runs a declared shell block and formats its output", async () => {
  const block = {
    kind: "block" as const,
    language: "sh",
    source: "printf works",
  };
  const result = await runShell(block);
  assert.deepEqual(result, { output: "works", exitStatus: 0, timedOut: false });
  assert.equal(
    formatResult(block, result),
    "```text\nprintf works\n[exit status 0]\nworks\n```",
  );
});

test("stops a shell block at its first failed command", async () => {
  const result = await runShell({
    kind: "block",
    language: "zsh",
    source: "false\necho unreachable",
  });
  assert.deepEqual(result, { output: "", exitStatus: 1, timedOut: false });
});

test("uses pipefail for bash and zsh blocks", async () => {
  const result = await runShell({
    kind: "block",
    language: "bash",
    source: "false | true\necho unreachable",
  });
  assert.deepEqual(result, { output: "", exitStatus: 1, timedOut: false });
});

test("shell module requires an explicit source-level ChatWorks directive", () => {
  const module = shellModule();

  assert.equal(
    module.handles({
      kind: "block",
      language: "bash",
      source: "pwd",
    }),
    false,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "bash",
      source: "# chatworks:shell\npwd",
    }),
    true,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "zsh",
      source: "# chatworks:shell\npwd",
    }),
    true,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "python",
      source: "# chatworks:shell\nprint(1)",
    }),
    false,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "bash",
      source: "# chatworks:other\npwd",
    }),
    false,
  );

  // Markdown metadata alone is deliberately insufficient because the
  // production AX representation does not preserve it.
  assert.equal(
    module.handles({
      kind: "block",
      language: "bash",
      metadata: "chatworks=shell",
      source: "pwd",
    }),
    false,
  );
});

test("includes a short command in full before its result", () => {
  const block: Block = {
    kind: "block",
    language: "bash",
    source: "printf first\nprintf second",
  };

  const rendered = formatResult(block, {
    output: "first\\nsecond\\n",
    exitStatus: 0,
    timedOut: false,
  });

  assert.ok(rendered.includes("printf first\nprintf second"));
  assert.match(rendered, /\[exit status 0\]/);
});

test("truncates long command input while retaining its size", () => {
  const source = "printf x\\n" + "a".repeat(1_000);
  const block: Block = {
    kind: "block",
    language: "bash",
    source,
  };

  const rendered = formatResult(block, {
    output: "result\\n",
    exitStatus: 0,
    timedOut: false,
  });

  assert.ok(rendered.includes(source.slice(0, 250)));
  assert.ok(!rendered.includes(source));
  assert.match(
    rendered,
    new RegExp(
      `\\\\[command truncated; ${source.length} characters total\\\\]`,
    ),
  );
  assert.match(rendered, /result/);
});

test("preserves observed output order and annotates stderr lines", () => {
  const output = formatOutputChunks([
    { stream: "stdout", data: Buffer.from("first\n") },
    { stream: "stderr", data: Buffer.from("problem\n") },
    { stream: "stdout", data: Buffer.from("last\n") },
    { stream: "stderr", data: Buffer.from("another problem\n") },
  ]);
  assert.equal(
    output,
    "first\nstderr: problem\nlast\nstderr: another problem\n",
  );
});
