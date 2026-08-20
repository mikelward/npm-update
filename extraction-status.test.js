// Regression guard for the npm-update extraction's status text: nothing
// here executes, so a hand edit to one status reference (README.md,
// AGENTS.md, TODO.md, npm-update.yml's header) that drifts out of sync with
// the others is a silent false pass -- exactly the contradiction
// mikelward/npm-update#19 caught (and fixed) after the first pass at
// declaring the extraction complete missed two of the four references.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8");
const todo = readFileSync(new URL("./TODO.md", import.meta.url), "utf8");
const workflow = readFileSync(new URL("./.github/workflows/npm-update.yml", import.meta.url), "utf8");

const FILES = [
  ["README.md", readme],
  ["AGENTS.md", agents],
  ["TODO.md", todo],
  ["npm-update.yml", workflow],
];

// Phrasing that only made sense while the migration was still in flight.
// Any one of these reappearing means a status reference wasn't updated
// when the others were.
const STALE_PHRASES = [
  /still run their own/,
  /still live/,
  /arriving as it is extracted/,
  /[Bb]eing extracted from/,
  /until they migrate/,
  /until they consume/,
  /when it arrives/,
  /in from day one/,
];

describe("the extraction's status text stays consistent", () => {
  test("no status reference describes the migration as still in progress", () => {
    for (const [name, text] of FILES) {
      for (const phrase of STALE_PHRASES) {
        assert.doesNotMatch(text, phrase, `${name} still contains stale in-progress phrasing: ${phrase}`);
      }
    }
  });

  test("README.md, AGENTS.md, and npm-update.yml all say the consumers have migrated", () => {
    assert.match(readme, /all three now consume it/);
    assert.match(agents, /gedmap, newshacker, and readmo all consume this repository now/);
    assert.match(workflow, /readmo and\n# newshacker have since migrated too/);
  });
});
