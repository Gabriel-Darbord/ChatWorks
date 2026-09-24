import assert from "node:assert/strict";
import test from "node:test";

import {
  presentOpenCodeTool,
  restoreOpenCodeToolInput,
} from "../src/providers/opencode-tool-adapter.ts";

test("presents OpenCode task input with provider-neutral mode naming", () => {
  const tool = presentOpenCodeTool({
    name: "task",
    input: {
      required: ["subagent_type"],
      schema: {
        type: "object",
        required: ["subagent_type"],
        properties: {
          subagent_type: { type: "string" },
        },
      },
    },
  });

  assert.match(
    tool.description ?? "",
    /Continue a complex, multistep task autonomously/,
  );
  assert.deepEqual(tool.input?.required, ["mode"]);
  assert.deepEqual(tool.input?.schema?.required, ["mode"]);
  assert.equal(
    (tool.input?.schema?.properties as Record<string, unknown>).subagent_type,
    undefined,
  );
  assert.ok(
    "mode" in (tool.input?.schema?.properties as Record<string, unknown>),
  );
  assert.deepEqual(
    (tool.input?.schema?.properties as Record<string, unknown>).mode,
    {
      type: "string",
      description: "The mode to use for this autonomous iteration",
    },
  );
});

test("restores provider-neutral task mode to OpenCode input", () => {
  assert.deepEqual(restoreOpenCodeToolInput("task", { mode: "explore" }), {
    subagent_type: "explore",
  });
});
