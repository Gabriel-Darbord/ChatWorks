import assert from "node:assert/strict";
import test from "node:test";

import { parseProviderServeOptions } from "../src/providers/provider-serve.ts";

test("requires an exact Classic chat title and defaults the local port", () => {
  assert.deepEqual(
    parseProviderServeOptions(["--chat", "ChatWorks provider"]),
    {
      chat: "ChatWorks provider",
      port: 32_123,
    },
  );
});

test("accepts an explicit local port", () => {
  assert.deepEqual(
    parseProviderServeOptions([
      "--chat",
      "ChatWorks provider",
      "--port",
      "32124",
    ]),
    { chat: "ChatWorks provider", port: 32_124 },
  );
});

test("rejects missing chat selection and invalid ports", () => {
  assert.throws(() => parseProviderServeOptions([]), /requires --chat/);
  assert.throws(
    () => parseProviderServeOptions(["--chat", "Provider", "--port", "0"]),
    /integer from 1 to 65535/,
  );
});
