import "./stubs/hooks.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeCx, host, nodeOf, resetHost, settle } from "./stubs/host.mjs";
import { effectivePrefs } from "../lib/prefs.js";
import { DENSITY, barModel, cardModel } from "../lib/view.js";
import { okReport, spendReport } from "../lib/report.js";
import { FLEET_PREFS_KEY, fleetAdapter, sharedFleetPrefs } from "../fleet/adapter.js";
import { fleetBar } from "../fleet/model.js";
import { focusScope } from "../fleet/selection.js";

const { default: UsageLimits } = await import("../main.js");
const now = 2000;
const prefs = effectivePrefs();
const window = (id, percent, inSeconds = 1800) => ({ id, short: id, long: id, percent, resetsAt: now + inSeconds, durationSec: 18000 });
const codex = (windows) => ({ report: okReport("codex app-server", now, windows, "plus", now - 60) });
const local = { codex: codex([window("5h", 0), window("wk", 60), window("spark", 60, 900)]), pi: { report: spendReport("pi logs", now, 20, 30) } };
const machine = (route, availability = "ready", enabled = true, states = {}) => ({ route, label: `Host ${route}`, availability, registered: true, enabled, states });
const data = (machines) => ({ now, machines });

function setup(machines, result = { status: "accepted" }) {
  let projection = data(machines);
  const shared = new Map();
  const writes = [];
  const refreshes = [];
  const source = {
    ...sharedFleetPrefs((key) => shared.get(key), (key, value) => {
      shared.set(key, value);
      writes.push([key, value]);
    }),
    readProjection: () => projection,
    refresh: (intent) => { refreshes.push(intent); return result; },
  };
  const adapter = fleetAdapter(source);
  const model = (active = null, options = prefs, mounted = adapter) =>
    mounted.model(mounted.readProjection(), active, options, { now, local });
  return { source, shared, writes, refreshes, adapter, model, project: (next) => { projection = data(next); } };
}

test("Follow uses the actual active space, not focus, availability, remembered choice or another remote", () => {
  const s = setup([machine("linux"), machine("mini", "offline")]);
  assert.deepEqual(s.model().groups.map((g) => g.label), ["This Computer"]);
  assert.deepEqual(s.model("mini").groups.map((g) => g.label), ["Host mini"]);
  assert.deepEqual(s.model("unlisted").groups.map((g) => g.label), ["unlisted"]);
  assert.deepEqual(s.writes, []);
  s.adapter.dispatch({ type: "mode", mode: "combined" });
  assert.equal(s.model("mini").selection.selected.route, "linux");
  s.adapter.dispatch({ type: "mode", mode: "follow" });
  assert.equal(s.model("mini").groups[0].label, "Host mini");
  assert.equal(s.shared.get(FLEET_PREFS_KEY).selected.route, "linux");
});

test("local-to-local terminal replacement keeps native focused counters; a remote replacement clears them without changing the space", () => {
  const spaces = [{ id: "local", machine: null, active: true }];
  const terminals = () => [{ address: "t1" }, { address: "t2" }, { address: "linux/t1" }];
  const focused = (shown) => focusScope(spaces, { space: "local", terminal: "t1", shown }, terminals);
  assert.deepEqual(focused("t2"), { activeMachine: null, session: "local", terminal: "t1" });
  assert.deepEqual(focused("linux/t1"), { activeMachine: null, session: "remote", terminal: null });
});

test("combined mode asks for a choice and remembers it even if unavailable, non-enrolled or removed", () => {
  const linux = machine("linux");
  const mini = machine("mini");
  const s = setup([linux, mini]);
  s.adapter.dispatch({ type: "mode", mode: "combined" });
  assert.equal(s.model("linux").selection.selected, null);
  assert.deepEqual(s.model("linux").selection.choices.map((m) => m.route), ["linux", "mini"]);
  assert.equal(s.adapter.dispatch({ type: "select", route: "unknown" }).status, "unavailable");
  s.adapter.dispatch({ type: "select", route: "mini", ignored: "not stored" });
  assert.deepEqual(s.shared.get(FLEET_PREFS_KEY), { mode: "combined", selected: { route: "mini", label: "Host mini" } });
  const remount = fleetAdapter(s.source);
  for (const roster of [[linux, machine("mini", "offline")], [linux, machine("mini", "ready", false)], [linux]]) {
    s.project(roster);
    const model = s.model("linux", prefs, remount);
    assert.equal(model.selection.selected.route, "mini");
    assert.deepEqual(model.groups.map(({ label }) => label), ["This Computer", "Host mini"]);
    assert.deepEqual(model.groups[1].groups.map((g) => g.mark), ["—", "—"]);
    assert.deepEqual(model.remotes.map(({ label }) => label), ["Host linux", "Host mini"]);
  }
  s.project([]);
  assert.equal(s.model(null, prefs, remount), null);
});

