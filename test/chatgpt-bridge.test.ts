import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssistantState } from "../src/adapters/chatgpt-bridge.ts";

test("normalizes assistant-state JSON independently of Swift key order", () => {
  const first = normalizeAssistantState('{"latestCopyControlY":866,"copyControlCount":1,"responseHeadingCount":4}');
  const second = normalizeAssistantState('{"responseHeadingCount":4,"copyControlCount":1,"latestCopyControlY":866}');
  assert.equal(first, second);
  assert.equal(first, '{"copyControlCount":1,"latestCopyControlY":866,"responseHeadingCount":4,"scrollToBottomVisible":false}');
});
