import assert from "node:assert/strict";
import test from "node:test";
import { discuss, resolveParticipants, type DiscussionGateway } from "../src/modules/discussion.ts";

test("routes a discussion in round-robin order with participant provenance", async () => {
  const selected: string[] = [];
  const sent: string[] = [];
  const messages = new Map([["One", "opening"], ["Two", "two reply"], ["Three", "three reply"]]);
  let current = "";
  let revision = 0;
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat(reference) { current = reference; selected.push(reference); },
    async assistantState() { return `${current}:${revision}`; },
    async latestAssistantMessage() { return messages.get(current); },
    async send(message) {
      sent.push(message);
      revision += 1;
      messages.set(current, `${current} reply ${sent.length}`);
    },
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await discuss(participants, gateway, { passes: 3, pollMilliseconds: 0 });

  assert.deepEqual(selected, ["One", "Two", "Three", "One"]);
  assert.match(sent[0], /You are participant-2\./);
  assert.match(sent[0], /Participants: participant-1, participant-2, participant-3/);
  assert.match(sent[0], /\n\n---\n\nparticipant-1 wrote:/);
  assert.doesNotMatch(sent[0], /One|Two|Three/);
  assert.match(sent[1], /participant-2 wrote:/);
  assert.match(sent[2], /participant-3 wrote:/);
  assert.match(sent[1], /participant-1 wrote:\nopening/);
  assert.match(sent[1], /participant-2 wrote:\nTwo reply 1/);
  assert.match(sent[2], /participant-2 wrote:\nTwo reply 1/);
  assert.match(sent[2], /participant-3 wrote:\nThree reply 2/);
  assert.doesNotMatch(sent[2], /participant-1 wrote:\nopening/);
});

test("requires unique participant titles to survive sidebar reordering", async () => {
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "Duplicate" }, { index: 2, title: "Duplicate" }]; },
    async selectChat() {},
    async assistantState() { return "state"; },
    async latestAssistantMessage() { return undefined; },
    async send() {},
  };
  await assert.rejects(() => resolveParticipants(["1", "2"], gateway), /unique chat titles/);
});

test("resolves discussion participants by exact chat title like switch", async () => {
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }]; },
    async selectChat() {},
    async assistantState() { return "state"; },
    async latestAssistantMessage() { return undefined; },
    async send() {},
  };
  const participants = await resolveParticipants(["one", "2"], gateway);
  assert.deepEqual(participants.map(({ id, name }) => ({ id, name })), [
    { id: "participant-1", name: "One" },
    { id: "participant-2", name: "Two" },
  ]);
});

test("a one-pass discussion sends without reading the recipient", async () => {
  let state = "before";
  let reads = 0;
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }]; },
    async selectChat() {},
    async assistantState() { return state; },
    async latestAssistantMessage() { reads += 1; return "opening"; },
    async send() { state = "after"; },
  };
  const participants = await resolveParticipants(["1", "2"], gateway);
  await discuss(participants, gateway, { passes: 1, pollMilliseconds: 0 });
  assert.equal(reads, 1);
});

test("waits for a new stable recipient reply instead of forwarding its previous reply", async () => {
  const sent: string[] = [];
  let current = "";
  let revision = 0;
  const replies = ["opening", "new reply"];
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat(reference) { current = reference; },
    async assistantState() { return `${current}:${revision}`; },
    async latestAssistantMessage() { return replies.shift(); },
    async send(message) { sent.push(message); revision += 1; },
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await discuss(participants, gateway, { passes: 2, pollMilliseconds: 0 });

  assert.match(sent[1], /participant-2 wrote:\nnew reply/);
  assert.equal(replies.length, 0, "the recipient is copied only after its new response control is ready");
});

test("waits for a stable response control after its transient accessibility state disappears", async () => {
  const sent: string[] = [];
  let stateReads = 0;
  const replies = ["opening", "new reply"];
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat() {},
    async assistantState() { return ["before", "changed", "before", "changed", "changed"][stateReads++] ?? "changed"; },
    async latestAssistantMessage() { return replies.shift(); },
    async send(message) { sent.push(message); },
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await discuss(participants, gateway, { passes: 2, pollMilliseconds: 0 });

  assert.match(sent[1], /participant-2 wrote:\nnew reply/);
});

test("retries a stable response control when the Copy control disappears before the single click", async () => {
  const sent: string[] = [];
  let stateReads = 0;
  const before = JSON.stringify({ copyControlCount: 1 });
  const ready = JSON.stringify({ copyControlCount: 1, latestCopyControlY: 900 });
  const replies = ["opening", undefined, "new reply"];
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat() {},
    async assistantState() { return [before, ready, ready, ready, ready][stateReads++] ?? ready; },
    async latestAssistantMessage() { return replies.shift(); },
    async send(message) { sent.push(message); },
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await discuss(participants, gateway, { passes: 2, pollMilliseconds: 0 });

  assert.match(sent[1], /participant-2 wrote:\nnew reply/);
});

test("requests at most one scroll while waiting for a participant response", async () => {
  let stateReads = 0;
  let scrolls = 0;
  const before = JSON.stringify({ copyControlCount: 1, scrollToBottomVisible: false });
  const ready = JSON.stringify({ copyControlCount: 1, scrollToBottomVisible: true });
  const replies = ["opening", "new reply"];
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat() {},
    async assistantState() { return [before, ready, ready, ready][stateReads++] ?? ready; },
    async scrollToBottom() { scrolls += 1; },
    async latestAssistantMessage() { return replies.shift(); },
    async send() {},
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await discuss(participants, gateway, { passes: 2, pollMilliseconds: 0 });

  assert.equal(scrolls, 1);
});

test("stops after a bounded number of unstable reply observations", async () => {
  let stateReads = 0;
  const gateway: DiscussionGateway = {
    async listChats() { return [{ index: 1, title: "One" }, { index: 2, title: "Two" }, { index: 3, title: "Three" }]; },
    async selectChat() {},
    async assistantState() { return stateReads++ === 0 ? "before" : `changed-${stateReads}`; },
    async latestAssistantMessage() { return "opening"; },
    async send() {},
  };
  const participants = await resolveParticipants(["1", "2", "3"], gateway);
  await assert.rejects(
    () => discuss(participants, gateway, { passes: 2, pollMilliseconds: 0, maxReplyObservations: 3 }),
    /Stopped waiting after 3 unstable reply-control observations/,
  );
});
