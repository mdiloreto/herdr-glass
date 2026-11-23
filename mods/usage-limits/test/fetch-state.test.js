import { test } from "node:test";
import assert from "node:assert/strict";
import { NEVER_FETCHED, NOT_FOUND_EXIT_CODE, crashedState, fetchedState } from "../lib/fetch-state.js";
import { okReport } from "../lib/report.js";
import claude from "../providers/claude.js";
import pi from "../providers/pi.js";
import { NOW, read } from "./_util.js";

const reading = okReport("x", NOW - 600, [], null);
const known = { report: reading, lastGood: reading, installed: true };

test("a helper the shell cannot find means the CLI is not installed, the last good reading kept", () => {
  assert.deepEqual(fetchedState(known, claude, { code: NOT_FOUND_EXIT_CODE, stdout: "" }, NOW), { report: null, lastGood: reading, installed: false });
});

test("a failed spend helper prints nothing, which would read as 0 tokens: it shows as failing instead", () => {
  const next = fetchedState(known, pi, { code: 1, stdout: "" }, NOW);
  assert.deepEqual([next.report.status, next.report.message, next.lastGood], ["error", "Couldn't count Pi tokens", reading]);
});

test("a limits helper's output is read by its provider, whatever its exit code", () => {
  const next = fetchedState(NEVER_FETCHED, claude, { code: 0, stdout: read("claude-get-usage.max.json") }, NOW);
  assert.deepEqual([next.report.status, next.installed, next.lastGood], ["ok", true, next.report]);
});

test("a spend helper killed at its deadline is failing, with the reason and the last numbers", () => {
  const next = crashedState(known, pi, new Error("timed out"), NOW);
  assert.deepEqual([next.report.status, next.report.message, next.lastGood, next.installed], ["error", "timed out", reading, true]);
});

test("a limits helper that could not run keeps everything else it knew", () => {
  const next = crashedState(known, claude, "cannot run", NOW);
  assert.deepEqual({ ...next, report: null }, { ...known, report: null });
  assert.deepEqual([next.report.status, next.report.message, next.report.source], ["error", "cannot run", claude.helper]);
});
