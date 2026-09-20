import { spawn } from "node:child_process";
import type { Block, MessagePart } from "../core/message.ts";
import type { MessageModule } from "../core/modules.ts";
import { executionEnvironment } from "../core/execution-context.ts";
import { chatWorksDirective } from "../core/directives.ts";

export type CommandResult = {
  output: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

export type ShellExecutionOptions = {
  timeoutMilliseconds?: number;
  terminationGraceMilliseconds?: number;
  outputLimit?: number;
};

export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: Buffer;
};

const defaultOutputLimit = 64 * 1024;
const defaultTimeoutMilliseconds = 30_000;
const defaultTerminationGraceMilliseconds = 1_000;

export async function runShell(
  block: Block,
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void,
  options: ShellExecutionOptions = {},
): Promise<CommandResult> {
  const outputLimit = options.outputLimit ?? defaultOutputLimit;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  const terminationGraceMilliseconds =
    options.terminationGraceMilliseconds ?? defaultTerminationGraceMilliseconds;

  const prelude =
    block.language === "sh" ? "set -e" : "set -e\nset -o pipefail";

  // A detached POSIX child becomes the leader of a new process group. This
  // lets timeout handling terminate the complete script process tree rather
  // than only the shell process.
  const child = spawn(
    `/bin/${block.language}`,
    ["-c", `${prelude}\n${block.source}`],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: executionEnvironment(),
      detached: true,
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
  let escalation: NodeJS.Timeout | undefined;

  const signalProcessGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;

    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH means the process group disappeared between our observation and
      // the signal. That is already the state we wanted.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        throw error;
      }
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessGroup("SIGTERM");

    escalation = setTimeout(() => {
      signalProcessGroup("SIGKILL");
    }, terminationGraceMilliseconds);
  }, timeoutMilliseconds);

  const termination = await new Promise<{
    exitStatus: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        exitStatus: code,
        signal,
      });
    });
  }).finally(() => {
    clearTimeout(timeout);
    if (escalation !== undefined) clearTimeout(escalation);
  });

  const suffix = truncated
    ? `\n[output truncated at ${outputLimit} bytes]`
    : "";

  return {
    output: formatOutputChunks(output) + suffix,
    exitStatus: termination.exitStatus,
    signal: termination.signal,
    timedOut,
  };
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
    ? result.signal
      ? `timed out; terminated by ${result.signal}`
      : "timed out"
    : result.signal
      ? `terminated by ${result.signal}`
      : `exit status ${result.exitStatus}`;
  const command = formatCommandPreview(block.source);
  const output = result.output.endsWith("\n")
    ? result.output
    : result.output + "\n";
  return `\`\`\`text\n${command}\n[${status}]\n${output}\`\`\``;
}

export function shellModule(): MessageModule {
  const handlesShell = (part: MessagePart): part is Block =>
    part.kind === "block" &&
    ["sh", "bash", "zsh"].includes(part.language) &&
    chatWorksDirective(part.source) !== undefined;

  return {
    name: "shell",
    handles: handlesShell,
    async visit(part, context) {
      if (!handlesShell(part)) return undefined;

      const directive = chatWorksDirective(part.source);
      if (!directive) return undefined;

      const executable: Block = {
        ...part,
        source: directive.source,
      };

      if (directive.mode === "skip") {
        return undefined;
      }

      context.onBlockStart(executable);
      try {
        const result = await runShell(executable, context.onOutput);
        return directive.mode === "silent"
          ? undefined
          : formatResult(executable, result);
      } finally {
        context.onBlockFinish(executable);
      }
    },
  };
}
