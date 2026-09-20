import type { ExecutionScope } from "./execution-scope.ts";
import {
  resolveParticipant,
  type ParticipantResolutionGateway,
} from "./participants.ts";

export type ParticipantExecutionGateway = ParticipantResolutionGateway & {
  selectChat(reference: string): Promise<void>;
};

export async function participantExecutionScope(
  participantId: string | undefined,
  gateway: ParticipantExecutionGateway,
): Promise<ExecutionScope> {
  if (participantId === undefined) return {};

  const participant = await resolveParticipant(participantId, gateway);
  await gateway.selectChat(participant.chat.title);

  return { self: participant };
}
