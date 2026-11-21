// Where the person is, as data: folder, space, tab and agent of the focused pane.
// Pure, so it can be tested without Herdr. The folder logic follows the
// space-folders mods: a space dragged into a folder, else the folder whose rules
// reach deepest into the folder the space works in.

const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);

// A rule of a folder's "Collect spaces from": "~" is any home, "*" any one folder
// name, and a rule starting with neither "/" nor "~" is a folder name at any depth.
export function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

const collects = (f, path) => Boolean(path) && (f.match ?? "").split(",").some((p) => rule(p)?.test(path));

const reach = (f, path) => !path ? 0 : Math.max(0, ...(f.match ?? "").split(",").map((p) => {
  const m = rule(p)?.exec(path);
  return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
}));

// Where a space works now: its first terminal's live folder, else where it was made.
function place(s, panes) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// The folder (by name) a space shows in: where it was put, else the one whose
// rules reach deepest; failing both, the folder on this computer that takes in
// its machine. `folders`: the shared "space-folders" value, by machine ("" is here).
export function folderName(s, panes, folders) {
  const mine = folders?.[s.machine ?? ""] ?? { list: [], of: {} };
  const put = (mine.of ?? {})[localId(s)];
  if (put !== undefined) return mine.list.find((f) => f.id === put)?.name ?? null;
  const path = place(s, panes);
  let best = null, most = 0;
  for (const f of mine.list) { const n = reach(f, path); if (n > most) { best = f; most = n; } }
  if (best) return best.name;
  if (!s.machine) return null;
  const local = folders?.[""]?.list ?? [];
  return local.find((f) => collects(f, s.machine) || collects(f, path))?.name ?? null;
}

// { folder, space, tab, agent } for the focused pane, or null with no focus.
// `order`: shared "agents.order".order, agent addresses as the agents list shows them.
export function where({ spaces, panes, folders, focused, agents, order }) {
  const space = focused && spaces.find((s) => s.id === focused.space);
  if (!space) return null;
  const tab = space.tabs.find((t) => t.id === focused.tab);
  const found = focused.pane || focused.terminal
    ? agents.find((a) => (focused.pane && a.pane === focused.pane) || (focused.terminal && a.address === focused.terminal))
    : null;
  const n = found ? (order ?? []).indexOf(found.address) : -1;
  return {
    folder: folderName(space, panes, folders),
    space: space.name,
    tab: tab?.name ?? null,
    agent: found ? { number: n >= 0 ? n + 1 : null, status: found.status, program: found.program ?? null } : null,
  };
}
