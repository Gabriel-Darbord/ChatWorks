import assert from "node:assert/strict";
import test from "node:test";
import { hasShellDirective } from "../src/core/directives.ts";

test("recognizes an explicit first-line shell directive", () => {
  assert.equal(hasShellDirective("# chatworks:shell\nprintf works"), true);
  assert.equal(hasShellDirective("  # chatworks:shell  \nprintf works"), true);
});

test("does not execute ordinary shell source", () => {
  assert.equal(hasShellDirective("printf works"), false);
  assert.equal(hasShellDirective("printf before\n# chatworks:shell"), false);
});

test("requires the exact shell directive", () => {
  assert.equal(hasShellDirective("# chatworks:other\ntrue"), false);
  assert.equal(hasShellDirective("# chatworks=shell\ntrue"), false);
  assert.equal(hasShellDirective("# chatworks:shell-extra\ntrue"), false);
});
