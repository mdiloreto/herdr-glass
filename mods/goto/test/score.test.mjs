// Plain node, no dependencies: node test/score.test.mjs
import assert from "node:assert/strict";
import { fuzzy, parseQuery, inScope, scoreItem, rank, orderEmpty } from "../score.js";

const item = (id, kind, label, extra = {}, rest = []) => ({
  id, kind, status: null, ...extra,
  fields: [{ name: "label", text: label }, ...rest],
});
const ids = (list) => list.map((r) => r.item.id);

// In-order letters: matches only when every letter follows the one before.
assert.deepEqual(fuzzy("fre", "Finish release").hits, [0, 7, 8]);
assert.equal(fuzzy("rf", "Finish release"), null);
assert.equal(fuzzy("xyz", "Finish release"), null);
assert.deepEqual(fuzzy("fr", "Finish release").hits, [0, 7]);

// Word starts and runs rank higher: "fr" is the F and R of "Finish release", not the f..r inside "fix-error-reporter".
const words = [item("a", "pane", "fix-error-reporter"), item("b", "pane", "Finish release")];
assert.deepEqual(ids(rank(words, "fr")), ["b", "a"]);
// A run beats scattered letters.
const runs = [item("a", "pane", "deploy-staging-api"), item("b", "pane", "api deploy")];
assert.deepEqual(ids(rank(runs, "api")), ["b", "a"]);

// Case and spaces in the query do not matter.
assert.deepEqual(ids(rank([item("a", "pane", "Finish release")], parseQuery("FIN rel").q)), ["a"]);

// Field weights: a label match beats the same match in a tab, a space or a branch.
const where = (name) => item(name, "pane", "unrelated", {}, [{ name, text: "billing" }]);
const byField = rank([where("branch"), where("space"), where("tab"), item("label", "pane", "billing")], "billing");
assert.deepEqual(ids(byField), ["label", "tab", "space", "branch"]);
// The best field wins, and the label's letters are lit only when the label matched.
const tabHit = scoreItem("bill", where("tab"));
assert.equal(tabHit.field, "tab");
assert.deepEqual(tabHit.hits, []);
assert.deepEqual(scoreItem("bil", item("x", "pane", "billing")).hits, [0, 1, 2]);
// A field that is long and weak never turns a match into a loss.
assert.ok(scoreItem("a", item("x", "pane", "x", {}, [{ name: "cwd", text: "~/a" + "b".repeat(200) }])).score > 0);
assert.equal(scoreItem("zzz", where("tab")), null);

// Scopes by the first character; the rest is the search.
assert.deepEqual(parseQuery("fix"), { scope: "all", q: "fix" });
assert.deepEqual(parseQuery("@fix up"), { scope: "pane", q: "fixup" });
assert.deepEqual(parseQuery("#Docs"), { scope: "tab", q: "docs" });
assert.deepEqual(parseQuery("/cloud"), { scope: "space", q: "cloud" });
assert.deepEqual(parseQuery("!"), { scope: "blocked", q: "" });
assert.deepEqual(parseQuery(">layout"), { scope: "palette", q: "layout" });
assert.deepEqual(parseQuery("  @x"), { scope: "pane", q: "x" });
assert.deepEqual(parseQuery(""), { scope: "all", q: "" });
// Only the first character counts.
assert.deepEqual(parseQuery("a@b"), { scope: "all", q: "a@b" });

const mixed = [
  item("p1", "pane", "one", { status: "blocked" }),
  item("p2", "pane", "two", { status: "idle" }),
  item("t1", "tab", "three", { status: "blocked" }),
  item("s1", "space", "four"),
];
const of = (scope) => mixed.filter((it) => inScope(it, scope)).map((it) => it.id);
assert.deepEqual(of("all"), ["p1", "p2", "t1", "s1"]);
assert.deepEqual(of("pane"), ["p1", "p2"]);
assert.deepEqual(of("tab"), ["t1"]);
assert.deepEqual(of("space"), ["s1"]);
assert.deepEqual(of("blocked"), ["p1"]);

// Recency breaks a tie, newest visit first; no visit comes last, in the order given.
const same = [item("a", "pane", "build"), item("b", "pane", "build"), item("c", "pane", "build"), item("d", "pane", "build")];
assert.deepEqual(ids(rank(same, "build", ["c", "a"])), ["c", "a", "b", "d"]);
assert.deepEqual(ids(rank(same, "build")), ["a", "b", "c", "d"]);
// It never outranks a better match.
assert.deepEqual(ids(rank([item("a", "pane", "xbuild"), item("b", "pane", "build")], "build", ["a"])), ["b", "a"]);

// Empty query: back first, then blocked, then visited (newest first), then ctrl-1..9 order, then as given.
const empty = [
  item("r1", "pane", "r1", { terminal: "t9" }),
  item("r2", "pane", "r2", { terminal: "t2" }),
  item("v1", "pane", "v1", { terminal: "t5" }),
  item("v2", "pane", "v2", { terminal: "t6" }),
  item("bk", "pane", "bk", { terminal: "t7" }),
  item("bl", "pane", "bl", { terminal: "t8", status: "blocked" }),
  item("bl2", "pane", "bl2", { terminal: "t1", status: "blocked" }),
];
const shown = orderEmpty(empty, { recent: ["v2", "v1"], order: ["t1", "t2"], back: "bk" }).map((it) => it.id);
assert.deepEqual(shown, ["bk", "bl2", "bl", "v2", "v1", "r2", "r1"]);
// A blocked pane that is also the back target is still first as the back row.
assert.equal(orderEmpty(empty, { back: "bl" })[0].id, "bl");

console.log("score.test.mjs: ok");
