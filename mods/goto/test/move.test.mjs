// Plain node, no dependencies: node test/move.test.mjs
import assert from "node:assert/strict";
import { moveTab } from "../move.js";

const tab = (id, named = false, name = "1") => ({ id, name, named });

// A fake world. Time is the number of sleeps. A park lands `lag` ticks after the first request and then strips the
// labels and the pane; a label on a terminal that still has a pane does nothing (it must be parked first); a label on
// a parked one adopts it, and an unknown tab id becomes a tab of that space.
function world({ spaceList, paneList, lag = 2, failLabel = null, throwLabel = null, throwAllLabels = null }) {
  const log = [];
  const labels = {};
  const home = {};
  const lands = [];
  const doubles = [];
  let ticks = 0;
  const settle = () => {
    for (let i = lands.length - 1; i >= 0; i--) if (ticks >= lands[i][1]) { delete labels[lands[i][0]]["herdr.space"]; lands.splice(i, 1); }
  };
  const sp = spaceList;
  const host = {
    spaces: () => sp,
    panes: () => { settle(); return paneList.filter((p) => !p.terminal || labels[p.terminal]?.["herdr.space"]).map((p) => (p.terminal ? { ...p, tab: labels[p.terminal]["herdr.tab"] } : p)); },
    sleep: async () => { ticks++; },
    run: async (name, args) => {
      log.push(["run", name, args]);
      // Each park lands on its own, as the core may do; a second one while the first is pending is the bug.
      if (name === "terminal.park") {
        if (lands.some(([t]) => t === args.terminal)) doubles.push(args.terminal);
        lands.push([args.terminal, ticks + lag]);
      }
      if (name === "terminal.keep") { settle(); if (!labels[args.terminal]["herdr.space"]) labels[args.terminal] = { ...home[args.terminal] }; }
      return name === "terminal.park" ? { pending: true } : null;
    },
    hc: async (args) => {
      log.push(["hc", ...args]);
      const t = args[1];
      settle();
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ labels: labels[t] }), stderr: "" };
      if (args[0] === "label") {
        const l = Object.fromEntries(args.slice(2).map((kv) => kv.split("=")));
        if (t === throwLabel && l["herdr.space"] !== "s1") throw new Error("socket closed");
        if (t === throwAllLabels) throw new Error("socket closed");
        if (t === failLabel && l["herdr.space"] !== "s1") return { code: 1, stdout: "", stderr: "denied" };
        if (labels[t]["herdr.space"]) return { code: 0, stdout: "", stderr: "" };
        labels[t] = l;
        const space = sp.find((s) => s.id === l["herdr.space"]);
        if (!space.tabs.some((c) => c.id === l["herdr.tab"])) space.tabs.push(tab(l["herdr.tab"]));
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "?" };
    },
  };
  for (const p of paneList) if (p.terminal) { labels[p.terminal] = { "herdr.space": "s1", "herdr.tab": p.tab }; home[p.terminal] = { ...labels[p.terminal] }; }
  return { host, log, labels, doubles };
}

const spaces = () => [
  { id: "s1", machine: null, tabs: [tab("tbA", true, "fix login"), tab("tbB")] },
  { id: "s2", machine: null, tabs: [tab("tbC")] },
  { id: "r1/s9", machine: "r1", tabs: [tab("r1/tbD")] },
];
const pane = (n, t, terminal) => ({ pane: `p${n}`, tab: t, terminal });

// Refuses: same space, remote machine, no terminals.
{
  const { host, log } = world({ spaceList: spaces(), paneList: [pane(1, "tbA", "t1")] });
  assert.match((await moveTab({ tab: "tbA", target: "s1" }, host)).error, /already/);
  assert.match((await moveTab({ tab: "tbA", target: "r1/s9" }, host)).error, /this computer/);
  assert.match((await moveTab({ tab: "r1/tbD", target: "s1" }, host)).error, /this computer/);
  assert.equal(log.length, 0);
}
{
  const { host, log } = world({ spaceList: spaces(), paneList: [{ pane: "p1", tab: "tbB", terminal: null, mod: "files" }] });
  assert.match((await moveTab({ tab: "tbB", target: "s2" }, host)).error, /no terminal/);
  assert.equal(log.length, 0);
}

// Two terminals: one shared new tab id, each parked and waited for before its label; the mod pane is left.
{
  const { host, log } = world({
    spaceList: spaces(),
    paneList: [pane(1, "tbA", "t1"), { pane: "p2", tab: "tbA", terminal: null, mod: "files" }, pane(3, "tbA", "t2")],
  });
  const r = await moveTab({ tab: "tbA", target: "s2" }, host);
  assert.equal(r.ok, true);
  assert.match(r.tab, /^tb[0-9a-f]{32}$/);
  const labelled = log.filter((e) => e[0] === "hc" && e[1] === "label");
  assert.deepEqual(labelled.map((e) => e[2]), ["t1", "t2"]);
  for (const e of labelled) assert.deepEqual(e.slice(3), ["herdr.space=s2", `herdr.tab=${r.tab}`]);
  const at = (pred) => log.findIndex(pred);
  const park = (t) => at((e) => e[0] === "run" && e[1] === "terminal.park" && e[2].terminal === t);
  const label = (t) => at((e) => e[0] === "hc" && e[1] === "label" && e[2] === t);
  const gets = (t, from, to) => log.slice(from, to).filter((e) => e[0] === "hc" && e[1] === "get" && e[2] === t).length;
  assert.ok(park("t1") < gets("t1", 0, label("t1")) && gets("t1", park("t1"), label("t1")) >= 2);
  assert.ok(label("t1") < park("t2") && park("t2") < label("t2"));
  assert.ok(gets("t2", park("t2"), label("t2")) >= 2);
  // Named source: renamed; the person follows the tab.
  assert.deepEqual(log.filter((e) => e[0] === "run").slice(-3).map((e) => [e[1], e[2]]), [
    ["tab.rename", { id: r.tab, name: "fix login" }],
    ["space.select", { id: "s2" }],
    ["tab.select", { id: r.tab }],
  ]);
}

