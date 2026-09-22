import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenCodeServeOptions } from "../src/providers/opencode-serve.ts";

test("requires an exact Classic chat title and defaults the local port", () => {
  assert.deepEqual(
    parseOpenCodeServeOptions(["--chat", "ChatWorks provider"]),
    {
      chat: "ChatWorks provider",
      port: 32_123,
    },
  );
});

test("accepts an explicit local port", () => {
  assert.deepEqual(
    parseOpenCodeServeOptions([
      "--chat",
      "ChatWorks provider",
      "--port",
      "32124",
    ]),
    { chat: "ChatWorks provider", port: 32_124 },
  );
});

test("rejects missing chat selection and invalid ports", () => {
  assert.throws(() => parseOpenCodeServeOptions([]), /requires --chat/);
  assert.throws(
    () => parseOpenCodeServeOptions(["--chat", "Provider", "--port", "0"]),
    /integer from 1 to 65535/,
  );
});