test("sole selectable remote becomes the default only in combined mode", () => {
  const s = setup([machine("offline", "offline")]);
  s.adapter.dispatch({ type: "mode", mode: "combined" });
  assert.equal(s.model().selection.selected, null);
  s.project([machine("offline", "offline"), machine("linux")]);
  assert.equal(s.model().selection.selected.route, "linux");
  s.project([machine("offline"), machine("linux", "offline")]);
  assert.equal(s.model().selection.selected.route, "linux");
});

test("combined compaction retains attribution and windows until named controls; ties choose earliest reset", () => {
  const s = setup([machine("linux", "ready", true, { codex: codex([window("5h", 100), window("wk", 15)]) })]);
  s.adapter.dispatch({ type: "mode", mode: "combined" });
  const model = s.model(null, effectivePrefs({ spendOnBar: { pi: true } }));
  const bar = (width) => fleetBar(model, width, [{ text: "ctx 20%" }], true);
  const segments = (value) => value.groups.map((h) => h.groups.find((g) => g.providerId === "codex").segments.map((w) => w.short));
  assert.equal(bar(1600).density, DENSITY.FULL);
  assert.deepEqual(segments(bar(1600)), [["5h", "wk", "spark"], ["5h", "wk"]]);
  const intermediate = Array.from({ length: 150 }, (_, i) => bar(100 + 10 * i));
  assert.ok(intermediate.some((candidate) => candidate.density === DENSITY.NO_BARS && segments(candidate)[0].length === 3));
  const tight = intermediate.find((candidate) => candidate.density === DENSITY.NO_BARS && segments(candidate)[0].length === 1);
  assert.deepEqual(segments(tight), [["spark"], ["5h"]]);
  assert.deepEqual(bar(140), { labels: ["This Computer", "Host linux"], padding: 4, numbers: [] });
  assert.deepEqual(fleetBar(s.model("linux"), 1000, [{ text: "ctx 20%" }], false).numbers, [{ text: "ctx 20%" }]);
  s.adapter.dispatch({ type: "mode", mode: "follow" });
  assert.deepEqual(fleetBar(s.model("linux"), 1000, [{ text: "ctx 20%" }], true).numbers, []);
  assert.deepEqual(fleetBar(s.model("linux"), 100, [], true).labels, ["Host linux"]);
});

test("Local continues to use native meters, preferences, reset/pace and spend classification", () => {
  const s = setup([machine("linux")]);
  const options = effectivePrefs({ hidden: ["claude"], hiddenWindows: ["codex:wk"], showResetTime: true, spendOnBar: { pi: true } });
  const model = s.model(null, options);
  assert.deepEqual(model.local.groups.map(({ tight, ...group }) => group), barModel(local, options, now).groups);
  assert.deepEqual(model.local.panel.groups.map(({ source, ...group }) => group), cardModel(local, now, undefined, options).groups);
  assert.equal(model.local.panel.groups.find((g) => g.providerId === "pi").kind, "spend");
});

function renderUsing(source, { withoutFetch = true } = {}) {
  const cx = fakeCx();
  const view = new (class extends UsageLimits { fleetSource() { return source; } })();
  if (withoutFetch) view.fetch = () => {};
  view.init({}, cx);
  view.act.resize({ width: 1500 }, cx);
  const draw = () => {
    host.ids.clear();
    return JSON.stringify(nodeOf(view.render(cx)).calls);
  };
  const fire = (id, key = "on_click", input = {}) => {
    const handler = host.ids.get(id)?.handlers[key];
    assert.ok(handler, `${id}: no ${key}`);
    handler(input, cx);
  };
  const open = (id = "all") => fire(`ul-fleet-${id}`, "on_open_change", true);
  return { view, cx, draw, fire, open };
}

