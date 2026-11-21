import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY, follow, release, folderKey, locate } from "../follow.js";

const inFolder = (key, folded, machine = null) => ({ folders: [{ key, folded }], machines: [{ key: machine ?? "", folded: false }] });

test("a change of front space opens its saved-folded folder and asks for a reveal", () => {
  const r = follow(EMPTY, "s1", inFolder("|f1", true));
  assert.equal(r.changed, true);
  assert.deepEqual(r.state, { active: "s1", folders: ["|f1"], machines: [] });
});

test("the same front space does nothing, so a manual fold stays", () => {
  const first = follow(EMPTY, "s1", inFolder("|f1", true)).state;
  const again = follow(first, "s1", inFolder("|f1", true));
  assert.equal(again.changed, false);
  assert.equal(again.state, first);
});

test("no front space, or one not drawn yet, is not a change and is retried", () => {
  assert.equal(follow(EMPTY, null, null).changed, false);
  const r = follow(EMPTY, "s1", null);
  assert.equal(r.changed, false);
  assert.equal(r.state.active, null);
  assert.equal(follow(r.state, "s1", inFolder("|f1", true)).changed, true);
});

test("a folder that is not folded is not held open", () => {
  const r = follow(EMPTY, "s1", inFolder("|f1", false));
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.folders, []);
});

test("leaving the space folds back what follow opened", () => {
  const open = follow(EMPTY, "s1", inFolder("|f1", true)).state;
  const left = follow(open, "s2", inFolder("|f2", false));
  assert.deepEqual(left.state, { active: "s2", folders: [], machines: [] });
});

test("moving within the same folder keeps it open", () => {
  const open = follow(EMPTY, "s1", inFolder("|f1", true)).state;
  const next = follow(open, "s2", inFolder("|f1", true));
  assert.deepEqual(next.state.folders, ["|f1"]);
});

test("moving to another folded folder swaps which one is open", () => {
  const open = follow(EMPTY, "s1", inFolder("|f1", true)).state;
  const next = follow(open, "s2", inFolder("|f2", true));
  assert.deepEqual(next.state.folders, ["|f2"]);
});

test("a folded machine and the folder housing it are both opened", () => {
  const loc = { folders: [{ key: "vm|f9", folded: true }, { key: "|f1", folded: true }], machines: [{ key: "vm", folded: true }] };
  assert.deepEqual(follow(EMPTY, "vm/s1", loc).state, { active: "vm/s1", folders: ["vm|f9", "|f1"], machines: ["vm"] });
});

test("the person folding a held-open group folds it with nothing saved", () => {
  const open = follow(EMPTY, "s1", inFolder("|f1", true)).state;
  const held = release(open.folders, "|f1");
  assert.deepEqual(held, []);
  const mine = { ...open, folders: held };
  // Still the same front space: follow does not open it again.
  assert.equal(follow(mine, "s1", inFolder("|f1", true)).changed, false);
});

test("a click on a group follow does not hold is an ordinary toggle", () => {
  assert.equal(release([], "|f1"), null);
  assert.equal(release(["|f2"], "|f1"), null);
});

test("locate reads the folder, the housing folder and the machine from a list entry", () => {
  const saved = new Set(["vm|f9"]);
  const loc = locate(
    { id: "vm/s1", machine: "vm", folder: "f9", host: "f1" },
    (m, id) => saved.has(folderKey(m, id)),
    (m) => m === "vm",
  );
  assert.deepEqual(loc, {
    folders: [{ key: "vm|f9", folded: true }, { key: "|f1", folded: false }],
    machines: [{ key: "vm", folded: true }],
  });
});

test("locate on a space in no folder only has its machine", () => {
  const loc = locate({ id: "s1", machine: null, folder: null, host: null }, () => true, () => false);
  assert.deepEqual(loc, { folders: [], machines: [{ key: "", folded: false }] });
});
