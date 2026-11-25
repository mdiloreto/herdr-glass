import "./stubs/hooks.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCx, host, nodeOf, resetHost, settle } from "./stubs/host.mjs";
import { HERE, read } from "./_util.js";

process.env.TZ = "UTC";
const CLOCK_MS = Date.UTC(2026, 10, 4, 8, 0, 0);
Date.now = () => CLOCK_MS;
const { default: NativeUsageLimits } = await import("../main.js");
class UsageLimits extends NativeUsageLimits { fleetSource() { return null; } }

const SNAPSHOT = join(HERE, "fixtures", "main-snapshot.json");
const CHOICE = "0a1b2c3d-0000-4000-8000-00000000000a";
const OTHER_CHOICE = "0a1b2c3d-0000-4000-8000-00000000000b";

const ok = (stdout) => ({ code: 0, stdout });
const missing = () => ({ code: 127, stdout: "" });
const failed = () => ({ code: 1, stdout: "" });
const opencodeStats = () => JSON.stringify({
  today: JSON.parse(read("opencode-stats.today.json")),
  week: JSON.parse(read("opencode-stats.week.json")),
});
const piSpend = "2026-11-04T07:00:00.000Z 1200\n2026-11-01T07:00:00.000Z 50000\n";
const claudeSession = "tokens=50000 window=200000 calls=12 compactions=1 lastTrigger=auto lastPre=180000 lastPost=40000";

const ALL_OK = {
  "claude-usage.sh": () => ok(read("claude-get-usage.max.json")),
  "codex-limits.sh": () => ok(read("codex-app-server.plus.json")),
  "opencode-spend.sh": () => ok(opencodeStats()),
  "pi-spend.sh": () => ok(piSpend),
};

function answering(helpers, terminal = null) {
  return async (bin, args) => {
    if (bin === "hc") return ok(JSON.stringify(terminal));
    const name = args[0].split("/").pop();
    const answer = helpers[name];
    if (!answer) return failed();
    return answer(args);
  };
}

const plain = (x) => {
  if (Array.isArray(x)) return x.map(plain);
  if (x == null || typeof x !== "object" || !x.calls) return x;
  const calls = x.calls.flatMap(([name, args]) => (name === "children" ? args[0].map((c) => ["child", plain(c)]) : [[name, ...args.map(plain)]]));
  const children = calls.filter(([name]) => name === "child").map(([, child]) => child);
  const style = calls.filter(([name]) => name !== "child").sort(([a], [b]) => a.localeCompare(b));
  return { kind: x.kind, args: x.args.map(plain), style, children };
};

function session({ helpers, terminal = null, shared = {}, props = null }) {
  resetHost();
  Object.assign(host.shared, shared);
  host.props = props;
  host.focused = terminal ? { terminal: "t1", space: "local-space" } : null;
  host.terminals = terminal ? [{ address: "t1" }] : [];
  host.spaces = [{ id: "local-space", active: true, machine: null }];
  host.exec = answering(helpers, terminal);
  const cx = fakeCx();
  const view = new UsageLimits();
  const frames = [];
  const frame = async (label) => {
    await settle(cx);
    host.ids.clear();
    const tree = plain(nodeOf(view.render(cx)));
    await settle(cx);
    frames.push({ label, tree, sets: host.sets.splice(0), execs: host.execs.splice(0) });
  };
  const fire = async (id, event, arg) => {
    const handler = host.ids.get(id)?.handlers[event];
    assert.ok(handler, `${id} has no ${event}`);
    handler(arg, cx);
    await settle(cx);
  };
  const press = (id) => fire(id, "on_click", {});
  return { cx, view, frames, frame, fire, press, start: () => view.init({}, cx) };
}

