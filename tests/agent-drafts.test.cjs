const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const helpers = import("../mods/rail-next/views/agent-drafts.mjs");
const screen = (...lines) => ({
  code: 0,
  stdout: JSON.stringify({ complete: true, how: "screen", text: lines.join("\n") }),
});
const codex = (...lines) => screen(...lines,
  "  GPT-6.2-Sol medium · /tmp/probe",
  "             ⚠ 3 warnings · f2 to view",
);
const claude = (...lines) => screen("───────────────────", ...lines, "───────────────────",
  "  Opus 5.5 v2.1.308 /tmp/probe $0.00",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
);
const agent = (address, o = {}) => ({ address, pane: address, status: "idle", seq: 1, app: "codex", ...o });

test("recognizes live multiline Codex and Claude Code drafts and skips empty composers", async () => {
  const { hasDraft } = await helpers;
  assert.equal(hasDraft("codex", codex("› glass draft", "  another line")), true);
  assert.equal(hasDraft("codex", codex("› Ask Codex to do anything")), false);
  assert.equal(hasDraft("codex", codex("› ")), false);
  assert.equal(hasDraft("claude", claude("❯ glass draft", "  another line")), true);
  assert.equal(hasDraft("claude", screen(
    "───────────────────", "❯ glass draft", "───────────────────",
    "  Opus 5.5 v2.1.308 /privat…", "  ⏵⏵ auto mode on (shift+tab",
  )), true);
  assert.equal(hasDraft("claude", claude("❯ ")), false);
  assert.equal(hasDraft("claude", claude('❯ Try "fix lint errors"')), false);
});

test("rejects unreadable screens, history, and prompt-like transcript lines", async () => {
  const { hasDraft } = await helpers;
  assert.equal(hasDraft("codex", { code: 1, stdout: "" }), false);
  assert.equal(hasDraft("codex", { code: 0, stdout: "broken JSON" }), false);
  for (const override of [{ complete: false }, { how: "history" }]) {
    const result = codex("› glass draft");
    result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), ...override });
    assert.equal(hasDraft("codex", result), false);
  }
  assert.equal(hasDraft("codex", screen("› old prompt", "more output")), false);
  assert.equal(hasDraft("codex", codex("› old prompt", "• answer", "› Ask Codex to do anything")), false);
  assert.equal(hasDraft("claude", screen("❯ old prompt", "  ? for shortcuts")), false);
});

test("reads only eligible idle agents, clears stale detections, and keeps agent status", async () => {
  const { createDraftMonitor } = await helpers;
  const idle = agent("idle");
  let live = [idle, agent("busy", { status: "working" }), agent("other", { app: "opencode" })];
  const reads = [];
  let result = codex("› glass draft");
  const monitor = createDraftMonitor(() => live, async (address) => {
    reads.push(address);
    if (result === null) throw Error("unreachable");
    return result;
  });
  const refresh = () => monitor.refresh(() => {});
  await refresh();
  assert.deepEqual(reads, ["idle"]);
  assert.equal(monitor.has(idle), true);
  assert.equal(idle.status, "idle");
  assert.equal(monitor.has({ ...idle, seq: 2 }), false);
  assert.equal(monitor.has({ ...idle, status: "working" }), false);

  result = codex("› Ask Codex to do anything");
  await refresh();
  assert.equal(monitor.has(idle), false);
  result = codex("› glass draft");
  await refresh();
  result = null;
  await refresh();
  assert.equal(monitor.has(idle), false);

  result = codex("› glass draft");
  await refresh();
  live = [];
  await refresh();
  assert.equal(monitor.has(idle), false);
});

test("bounds polling and ignores a response when the agent changes mid-read", async () => {
  const { createDraftMonitor } = await helpers;
  let live = Array.from({ length: 6 }, (_, i) => agent(String(i)));
  const first = live[0];
  const pending = [];
  const monitor = createDraftMonitor(() => live, (address) => new Promise((resolve) => {
    pending.push({ address, resolve });
  }));
  const refresh = () => monitor.refresh(() => {});
  const initial = refresh();
  await refresh();
  assert.deepEqual(pending.map(({ address }) => address), ["0", "1", "2", "3"]);
  live = [{ ...first, status: "working" }, ...live.slice(1)];
  for (const item of pending.splice(0)) item.resolve(codex("› glass draft"));
  await initial;
  assert.equal(monitor.has(first), false);
  const next = refresh();
  assert.ok(pending.some(({ address }) => address === "4"));
  assert.ok(pending.some(({ address }) => address === "5"));
  for (const item of pending.splice(0)) item.resolve(codex("› "));
  await next;
});

test("promotes draft rows into idle slots and enables the feature in both Glass layouts", async () => {
  const { promoteDrafts } = await helpers;
  const idle = agent("idle");
  const busy = agent("busy", { status: "working" });
  const draft = agent("draft");
  assert.deepEqual(promoteDrafts([idle, busy, draft], new Set(["draft"])), [draft, busy, idle]);
  for (const name of ["glass", "glass-insights"]) {
    const root = JSON.parse(readFileSync(join(__dirname, "../layouts", `${name}.json`), "utf8"));
    const source = JSON.stringify(root);
    assert.match(source, /"mod":"rail-next","props":\{"view":"agents","showDrafts":true\}/);
  }
});

test("uses the existing idle ring for accent and draft colors with an opt-out", async () => {
  const { idleRingColor } = await helpers;
  const theme = { accent: "#89b4fa", muted: "#a6adc8" };
  assert.equal(idleRingColor(theme, true, false, "border"), theme.accent);
  assert.equal(idleRingColor(theme, true, true, "border"), theme.muted);
  assert.equal(idleRingColor(theme, false, false, "border"), "border");
});
