import "./stubs/hooks.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeCx, host, nodeOf, resetHost } from "./stubs/host.mjs";
import { coordinatorProjection, coordinatorRefreshOutcome, coordinatorSource } from "../fleet/coordinator-bridge.js";
import { effectivePrefs } from "../lib/prefs.js";
import { fleetAdapter, refreshOutcome } from "../fleet/adapter.js";

const { default: UsageLimits } = await import("../main.js");
const now = 2_000;
const reading = (percent, source = "cli", id = "weekly", short = "wk", long = "Weekly") => ({
  observedAt: now - 120, source, plan: "Plus",
  windows: [{ id, short, long, percent, resetsAt: now + 500, durationSec: 3_600 }],
});
const provider = (id, change = {}) => ({ provider: id, status: "ready", refreshable: true, current: reading(0), ...change });
const arch = {
  route: "arch", label: "Linux", registered: true, enrolled: true, state: "connected", providers: [
    provider("claude", { status: "unavailable", reason: "paused", refreshable: false, current: null, history: reading(37, "history") }),
    provider("codex", { history: reading(23, "history", "prior", "prior", "Prior window") }),
  ],
};
const mini = { route: "mini", label: "Mini", registered: true, enrolled: true, state: "connected", providers: [provider("codex", { current: reading(100) })] };
const snapshot = () => ({ version: 1, owner: "private", local: [{ private: "unimported" }], remotes: [arch, mini] });

function setup() {
  const coordinator = {
    data: snapshot(), refreshes: [],
    snapshot() { return this.data; },
    refresh(route, provider) { this.refreshes.push([route, provider]); return { status: "queued", message: "raw-output" }; },
  };
  let prefs = { mode: "follow", selected: null };
  const source = coordinatorSource({ coordinator, now: () => now,
    readPrefs: () => prefs, writePrefs: (value) => { prefs = value; } });
  const adapter = fleetAdapter(source);
  const model = (active) => adapter.model(adapter.readProjection(), active, effectivePrefs(), { now, local: {} });
  return { adapter, model, source, coordinator };
}

test("projection keeps separate 0% and 100%, safe source and plan; dated history never becomes current", () => {
  const data = coordinatorProjection(snapshot(), now);
  assert.equal(Object.hasOwn(data, "local"), false);
  assert.equal(coordinatorProjection({ ...snapshot(), version: 2 }, now), null);
  assert.doesNotMatch(JSON.stringify(data), /private|unimported/);
  const s = setup();
  const [linux, miniHost] = s.model("arch").remotes;
  assert.deepEqual(linux.groups.map((g) => [g.mark, ...g.segments.map((w) => w.text)]), [["—"], [null, "0%"]]);
  assert.match(miniHost.groups[1].segments[0].text, /^100%/);
  const [claude, codex] = linux.panel.groups;
  assert.equal(claude.status, "Quota collection not enabled on this machine");
  assert.equal(claude.age, "Last reading 2 min ago");
  assert.equal(claude.history, "Past reading (2 min ago): wk 37%");
  assert.equal(codex.history, "Past reading (2 min ago): prior 23%");
  assert.equal(codex.source, "Provider CLI");
  assert.equal(codex.plan, "Plus");
  assert.match(codex.rows[0].hint, /Tick:/);
  for (const [status, source] of [["ready", "secret-source"], ["ready", "history"], ["stale", "cli"]]) {
    s.coordinator.data.remotes = [{ ...arch, providers: [provider("codex", { status, current: reading(50, source) })] }];
    const example = s.model("arch");
    assert.equal(example.groups[0].groups[1].mark, "—");
    assert.doesNotMatch(JSON.stringify(example), /secret-source|50%/);
  }
});

test("refresh addresses only one pair and displays its sanitized queued, busy, deferred and failed outcomes", () => {
  const s = setup();
  const req = { type: "refresh", route: "arch", provider: "codex", ignored: "sensitive" };
  const result = s.adapter.dispatch(req);
  assert.deepEqual(result, { status: "accepted", route: "arch", label: "Linux", provider: "codex" });
  assert.equal(s.adapter.dispatch({ ...req, provider: "claude" }).status, "paused");
  assert.equal(s.adapter.dispatch({ ...req, provider: "pi" }).status, "rejected");
  assert.deepEqual(s.coordinator.refreshes, [["arch", "codex"]]);
  for (const [status, expected] of [["queued", "accepted"], ["in-flight", "busy"], ["deferred", "deferred"], ["failed", "failed"], ["fresh", "fresh"]]) {
    s.coordinator.data.remotes = [{ ...arch, providers: [
      provider("claude", { refresh: { status: "fresh" } }),
      provider("codex", { refresh: { status, reason: "timeout", retryAt: now + 120, text: "raw-output" } }),
    ] }, mini];
    assert.deepEqual(refreshOutcome(s.source.readProjection(), result),
      { status: expected, label: "Linux", route: "arch", provider: "codex", reason: "Quota check timed out", retryAt: now + 120 });
  }
  assert.deepEqual(coordinatorRefreshOutcome({ status: "nope", reason: "raw-output" }), { status: "rejected" });
});

const frontier = { id: "frontier_credit", kind: "credit", durationSec: null, percent: 40, resetsAt: now + 500 };
const monthly = { id: "monthly_spend_limit", kind: "spend", durationSec: null, percent: 89, resetsAt: null,
  money: { currency: "USD", usedMinor: 53173, limitMinor: 60000, resetLabel: "Dec 1" } };

