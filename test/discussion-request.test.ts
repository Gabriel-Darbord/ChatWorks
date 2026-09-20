import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscussionRequest } from "../src/core/discussion-request.ts";

test("parses legacy chat references", () => {
  assert.deepEqual(parseDiscussionRequest(["One", "Two"]), {
    referenceMode: "chats",
    references: ["One", "Two"],
  });
});

test("parses stable participant references", () => {
  assert.deepEqual(
    parseDiscussionRequest([
      "--participants",
      "architect",
      "reviewer",
      "implementer",
    ]),
    {
      referenceMode: "participants",
      references: ["architect", "reviewer", "implementer"],
    },
  );
});

test("preserves reference order around options", () => {
  assert.deepEqual(
    parseDiscussionRequest([
      "architect",
      "--participants",
      "--turn=2",
      "reviewer",
    ]),
    {
      referenceMode: "participants",
      references: ["architect", "reviewer"],
      turns: 2,
    },
  );
});

test("defaults bare --pass to one without consuming a reference", () => {
  assert.deepEqual(parseDiscussionRequest(["One", "--pass", "Two"]), {
    referenceMode: "chats",
    references: ["One", "Two"],
    passes: 1,
  });
});

test("defaults bare --turn to one without consuming a reference", () => {
  assert.deepEqual(parseDiscussionRequest(["One", "--turn", "Two"]), {
    referenceMode: "chats",
    references: ["One", "Two"],
    turns: 1,
  });
});

test("parses explicit pass count", () => {
  assert.deepEqual(parseDiscussionRequest(["One", "Two", "--pass=3"]), {
    referenceMode: "chats",
    references: ["One", "Two"],
    passes: 3,
  });
});

test("parses explicit turn count", () => {
  assert.deepEqual(parseDiscussionRequest(["One", "Two", "--turn=3"]), {
    referenceMode: "chats",
    references: ["One", "Two"],
    turns: 3,
  });
});

test("rejects simultaneous pass and turn", () => {
  assert.throws(
    () => parseDiscussionRequest(["One", "Two", "--pass=2", "--turn=3"]),
    /Use either --turn or --pass/,
  );
});

test("rejects duplicate participant mode flags", () => {
  assert.throws(
    () =>
      parseDiscussionRequest([
        "--participants",
        "--participants",
        "one",
        "two",
      ]),
    /--participants may be specified only once/,
  );
});

test("rejects fewer than two references before resolution", () => {
  assert.throws(
    () => parseDiscussionRequest(["--participants", "reviewer"]),
    /at least two participants/,
  );
});

test("rejects invalid pass counts", () => {
  assert.throws(
    () => parseDiscussionRequest(["One", "Two", "--pass=0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseDiscussionRequest(["One", "Two", "--pass=nope"]),
    /positive integer/,
  );
});

test("rejects invalid turn counts", () => {
  assert.throws(
    () => parseDiscussionRequest(["One", "Two", "--turn=1.5"]),
    /positive integer/,
  );
  assert.throws(
    () => parseDiscussionRequest(["One", "Two", "--turn="]),
    /positive integer/,
  );
});

test("rejects unknown discussion options", () => {
  assert.throws(
    () =>
      parseDiscussionRequest([
        "--participants",
        "architect",
        "reviewer",
        "--pas=3",
      ]),
    /Unknown discussion option '--pas=3'/,
  );
});