const SCENARIOS = {
  async everyProviderAnswers() {
    const s = session({ helpers: { ...ALL_OK, "session.sh": () => ok(claudeSession) }, terminal: { status: { app: "claude-code" }, foreground: { pid: 41 }, cwd: "/work/demo" } });
    s.start();
    await s.frame("first render");
    await s.frame("session read");
    for (const width of [2000, 420, 260, 120]) {
      await s.fire("root", "on_size_change", { width, height: 24 });
      await s.frame(`width ${width}`);
    }
    await s.fire("ul-content", "on_hover", true);
    await s.frame("hovered");
    await s.press("ul-settings");
    await s.frame("settings");
    for (const id of ["p-codex-bar", "w-claude-weekly_all", "s-context", "s-calls", "s-compactions", "opt-reset-time", "opt-bars", "p-opencode-bar", "p-pi-panel"]) {
      await s.press(id);
      await s.frame(`toggled ${id}`);
    }
    await s.press("p-claude-panel");
    await s.press("p-claude-panel");
    await s.frame("panel box clicked twice before a redraw");
    await s.press("panel-session");
    await s.frame("session out of the panel");
    await s.press("panel-session");
    await s.press("ul-back");
    await s.frame("back to limits");
    await s.press("ul-head-claude");
    await s.frame("claude folded here");
    await s.fire("ul-head-codex", "on_hover", true);
    await s.frame("codex header hovered");
    await s.fire("ul-panel-body", "on_hover", false);
    await s.frame("pointer left the panel");
    await s.press("ul-refresh");
    await s.frame("refresh asked");
    s.cx.timers[0][1](s.cx);
    await s.frame("a minute later");
    return s.frames;
  },

  async failingAndMissing() {
    const s = session({
      helpers: {
        "claude-usage.sh": () => ok(read("claude-get-usage.error.json")),
        "codex-limits.sh": missing,
        "opencode-spend.sh": failed,
        "pi-spend.sh": () => Promise.reject(new Error("killed")),
      },
    });
    s.start();
    await s.frame("first render");
    await s.frame("again");
    await s.press("ul-head-claude");
    await s.frame("failing claude folded");
    await s.press("ul-settings");
    await s.frame("settings");
    return s.frames;
  },

  async codexSessionChosenByHand() {
    const choices = JSON.stringify({ pid: 77, identity: "started:1", choices: [{ id: CHOICE, title: "Fix the bar" }, { id: OTHER_CHOICE, title: "" }] });
    const sessionHelper = (args) => (args.length > 3 ? ok("tokens=9000 calls=3") : { code: 2, stdout: choices });
    const s = session({ helpers: { ...ALL_OK, "session.sh": sessionHelper }, terminal: { status: { app: "codex" }, foreground: { pid: 77 }, cwd: "/work/other" }, props: { sessionOnBar: ["calls"] } });
    s.start();
    await s.frame("first render");
    await s.frame("choices read");
    await s.press("ul-pick-session");
    await s.frame("picker open");
    await s.press(`ul-session-${CHOICE}`);
    await s.frame("session chosen");
    await s.frame("chosen session read");
    await s.press("ul-change-session");
    await s.frame("choice dropped");
    return s.frames;
  },

  async nothingInstalled() {
    const s = session({ helpers: { "claude-usage.sh": missing, "codex-limits.sh": missing, "opencode-spend.sh": missing, "pi-spend.sh": missing } });
    s.start();
    await s.frame("first render");
    await s.frame("again");
    await s.press("opt-bars");
    await s.frame("a box ticked");
    return s.frames;
  },

  async spendOnly() {
    const opencodeSession = "tokens=30000 window=100000 calls=4 compactions=0 model=demo-model";
    const s = session({
      helpers: { ...ALL_OK, "claude-usage.sh": missing, "codex-limits.sh": missing, "session.sh": () => ok(opencodeSession) },
      terminal: { status: { app: "opencode" }, foreground: { pid: 9 }, cwd: "/work/spend" },
      props: { hidden: ["codex"], sessionOnBar: ["context"] },
    });
    s.start();
    await s.frame("first render");
    await s.frame("again");
    await s.press("ul-settings");
    await s.frame("settings");
    await s.press("p-pi-bar");
    await s.frame("pi off the bar");
    return s.frames;
  },
};

const snapshot = async () => {
  const out = {};
  for (const [name, run] of Object.entries(SCENARIOS)) out[name] = await run();
  return JSON.parse(JSON.stringify(out));
};

