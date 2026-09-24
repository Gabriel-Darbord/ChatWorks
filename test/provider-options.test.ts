import assert from "node:assert/strict";
import test from "node:test";

import { parseProviderOptions } from "../src/providers/provider-options.ts";

test("defaults to the current chat and local provider port", () => {
  assert.deepEqual(parseProviderOptions([]), {
    chat: "current",
    port: 32_123,
  });
});

test("accepts an exact chat title and explicit local port", () => {
  assert.deepEqual(
    parseProviderOptions(["--chat", "ChatWorks provider", "--port", "32124"]),
    { chat: "ChatWorks provider", port: 32_124 },
  );
});

test("accepts an explicit current chat", () => {
  assert.deepEqual(parseProviderOptions(["--chat", "current"]), {
    chat: "current",
    port: 32_123,
  });
});

test("rejects malformed and duplicate provider options", () => {
  assert.throws(
    () => parseProviderOptions(["--chat"]),
    /requires an exact title or 'current'/,
  );
  assert.throws(
    () => parseProviderOptions(["--chat", "one", "--chat", "two"]),
    /only once/,
  );
  assert.throws(
    () => parseProviderOptions(["--port", "0"]),
    /integer from 1 to 65535/,
  );
  assert.throws(
    () => parseProviderOptions(["--port", "32123", "--port", "32124"]),
    /only once/,
  );
  assert.throws(
    () => parseProviderOptions(["serve"]),
    /Unknown provider option: serve/,
  );
});
