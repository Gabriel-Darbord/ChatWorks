import type { AssistantObservation } from "./assistant-observation.ts";
import type { Message } from "./message.ts";
import type { SubmissionStatus } from "./submission.ts";

export type OnceExecutor = {
  execute(message: Message): Promise<string>;
};

export type OnceSubmitter = {
  submit(response: string): Promise<SubmissionStatus>;
};

export type OnceResult =
  | { kind: "not-assistant" }
  | { kind: "no-output" }
  | { kind: "submitted" }
  | {
      kind: "not-submitted";
      status: Exclude<SubmissionStatus, "submitted">;
    };

export async function runOnce(
  observation: AssistantObservation,
  executor: OnceExecutor,
  submitter: OnceSubmitter,
): Promise<OnceResult> {
  if (observation.latestMessageRole !== "assistant") {
    return { kind: "not-assistant" };
  }

  const response = await executor.execute(observation.message);
  if (!response) return { kind: "no-output" };

  const status = await submitter.submit(response);
  return status === "submitted"
    ? { kind: "submitted" }
    : { kind: "not-submitted", status };
}
