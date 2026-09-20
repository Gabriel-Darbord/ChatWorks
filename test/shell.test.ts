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
  assert.deepEqual(result, {
    output: "works",
    exitStatus: 0,
    signal: null,
    timedOut: false,
  });
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
  assert.deepEqual(result, {
    output: "",
    exitStatus: 1,
    signal: null,
    timedOut: false,
  });
});

test("uses pipefail for bash and zsh blocks", async () => {
  const result = await runShell({
    kind: "block",
    language: "bash",
    source: "false | true\necho unreachable",
  });
  assert.deepEqual(result, {
    output: "",
    exitStatus: 1,
    signal: null,
    timedOut: false,
  });
});

test("shell module requires an explicit ChatWorks shebang", () => {
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
      source: "#!chatworks\npwd",
    }),
    true,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "zsh",
      source: "#!chatworks\npwd",
    }),
    true,
  );

  assert.equal(
    module.handles({
      kind: "block",
      language: "python",
      source: "#!chatworks\nprint(1)",
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
    output: "first\nsecond\n",
    exitStatus: 0,
    signal: null,
    timedOut: false,
  });

  assert.equal(
    rendered,
    "```text\nprintf first\nprintf second\n[exit status 0]\nfirst\nsecond\n```",
  );
});

test("adds exactly one newline before the closing fence when output has none", () => {
  const block: Block = {
    kind: "block",
    language: "bash",
    source: "printf result",
  };

  const rendered = formatResult(block, {
    output: "result",
    exitStatus: 0,
    signal: null,
    timedOut: false,
  });

  assert.equal(
    rendered,
    "```text\nprintf result\n[exit status 0]\nresult\n```",
  );
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
    signal: null,
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

test("consumes the ChatWorks shebang before execution and rendering", async () => {
  const module = shellModule();
  const part: Block = {
    kind: "block",
    language: "bash",
    source: "#!chatworks\nprintf works",
  };

  assert.equal(module.handles(part), true);

  const responses: string[] = [];
  const response = await module.visit(part, {
    scope: {},
    onBlockStart(block) {
      assert.equal(block.source, "printf works");
    },
    onBlockFinish(block) {
      assert.equal(block.source, "printf works");
    },
    onOutput() {},
  });

  if (response) responses.push(response);

  assert.equal(responses.length, 1);
  assert.match(responses[0], /^```text\nprintf works\n/);
  assert.ok(!responses[0].includes("#!chatworks"));
});

test("reports signal termination separately from exit status", async () => {
  const result = await runShell(
    {
      kind: "block",
      language: "sh",
      source: "kill -TERM $$",
    },
    undefined,
    { timeoutMilliseconds: 1_000 },
  );

  assert.equal(result.exitStatus, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("timeout terminates the shell process group", async () => {
  const started = Date.now();

  const result = await runShell(
    {
      kind: "block",
      language: "sh",
      source: "sleep 10 &\nwait",
    },
    undefined,
    {
      timeoutMilliseconds: 50,
      terminationGraceMilliseconds: 50,
    },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.exitStatus, null);
  assert.equal(result.signal, "SIGTERM");
  assert.ok(
    Date.now() - started < 2_000,
    "runShell should not wait for the surviving sleep process",
  );
});

test("timeout escalates when the shell process group ignores SIGTERM", async () => {
  const started = Date.now();

  const result = await runShell(
    {
      kind: "block",
      language: "sh",
      source: "trap '' TERM\nsleep 10 &\nwait",
    },
    undefined,
    {
      timeoutMilliseconds: 50,
      terminationGraceMilliseconds: 50,
    },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.exitStatus, null);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(
    Date.now() - started < 2_000,
    "runShell should escalate rather than wait for the process tree",
  );
});

test("supports a configurable captured-output limit", async () => {
  const result = await runShell(
    {
      kind: "block",
      language: "sh",
      source: "printf 1234567890",
    },
    undefined,
    { outputLimit: 5 },
  );

  assert.equal(result.output, "12345\n[output truncated at 5 bytes]");
});

test("executes bash commands after installing shell options", async () => {
  const result = await runShell({
    kind: "block",
    language: "bash",
    source: "printf works",
  });

  assert.deepEqual(result, {
    output: "works",
    exitStatus: 0,
    signal: null,
    timedOut: false,
  });
});
