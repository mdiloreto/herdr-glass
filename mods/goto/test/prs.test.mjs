// Plain node, no dependencies: node test/prs.test.mjs
import assert from "node:assert/strict";
import { pickPr, prText, ttlOf, refreshPrs } from "../prs.js";

const it = (number, extra = {}) => ({ number, title: `t${number}`, state: "OPEN", isDraft: false, headRefName: "b", isCrossRepository: false, url: `u${number}`, ...extra });

// pickPr: same-repo head only, open first, else newest.
assert.equal(pickPr([], "b"), null);
assert.equal(pickPr(null, "b"), null);
assert.equal(pickPr([it(1, { headRefName: "x" })], "b"), null);
assert.equal(pickPr([it(1, { isCrossRepository: true })], "b"), null);
assert.deepEqual(pickPr([it(1)], "b"), { number: 1, title: "t1", state: "OPEN", isDraft: false, url: "u1" });
assert.equal(pickPr([it(5, { state: "MERGED" }), it(3)], "b").number, 3);
assert.equal(pickPr([it(5, { state: "MERGED" }), it(7, { state: "CLOSED" })], "b").number, 7);
assert.equal(pickPr([it(2), it(4)], "b").number, 4);

// prText
assert.equal(prText(null), "");
assert.equal(prText(it(9)), "#9 t9");
assert.equal(prText(it(9, { isDraft: true })), "#9 t9 · draft");
assert.equal(prText(it(9, { state: "MERGED" })), "#9 t9 · merged");
assert.equal(prText(it(9, { state: "CLOSED", isDraft: true })), "#9 t9 · closed");

// TTLs: open 2 min, merged/closed 1 h, none 10 min, failed 30 s.
assert.equal(ttlOf({ pr: it(1) }), 120_000);
assert.equal(ttlOf({ pr: it(1, { state: "MERGED" }) }), 3_600_000);
assert.equal(ttlOf({ pr: null }), 600_000);
assert.equal(ttlOf({ pr: it(1), failed: true }), 30_000);

// refreshPrs against fakes.
function world({ ghFail = false } = {}) {
  const store = {}, calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "git") {
      const cwd = args[1];
      if (cwd === "/nogit") return { code: 128, stdout: "", stderr: "" };
      if (args.includes("--git-common-dir")) return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    }
    if (ghFail) throw new Error("gh down");
    if (args.includes("--head")) return { code: 0, stdout: "[]", stderr: "" };
    return { code: 0, stdout: JSON.stringify([it(11, { headRefName: "feat" }), it(12, { headRefName: "draft", isDraft: true })]), stderr: "" };
  };
  const pane = (n, cwd, branch, tab = "t1") => ({ pane: `p${n}`, tab, cwd, branch });
  const api = {
    exec, shared: (k) => store[k], setShared: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    panes: () => [pane(1, "/repo", "feat"), pane(2, "/repo/.worktrees/w", "draft"), pane(3, "/repo", "main"), pane(4, "/repo", "none"),
      pane(5, "/repo", "HEAD"), pane(6, "/nogit", "feat"), pane(7, "/repo", "feat", "remote")],
    spaces: () => [{ machine: null, tabs: [{ id: "t1" }] }, { machine: "box", tabs: [{ id: "remote" }] }],
  };
  return { api, store, calls };
}

{
  const { api, store, calls } = world();
  await refreshPrs(api);
  assert.deepEqual(Object.keys(store["goto.prs"]).sort(), ["/repo/.worktrees/w::draft", "/repo::feat", "/repo::none"]);
  assert.equal(store["goto.prs"]["/repo::feat"].number, 11);
  assert.equal(store["goto.prs"]["/repo/.worktrees/w::draft"].isDraft, true);
  assert.equal(store["goto.prs"]["/repo::none"], null);
  const gh = calls.filter((c) => c.startsWith("gh"));
  assert.equal(gh.filter((c) => c.includes("--author @me")).length, 1, "one list per repo");
  assert.equal(gh.filter((c) => c.includes("--head none")).length, 1, "head lookup for the branch not in the list");
  assert.equal(gh.length, 2);
  // Fresh cache: nothing more to call.
  const n = calls.length;
  await refreshPrs(api);
  assert.equal(calls.filter((c) => c.startsWith("gh")).length, 2);
  assert.ok(calls.length > n, "git is still asked for the repo key");
}

{
  // A failed gh leaves old data and caches the failure for 30 s.
  const { api, store, calls } = world({ ghFail: true });
  store["goto.prcache"] = { lists: {}, heads: { "/repo/.git::feat": { at: 0, pr: { number: 3, title: "old", state: "OPEN", isDraft: false, url: "u" } } } };
  await refreshPrs(api);
  assert.equal(store["goto.prs"]["/repo::feat"].number, 3);
  assert.equal(store["goto.prcache"].heads["/repo/.git::feat"].failed, true);
  const n = calls.filter((c) => c.startsWith("gh")).length;
  await refreshPrs(api);
  assert.equal(calls.filter((c) => c.startsWith("gh")).length, n, "failure is not retried within 30 s");
}

{
  // Never throws.
  await refreshPrs({ panes: () => { throw new Error("x"); } });
}

console.log("prs ok");
