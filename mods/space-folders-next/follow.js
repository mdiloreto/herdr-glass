// Follow: the list shows the space in front. Pure, so it can be tested without Herdr.
//
// Follow acts only when the active space CHANGES, so a fold the person makes
// afterwards stays. What it opens is kept apart from the saved fold state
// ("temp"): the list draws a group folded when it is saved folded and not in
// temp, so opening and re-folding never write a file.

export const EMPTY = { active: null, folders: [], machines: [] };

// `state`: { active, folders, machines } as last returned (folders and machines
// are the temporary opens). `active`: the id of the space in front.
// `loc`: where that space sits, or null while it isn't drawn yet:
// { folders: [{ key, folded }], machines: [{ key, folded }] }, `folded` being
// the saved state. Returns { state, changed }; `changed` means reveal the row.
export function follow(state, active, loc) {
  if (!active || active === state.active || !loc) return { state, changed: false };
  const open = (list) => list.filter((g) => g.folded).map((g) => g.key);
  return { state: { active, folders: open(loc.folders), machines: open(loc.machines) }, changed: true };
}

// A person's own click on a group follow holds open: it just folds again, with
// nothing saved. False means the click is an ordinary toggle.
export function release(list, key) {
  return list.includes(key) ? list.filter((k) => k !== key) : null;
}

export const folderKey = (machine, id) => `${machine ?? ""}|${id}`;

// Where one entry of the list's `seen` sits: its own folder, and the folder on
// this computer housing its machine; its machine's header.
export function locate(entry, folderFolded, machineFolded) {
  const folders = [];
  if (entry.folder) folders.push({ key: folderKey(entry.machine, entry.folder), folded: folderFolded(entry.machine, entry.folder) });
  if (entry.host) folders.push({ key: folderKey(null, entry.host), folded: folderFolded(null, entry.host) });
  return { folders, machines: [{ key: entry.machine ?? "", folded: machineFolded(entry.machine) }] };
}
