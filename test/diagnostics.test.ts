import assert from "node:assert/strict";
import test from "node:test";
import { errorDiagnostic } from "../src/core/diagnostics.ts";

test("projects errors into persistent diagnostic records", () => {
  const diagnostic = errorDiagnostic(
    "watch",
    new Error("Could not find an editable ChatGPT input."),
  );

  assert.equal(diagnostic.operation, "watch");
  assert.equal(diagnostic.name, "Error");
  assert.equal(diagnostic.message, "Could not find an editable ChatGPT input.");
  assert.match(diagnostic.timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.match(
    diagnostic.stack ?? "",
    /Could not find an editable ChatGPT input/,
  );
});

test("projects non-Error failures into diagnostic records", () => {
  const diagnostic = errorDiagnostic("watch", "opaque failure");

  assert.equal(diagnostic.operation, "watch");
  assert.equal(diagnostic.message, "opaque failure");
});
