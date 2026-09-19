import { spawn } from "node:child_process";
import type { Block, MessagePart } from "../core/message.ts";
import type { MessageModule } from "../core/modules.ts";
import { executionEnvironment } from "../core/execution-context.ts";
import { hasShellDirective } from "../core/directives.ts";

export type CommandResult = {
  output: string;
  exitStatus: number;
  timedOut: boolean;
};

export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: Buffer;
};

const outputLimit = 64 * 1024;
const timeoutMilliseconds = 30_000;

export async function runShell(
  block: Block,
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void,
): Promise<CommandResult> {
  const prelude =
    block.language === "sh" ? "set -e" : "set -e\nset -o pipefail";
  const child = spawn(
    `/bin/${block.language}`,
    ["-c", `${prelude}\n${block.source}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: executionEnvironment(),
    },
  );
  const output: OutputChunk[] = [];
  let outputBytes = 0;
  let truncated = false;
  const capture = (chunk: Buffer, stream: OutputChunk["stream"]) => {
    const remaining = outputLimit - outputBytes;
    if (remaining > 0) {
      output.push({ stream, data: chunk.subarray(0, remaining) });
      outputBytes += Math.min(chunk.length, remaining);
    }
    truncated ||= chunk.length > remaining;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    capture(chunk, "stdout");
    onOutput?.(chunk, "stdout");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    capture(chunk, "stderr");
    onOutput?.(chunk, "stderr");
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMilliseconds);

  const exitStatus = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));

  const suffix = truncated
    ? `\n[output truncated at ${outputLimit} bytes]`
    : "";
  return { output: formatOutputChunks(output) + suffix, exitStatus, timedOut };
}

export function formatOutputChunks(chunks: OutputChunk[]): string {
  const rendered: Buffer[] = [];
  const stderrPrefix = Buffer.from("stderr: ");
  let stderrAtLineStart = true;

  for (const chunk of chunks) {
    if (chunk.stream === "stdout") {
      rendered.push(chunk.data);
      continue;
    }

    let start = 0;
    while (start < chunk.data.length) {
      if (stderrAtLineStart) rendered.push(stderrPrefix);
      const newline = chunk.data.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.data.length : newline + 1;
      rendered.push(chunk.data.subarray(start, end));
      stderrAtLineStart = newline !== -1;
      start = end;
    }
  }
  return Buffer.concat(rendered).toString("utf8");
}

const commandPreviewLimit = 300;

export function formatCommandPreview(source: string): string {
  if (source.length <= commandPreviewLimit) {
    return source;
  }

  return (
    source.slice(0, commandPreviewLimit).trimEnd() +
    `\n[command truncated; ${source.length} characters total]`
  );
}

export function formatResult(block: Block, result: CommandResult): string {
  const status = result.timedOut
    ? "timed out"
    : `exit status ${result.exitStatus}`;
  const command = formatCommandPreview(block.source);
  return `\`\`\`text\n${command}\n[${status}]\n${result.output}\n\`\`\``;
}

export function shellModule(): MessageModule {
  const handlesShell = (part: MessagePart): part is Block =>
    part.kind === "block" &&
    ["sh", "bash", "zsh"].includes(part.language) &&
    hasShellDirective(part.source);
  return {
    name: "shell",
    handles: handlesShell,
    async visit(part, context) {
      if (!handlesShell(part)) return undefined;
      context.onBlockStart(part);
      const result = await runShell(part, context.onOutput);
      context.onBlockFinish(part);
      return formatResult(part, result);
    },
  };
}
