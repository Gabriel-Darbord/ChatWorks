import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForParticipantInitialResponse,
  type ParticipantResponseGateway,
} from "../src/core/participant-response.ts";
import { parseMessage } from "../src/core/message.ts";

function observation(role: "user" | "assistant", text: string) {
  return {
    latestMessageRole: role,
    message: parseMessage(text),
  };
}

function gateway(
  observations: Array<{
    role: "user" | "assistant";
    text: string;
    available: boolean;
  }>,
): ParticipantResponseGateway {
  let index = 0;
  let current = observations[0];

  return {
    async observeAssistant() {
      current = observations[Math.min(index, observations.length - 1)];
      index += 1;
      return observation(current.role, current.text);
    },

    async composerAvailable() {
      return current.available;
    },
  };
}

test("waits through the initialization user turn", async () => {
  await waitForParticipantInitialResponse(
    gateway([
      { role: "user", text: "", available: false },
      { role: "assistant", text: "ready", available: true },
      { role: "assistant", text: "ready", available: true },
    ]),
    { pollMilliseconds: 0, timeoutMilliseconds: 100 },
  );
});

test("waits while the assistant response changes", async () => {
  await waitForParticipantInitialResponse(
    gateway([
      { role: "assistant", text: "r", available: false },
      { role: "assistant", text: "re", available: false },
      { role: "assistant", text: "ready", available: true },
      { role: "assistant", text: "ready", available: true },
    ]),
    { pollMilliseconds: 0, timeoutMilliseconds: 100 },
  );
});

test("requires composer availability", async () => {
  let observations = 0;

  await waitForParticipantInitialResponse(
    {
      async observeAssistant() {
        observations += 1;
        return observation("assistant", "ready");
      },
      async composerAvailable() {
        return observations >= 3;
      },
    },
    { pollMilliseconds: 0, timeoutMilliseconds: 100 },
  );

  assert.ok(observations >= 3);
});

test("times out without a completed assistant response", async () => {
  await assert.rejects(
    () =>
      waitForParticipantInitialResponse(
        gateway([{ role: "user", text: "", available: false }]),
        { pollMilliseconds: 0, timeoutMilliseconds: 5 },
      ),
    /Timed out waiting for the participant's initial assistant response/,
  );
});