test("main.js draws and reacts as recorded in fixtures/main-snapshot.json", async () => {
  const now = await snapshot();
  if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 1)}\n`);
  assert.ok(existsSync(SNAPSHOT), "no recorded run: UPDATE_SNAPSHOT=1 records one");
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const name of Object.keys(before)) {
    for (const [i, frame] of before[name].entries()) assert.deepEqual(now[name][i], frame, `${name} / ${frame.label}`);
  }
  assert.deepEqual(Object.keys(now), Object.keys(before));
});

test("props.border false drops the line above the bar, for a layout whose status row is drawn without lines; by default the line stays", async () => {
  const lined = (tree) => tree.style.some(([name]) => name === "border_t");
  for (const [props, want] of [[null, true], [{ border: true }, true], [{ border: false }, false]]) {
    const s = session({ helpers: ALL_OK, props });
    s.start();
    await s.frame("drawn");
    assert.equal(lined(s.frames[0].tree), want, JSON.stringify(props));
  }
});

test("session helper is never sent a remote or unclassified terminal, including on hover", async () => {
  const s = session({ helpers: ALL_OK });
  s.start();
  for (const [spaces, focus] of [
    [[{ id: "remote", machine: "arch-route", active: true }], { space: "remote", terminal: "arch-route/t1", pid: 77 }],
    [[{ id: "local", machine: null, active: true }], { space: "local", terminal: "t1", shown: "arch-route/t1", pid: 77 }],
    [[{ id: "unknown", active: true }], { space: "unknown", agent: "unknown-id", pid: 88 }],
    [[{ id: "local", machine: null, active: true }], { space: "gone", terminal: "stale-id" }],
    [[], { terminal: "unclassified-id" }],
  ]) {
    host.spaces = spaces;
    host.focused = focus;
    host.terminals = [{ address: "t1" }, { address: "arch-route/t1" }];
    host.machines = [{ name: "arch-route" }];
    await s.frame("unsafe focus");
    await s.fire("ul-content", "on_hover", true);
    assert.equal(s.view.terminal, null);
    assert.equal(s.view.session, null);
    if (focus.space === "remote") assert.match(JSON.stringify(s.frames.at(-1).tree), /Focused session unavailable on remote/);
    assert.ok(s.frames.at(-1).execs.every(([bin]) => bin !== "hc"));
    assert.ok(host.execs.every(([bin]) => bin !== "hc"));
  }
});

test("a delayed local result is discarded when focus visits a remote and returns to the same local address", async () => {
  resetHost();
  const local = { id: "local", machine: null, active: true };
  const remote = { id: "remote", machine: "arch", active: true };
  host.spaces = [local];
  host.focused = { space: "local", terminal: "t1" };
  host.terminals = [{ address: "t1" }, { address: "arch/t1" }];
  const started = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  let sessionReads = 0;
  host.exec = async (bin, args) => {
    if (bin === "hc") return ok(JSON.stringify({ status: { app: "claude-code" }, foreground: { pid: 77 }, cwd: "/work" }));
    assert.match(args[0], /session\.sh$/);
    sessionReads += 1;
    if (sessionReads === 1) {
      started.resolve();
      return delayed.promise;
    }
    return ok("tokens=50000 window=200000");
  };
  const cx = fakeCx();
  const view = new (class extends UsageLimits { fetch() {} })();
  view.init({}, cx);
  view.render(cx);
  await started.promise;
  host.spaces = [remote];
  host.focused = { space: "remote", terminal: "arch/t1", pid: 77 };
  view.render(cx);
  assert.equal(view.session, null);
  assert.equal(sessionReads, 1);
  host.spaces = [local];
  host.focused = { space: "local", terminal: "t1" };
  view.render(cx);
  delayed.resolve(ok("tokens=10000 window=200000"));
  await settle(cx);
  assert.equal(sessionReads, 2);
  assert.deepEqual(host.execs.filter(([bin]) => bin === "hc").map(([, args]) => args.at(-1)), ["t1", "t1"]);
  assert.match(JSON.stringify(nodeOf(view.render(cx)).calls), /ctx 25%/);
});
