import assert from "node:assert/strict";
import test from "node:test";
import { formatCommandTranscript, formatOutputChunks, formatResult, runShell, shellModule } from "../src/modules/shell.ts";

test("runs a declared shell block and formats its output", async () => {
  const block = { kind: "block" as const, language: "sh", source: "printf works" };
  const result = await runShell(block);
  assert.deepEqual(result, { output: "works", exitStatus: 0, timedOut: false });
  assert.equal(formatResult(block, result), "```text\nprintf works\n[exit status 0]\nworks\n```");
});

test("stops a shell block at its first failed command", async () => {
  const result = await runShell({ kind: "block", language: "zsh", source: "false\necho unreachable" });
  assert.deepEqual(result, { output: "", exitStatus: 1, timedOut: false });
});

test("uses pipefail for bash and zsh blocks", async () => {
  const result = await runShell({ kind: "block", language: "bash", source: "false | true\necho unreachable" });
  assert.deepEqual(result, { output: "", exitStatus: 1, timedOut: false });
});

test("shell module handles only configured shell block languages", () => {
  const module = shellModule();
  assert.equal(module.handles({ kind: "plain-text", text: "hello" }), false);
  assert.equal(module.handles({ kind: "block", language: "mcp", source: "{}" }), false);
  assert.equal(module.handles({ kind: "block", language: "zsh", source: "true" }), true);
});

test("includes every command line before its result", () => {
  const block = { kind: "block" as const, language: "sh", source: "pwd\nprintf done" };
  const result = { output: "/tmp\ndone", exitStatus: 0, timedOut: false };
  assert.equal(formatResult(block, result), "```text\npwd\nprintf done\n[exit status 0]\n/tmp\ndone\n```");
});

test("compacts complete heredoc bodies in command transcripts", () => {
  const source = "cat > src/index.ts <<'EOF'\nexport const answer = 42;\nconsole.log(answer);\nEOF\nnpm run start";
  assert.equal(
    formatCommandTranscript(source),
    "cat > src/index.ts <<'EOF'\n[2 lines]\nEOF\nnpm run start",
  );
});

test("keeps an incomplete heredoc visible in a command transcript", () => {
  const source = "cat > src/index.ts <<'EOF'\nexport const answer = 42;";
  assert.equal(formatCommandTranscript(source), "cat > src/index.ts <<'EOF'\nexport const answer = 42;");
});

test("preserves observed output order and annotates stderr lines", () => {
  const output = formatOutputChunks([
    { stream: "stdout", data: Buffer.from("first\n") },
    { stream: "stderr", data: Buffer.from("problem\n") },
    { stream: "stdout", data: Buffer.from("last\n") },
    { stream: "stderr", data: Buffer.from("another problem\n") },
  ]);
  assert.equal(output, "first\nstderr: problem\nlast\nstderr: another problem\n");
});