test("click opens all hosts from wide and named narrow triggers; zoom compacts and focus is not machine attribution", () => {
  resetHost();
  const s = setup([machine("linux"), machine("mini", "ready", false)]);
  host.spaces = [{ id: "remote", machine: "linux", active: true }, { id: "local", machine: null }];
  host.focused = { space: "local", terminal: "t1" };
  host.terminals = [{ address: "t1" }];
  const ui = renderUsing(s.source);
  const closed = ui.draw();
  assert.match(closed, /Host linux/);
  assert.doesNotMatch(closed, /This Computer|Host mini/);
  assert.deepEqual(host.execs, []);
  ui.open();
  const details = ui.draw();
  assert.match(details, /This Computer.*Host linux.*Host mini.*Remote not enrolled/);
  ui.fire("ul-mode-combined");
  ui.view.act.resize({ width: 280 }, ui.cx);
  host.zoom = 2;
  const narrowed = ui.draw();
  for (const [i, name] of ["This Computer", "Host linux"].entries()) {
    const button = host.ids.get(`ul-fleet-details-${i}`);
    assert.ok(button.calls.some(([key, args]) => key === "accessibility_label" && args[0] === `${name} · Quota details`));
  }
  assert.match(narrowed, /This Computer.*Host linux.*Host mini/);
  ui.open("1");
  assert.match(ui.draw(), /This Computer.*Host linux.*Host mini/);
});

test("only the named local or remote pair refreshes; native global refresh and settings still work", async () => {
  resetHost();
  host.exec = async () => ({ code: 1, stdout: "" });
  const s = setup([{ ...machine("linux"), refreshable: { claude: false, codex: true } }, machine("mini", "offline")], { status: "busy" });
  const ui = renderUsing(s.source, { withoutFetch: false });
  await settle(ui.cx);
  const startup = host.execs.length;
  assert.ok(startup > 0);
  ui.draw();
  ui.open();
  ui.draw();
  assert.equal(host.ids.get("ul-remote-refresh-linux-claude").handlers.on_click, undefined);
  ui.fire("ul-remote-refresh-linux-codex");
  assert.match(ui.draw(), /Host linux · Codex: Refresh in progress/);
  assert.deepEqual(s.refreshes, [{ type: "refresh", route: "linux", provider: "codex" }]);
  assert.equal(host.execs.length, startup);
  ui.view.lastFetchAtS.codex -= 31;
  ui.draw();
  ui.fire("ul-local-refresh-codex");
  await settle(ui.cx);
  assert.equal(host.execs.length, startup + 1);
  assert.match(host.execs.at(-1)[1][0], /codex-limits\.sh$/);
  ui.fire("ul-refresh");
  ui.draw();
  await settle(ui.cx);
  assert.equal(host.execs.length, 2 * startup + 1);
  ui.fire("ul-settings");
  ui.draw();
  ui.fire("opt-bars");
  assert.equal(host.shared["usage-limits.prefs"].showBars, false);
});

test("zero registered remotes uses the native hover branch, even with a stale selection", () => {
  resetHost();
  const s = setup([machine("linux")]);
  s.adapter.dispatch({ type: "mode", mode: "combined" });
  s.project([{ ...machine("linux"), registered: false }]);
  const native = renderUsing(null).draw();
  const withFleet = renderUsing(s.source).draw();
  assert.equal(withFleet, native);
  assert.match(native, /HoverCard/);
  assert.doesNotMatch(native, /This Computer|Quota details|Local \+ Remote/);
});

test("check does not obtain the source, start a timer, write, or probe", () => {
  resetHost();
  host.checking = true;
  class Check extends UsageLimits { fleetSource() { throw new Error("called injected source in check"); } }
  const cx = fakeCx();
  const view = new Check();
  view.init({}, cx);
  view.render(cx);
  assert.deepEqual([cx.timers, host.execs, host.sets], [[], [], []]);
});
