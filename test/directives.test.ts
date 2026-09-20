import assert from "node:assert/strict";
import test from "node:test";
import { chatWorksDirective } from "../src/core/directives.ts";

test("consumes an explicit ChatWorks shebang", () => {
  assert.deepEqual(chatWorksDirective("#!chatworks\nprintf works"), {
    source: "printf works",
    mode: "normal",
  });
});

test("accepts surrounding whitespace on the shebang", () => {
  assert.deepEqual(chatWorksDirective("  #!chatworks  \nprintf works"), {
    source: "printf works",
    mode: "normal",
  });
});

test("preserves source after the first line exactly", () => {
  assert.deepEqual(
    chatWorksDirective("#!chatworks\r\nprintf first\r\nprintf second"),
    { source: "printf first\r\nprintf second", mode: "normal" },
  );
});

test("accepts an empty directed block", () => {
  assert.deepEqual(chatWorksDirective("#!chatworks"), {
    source: "",
    mode: "normal",
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

test("parses silent and skip execution modes", () => {
  assert.deepEqual(chatWorksDirective("#!chatworks silent\nprintf works"), {
    source: "printf works",
    mode: "silent",
  });
  assert.deepEqual(chatWorksDirective("#!chatworks skip\nprintf works"), {
    source: "printf works",
    mode: "skip",
  });
});

test("rejects unknown or combined execution modes", () => {
  assert.equal(chatWorksDirective("#!chatworks unknown\ntrue"), undefined);
  assert.equal(chatWorksDirective("#!chatworks silent skip\ntrue"), undefined);
});