// Unnamed source: no rename.
{
  const { host, log } = world({ spaceList: spaces(), paneList: [pane(1, "tbB", "t1")] });
  const r = await moveTab({ tab: "tbB", target: "s2" }, host);
  assert.equal(r.ok, true);
  assert.equal(log.some((e) => e[1] === "tab.rename"), false);
  assert.ok(log.some((e) => e[1] === "tab.select"));
}

// A park that never applies gives up with an error and labels nothing into the target.
{
  const { host, log } = world({ spaceList: spaces(), paneList: [pane(1, "tbB", "t1")], lag: Infinity });
  const r = await moveTab({ tab: "tbB", target: "s2" }, host);
  assert.match(r.error, /did not detach/);
  assert.equal(log.some((e) => e[1] === "label" && e.includes("herdr.space=s2")), false);
}

// A label that fails on the second terminal: the first one, already adopted into the target, is parked and
// labelled back, both show in the original tab again, and the error says so.
{
  const { host, labels, log, doubles } = world({
    spaceList: spaces(),
    paneList: [pane(1, "tbA", "t1"), pane(2, "tbA", "t2")],
    failLabel: "t2",
  });
  const r = await moveTab({ tab: "tbA", target: "s2" }, host);
  assert.deepEqual(doubles, []);
  // The named tab may have closed with its last pane: the name is set again.
  assert.deepEqual(log.filter((e) => e[1] === "tab.rename").map((e) => e[2]), [{ id: "tbA", name: "fix login" }]);
  assert.match(r.error, /Could not move terminal t2/);
  assert.match(r.error, /Put back: t1, t2/);
  for (const t of ["t1", "t2"]) assert.deepEqual([labels[t]["herdr.space"], labels[t]["herdr.tab"]], ["s1", "tbA"]);
  assert.deepEqual(host.panes().map((p) => [p.terminal, p.tab]), [["t1", "tbA"], ["t2", "tbA"]]);
}

// A rejected hc call after the first park restores too, and still does not throw.
{
  const { host, labels } = world({ spaceList: spaces(), paneList: [pane(1, "tbA", "t1"), pane(2, "tbA", "t2")], throwLabel: "t2" });
  const r = await moveTab({ tab: "tbA", target: "s2" }, host);
  assert.match(r.error, /socket closed.*Put back: t1, t2/);
  for (const t of ["t1", "t2"]) assert.equal(labels[t]["herdr.tab"], "tbA");
  assert.equal(host.panes().length, 2);
}

// A park that lands after the first wait is waited for, not repeated, so the terminal is not stranded.
{
  const { host, labels, doubles } = world({ spaceList: spaces(), paneList: [pane(1, "tbB", "t1")], lag: 80 });
  const r = await moveTab({ tab: "tbB", target: "s2" }, host);
  assert.match(r.error, /did not detach.*Put back: t1/);
  for (let i = 0; i < 300; i++) await host.sleep(100);
  assert.deepEqual(host.panes().map((p) => [p.terminal, p.tab]), [["t1", "tbB"]]);
  assert.equal(labels.t1["herdr.space"], "s1");
  assert.deepEqual(doubles, []);
}

// A park that never lands leaves the terminal where it was, reported as left in place, with no second park.
{
  const { host, doubles } = world({ spaceList: spaces(), paneList: [pane(1, "tbB", "t1")], lag: Infinity });
  const r = await moveTab({ tab: "tbB", target: "s2" }, host);
  assert.match(r.error, /did not detach.*Left in place: t1/);
  assert.equal(host.panes().length, 1);
  assert.deepEqual(doubles, []);
}

// A relabel that throws during the restore falls back to terminal.keep, which brings the terminal back.
{
  const { host, log, doubles } = world({ spaceList: spaces(), paneList: [pane(1, "tbA", "t1"), pane(2, "tbA", "t2")], throwAllLabels: "t2" });
  const r = await moveTab({ tab: "tbA", target: "s2" }, host);
  assert.match(r.error, /socket closed.*Put back: t1, t2/);
  assert.ok(log.some((e) => e[1] === "terminal.keep" && e[2].terminal === "t2"));
  assert.deepEqual(host.panes().map((p) => [p.terminal, p.tab]), [["t1", "tbA"], ["t2", "tbA"]]);
  assert.deepEqual(doubles, []);
}

// Never throws.
assert.ok((await moveTab({ tab: "tbB", target: "s2" }, { spaces: () => { throw new Error("boom"); } })).error);

console.log("move.test.mjs ok");
