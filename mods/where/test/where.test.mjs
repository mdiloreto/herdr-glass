import test from "node:test";
import assert from "node:assert/strict";
import { where, folderName, rule } from "../where.js";

const tab = (id, name) => ({ id, name });
const spaces = [
  { id: "s1", name: "herdr", machine: null, folder: "/home/u/code/herdr", tabs: [tab("a", "main"), tab("b", "2")] },
  { id: "s2", name: "scratch", machine: null, folder: "/tmp", tabs: [tab("c", "1")] },
  { id: "vm/s1", name: "api", machine: "vm", folder: "/srv/api", tabs: [tab("vm/d", "logs")] },
];
const panes = [{ pane: "p1", tab: "a", cwd: "/home/u/code/herdr" }, { pane: "p2", tab: "c", cwd: "/tmp" }];
const folders = {
  "": { list: [{ id: "f1", name: "Code", match: "~/code" }, { id: "f2", name: "Servers", match: "vm-*, vm" }], of: {} },
};
const agent = { address: "t7", pane: "p1", status: "working", program: { icon: "icons/claude.svg", tint: false } };

test("a space is in the folder whose rules reach its folder", () => {
  assert.equal(folderName(spaces[0], panes, folders), "Code");
});

test("a space in no folder has none", () => {
  assert.equal(folderName(spaces[1], panes, folders), null);
});

test("a space dragged into a folder wins over rules; \"\" takes it out", () => {
  const put = { "": { ...folders[""], of: { s1: "f2" } } };
  assert.equal(folderName(spaces[0], panes, put), "Servers");
  const out = { "": { ...folders[""], of: { s1: "" } } };
  assert.equal(folderName(spaces[0], panes, out), null);
});

test("the deepest rule wins", () => {
  const deep = { "": { list: [{ id: "a", name: "Code", match: "~/code" }, { id: "b", name: "Herdr", match: "~/code/herdr" }], of: {} } };
  assert.equal(folderName(spaces[0], panes, deep), "Herdr");
});

test("a machine's space shows in the local folder that collects its machine", () => {
  assert.equal(folderName(spaces[2], panes, { "": { list: [{ id: "f2", name: "Servers", match: "vm" }], of: {} } }), "Servers");
  assert.equal(folderName(spaces[2], panes, folders), "Servers");
});

test("rules: ~ is a home, a bare name matches at any depth", () => {
  assert.ok(rule("~/code").test("/home/u/code/x"));
  assert.ok(rule("herdr").test("/a/b/herdr/c"));
  assert.ok(!rule("herdr").test("/a/herdr-mods"));
});

test("a focused agent pane gives folder, space, tab, its number and status", () => {
  const w = where({ spaces, panes, folders, focused: { space: "s1", tab: "a", pane: "p1", terminal: "t7" }, agents: [agent], order: ["t3", "t7"] });
  assert.deepEqual(w, { folder: "Code", space: "herdr", tab: "main", agent: { number: 2, status: "working", program: agent.program } });
});

test("a plain terminal has no agent; no folder gives null", () => {
  const w = where({ spaces, panes, folders, focused: { space: "s2", tab: "c", pane: "p2", terminal: "t9" }, agents: [agent], order: ["t7"] });
  assert.deepEqual(w, { folder: null, space: "scratch", tab: "1", agent: null });
});

test("an agent missing from the order has a status but no number", () => {
  const w = where({ spaces, panes, folders, focused: { space: "s1", tab: "a", pane: "p1", terminal: "t7" }, agents: [agent], order: undefined });
  assert.equal(w.agent.number, null);
  assert.equal(w.agent.status, "working");
});

test("no focus, or a space that is gone, gives null", () => {
  assert.equal(where({ spaces, panes, folders, focused: null, agents: [], order: [] }), null);
  assert.equal(where({ spaces, panes, folders, focused: { space: "zz", tab: "a" }, agents: [], order: [] }), null);
});
