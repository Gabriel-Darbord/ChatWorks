import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExecutionAllowed,
  executionEnvironment,
  isExecutionActive,
  RecursiveExecutionError,
} from "../src/core/execution-context.ts";

test("marks child execution without mutating the parent environment", () => {
  const parent: NodeJS.ProcessEnv = { EXISTING: "value" };
  const child = executionEnvironment(parent);

  assert.equal(parent.CHATWORKS_EXECUTION_ACTIVE, undefined);
  assert.equal(child.CHATWORKS_EXECUTION_ACTIVE, "1");
  assert.equal(child.EXISTING, "value");
});

test("recognizes active ChatWorks execution", () => {
  assert.equal(isExecutionActive({ CHATWORKS_EXECUTION_ACTIVE: "1" }), true);
  assert.equal(isExecutionActive({}), false);
});

test("refuses recursive execution", () => {
  assert.throws(
    () => assertExecutionAllowed({ CHATWORKS_EXECUTION_ACTIVE: "1" }),
    RecursiveExecutionError,
  );

  assert.doesNotThrow(() => assertExecutionAllowed({}));
});
