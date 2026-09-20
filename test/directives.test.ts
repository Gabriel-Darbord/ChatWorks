import assert from "node:assert/strict";
import test from "node:test";
import { chatWorksDirective } from "../src/core/directives.ts";

test("consumes an explicit ChatWorks shebang", () => {
  assert.deepEqual(chatWorksDirective("#!chatworks\nprintf works"), {
    source: "printf works",
  });
});

test("accepts surrounding whitespace on the shebang", () => {
  assert.deepEqual(chatWorksDirective("  #!chatworks  \nprintf works"), {
    source: "printf works",
  });
});

test("preserves source after the first line exactly", () => {
  assert.deepEqual(
    chatWorksDirective("#!chatworks\r\nprintf first\r\nprintf second"),
    { source: "printf first\r\nprintf second" },
  );
});

test("accepts an empty directed block", () => {
  assert.deepEqual(chatWorksDirective("#!chatworks"), {
    source: "",
  });
});

test("does not infer a directive from ordinary source", () => {
  assert.equal(chatWorksDirective("printf works"), undefined);
  assert.equal(chatWorksDirective("printf before\n#!chatworks"), undefined);
});

test("requires the exact ChatWorks shebang", () => {
  assert.equal(chatWorksDirective("# chatworks:shell\ntrue"), undefined);
  assert.equal(chatWorksDirective("#!chatworks:shell\ntrue"), undefined);
  assert.equal(chatWorksDirective("#!chatworks-extra\ntrue"), undefined);
});