test("current Claude credit and spend appear alongside 5h and weekly Fable only in click details", (t) => {
  t.mock.method(Date, "now", () => now * 1000);
  resetHost();
  const s = setup();
  const fiveHour = reading(12, "cli", "session", "5h", "5-hour");
  const fable = reading(65, "cli", "weekly_scoped:Fable", "Fable", "Weekly · Fable");
  const publish = (money) => {
    s.coordinator.data.remotes = [{ ...arch, providers: [provider("claude", {
      current: { ...fiveHour, windows: [...fiveHour.windows, ...fable.windows, frontier, { ...monthly, money }] },
    })] }];
  };
  publish(monthly.money);
  host.spaces = [{ id: "remote", machine: "arch", active: true }];
  const cx = fakeCx();
  const view = new (class extends UsageLimits { fleetSource() { return s.source; } fetch() {} })();
  view.init({}, cx);
  view.act.resize({ width: 1500 }, cx);
  const draw = () => JSON.stringify(nodeOf(view.render(cx)).calls);
  const compact = draw();
  assert.match(compact, /5h.*12%.*Fable.*65%/);
  assert.doesNotMatch(compact, /Frontier|Monthly usage credits|40%|89%|531\.73/);
  host.ids.get("ul-fleet-all").handlers.on_open_change(true, cx);
  const details = draw();
  assert.match(details, /5-hour.*12%.*Weekly · Fable.*65%/);
  assert.match(details, /Frontier credit.*40%.*Resets in 8m.*2 min ago/);
  assert.match(details, /Monthly usage credits.*89%.*\$531\.73 \/ \$600\.00 spent.*Resets Dec 1.*2 min ago/);
  assert.deepEqual(s.model("arch").remotes[0].panel.groups[0].rows.map((w) => w.id), ["session", "weekly_scoped:Fable"]);

  const glyphMoney = { ...monthly.money, currency: "$", resetLabel: "Dec 1, 2026" };
  publish(glyphMoney);
  assert.deepEqual(s.source.readProjection().machines[0].states.claude.measurements[1].money, glyphMoney);
  const glyphDetails = draw();
  assert.match(glyphDetails, /\$531\.73 \/ \$600\.00 spent · Resets Dec 1, 2026/);
  assert.doesNotMatch(glyphDetails, /USD/);
});

test("credit and spend alone do not fabricate plan windows or a Fable entitlement", () => {
  const s = setup();
  s.coordinator.data.remotes = [{ ...arch, providers: [provider("claude", {
    current: { ...reading(0), windows: [frontier, monthly] },
  })] }];
  const [linux] = s.model("arch").remotes;
  assert.equal(linux.groups[0].mark, "—");
  assert.deepEqual(linux.panel.groups[0].rows, []);
  assert.equal(linux.panel.groups[0].status, "No current plan reading");
  assert.equal(linux.fable, undefined);
});

test("Claude credit and spend require current, verified and eligible evidence", () => {
  const base = { ...reading(0), windows: [frontier, monthly] };
  const measurements = (change, machine = {}, id = "claude") => coordinatorProjection({
    version: 1, remotes: [{ ...arch, ...machine, providers: [provider(id, { current: base, ...change })] }],
  }, now).machines[0].states[id].measurements;
  for (const [change, machine, id] of [
    [{ status: "stale", current: null, history: { ...base, source: "history" } }],
    [{ current: { ...base, source: "history" } }],
    [{ current: { ...base, observedAt: now + 1 } }],
    [{ current: { ...base, observedAt: now - 900 } }],
    [{ current: { ...base, observedAt: undefined } }],
    [{ status: "in-flight", reason: "owner-unavailable" }],
    [{ enrolled: false }],
    [{}, { state: "unreachable" }],
    [{}, { enrolled: false }],
    [{}, {}, "codex"],
    [{ current: { ...base, windows: [{ ...frontier, resetsAt: now }, { ...monthly, resetsAt: now - 1 }] } }],
    [{ current: { ...base, windows: [{ ...frontier, resetsAt: null }, { ...monthly, kind: "plan" }] } }],
  ]) assert.equal(measurements(change, machine, id)?.length ?? 0, 0);

  const [credit, spend] = measurements({ current: { ...base, windows: [
    { ...frontier, percent: 0 }, { ...monthly, percent: 100, money: { ...monthly.money, currency: "EUR" } },
  ] } });
  assert.equal(credit.percent, 0);
  assert.equal(spend.percent, 100);
  assert.equal(spend.money, undefined);
});

test("Fable settings and details appear only on verified plan evidence, hide on toggle, and never use history as entitlement", () => {
  resetHost();
  const s = setup();
  const cx = fakeCx();
  const view = new (class extends UsageLimits { fleetSource() { return s.source; } fetch() {} })();
  const fable = reading(65, "cli", "weekly_scoped:Fable", "Fable", "Weekly · Fable");
  const publish = (change) => {
    s.coordinator.data.remotes = [{ ...arch, providers: [provider("claude", { current: fable, ...change })] }];
  };
  view.init({}, cx);
  view.act.resize({ width: 900 }, cx);
  const draw = () => {
    host.ids.clear();
    return JSON.stringify(nodeOf(view.render(cx)).calls);
  };
  const click = (id) => host.ids.get(id).handlers.on_click({}, cx);
  draw();
  host.ids.get("ul-fleet-all").handlers.on_open_change(true, cx);
  publish({});
  assert.match(draw(), /Weekly · Fable.*65%/);
  click("ul-settings");
  draw();
  const setting = "w-claude-weekly_scoped:Fable";
  assert.ok(host.ids.has(setting));
  click(setting);
  click("ul-back");
  assert.doesNotMatch(draw(), /Weekly · Fable|65%/);
  publish({ status: "stale", current: null, history: { ...fable, source: "history" } });
  click("ul-settings");
  assert.doesNotMatch(draw(), /Fable/);
});
