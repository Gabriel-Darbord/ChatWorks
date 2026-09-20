export type DiscussionReferenceMode = "chats" | "participants";

export type DiscussionRequest = {
  referenceMode: DiscussionReferenceMode;
  references: string[];
  passes?: number;
  turns?: number;
};

function positiveIntegerOption(option: string, value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} accepts a positive integer.`);
  }

  return parsed;
}

export function parseDiscussionRequest(
  arguments_: string[],
): DiscussionRequest {
  let referenceMode: DiscussionReferenceMode = "chats";
  let participantModeSpecified = false;
  let passes: number | undefined;
  let turns: number | undefined;
  const references: string[] = [];

  for (const argument of arguments_) {
    if (argument === "--participants") {
      if (participantModeSpecified)
        throw new Error("--participants may be specified only once.");

      participantModeSpecified = true;
      referenceMode = "participants";
      continue;
    }

    if (argument === "--pass" || argument.startsWith("--pass=")) {
      if (passes !== undefined)
        throw new Error("--pass may be specified only once.");

      passes =
        argument === "--pass"
          ? 1
          : positiveIntegerOption("--pass", argument.slice("--pass=".length));
      continue;
    }

    if (argument === "--turn" || argument.startsWith("--turn=")) {
      if (turns !== undefined)
        throw new Error("--turn may be specified only once.");

      turns =
        argument === "--turn"
          ? 1
          : positiveIntegerOption("--turn", argument.slice("--turn=".length));
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown discussion option '${argument}'.`);
    }

    references.push(argument);
  }

  if (turns !== undefined && passes !== undefined)
    throw new Error("Use either --turn or --pass, not both.");

  if (references.length < 2)
    throw new Error("A discussion requires at least two participants.");

  return {
    referenceMode,
    references,
    ...(passes !== undefined ? { passes } : {}),
    ...(turns !== undefined ? { turns } : {}),
  };
}
