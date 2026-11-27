// Copied from JinJieBeWater/herdr-t3@17bbad1f7206ce4c5fb165059976887fde6a0fbc, mods/t3-picker/name.js.
// Licensed under Apache-2.0; modified. Line ranges: PROVENANCE.md.
// What a pane is called, as t3-picker's namer (copy), except that an agent's own session name, the label its
// statusline puts on the terminal (claude.title, as agent-names reads it), comes first.
import { terminals, spaces, shared } from "herdr";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const MARK = { pi: /^π - /u, opencode: /^OC \| / };
const OWN = {
  pi: (s, folder) => { s = s.replace(MARK.pi, ""); return folder && s.endsWith(` - ${folder}`) ? s.slice(0, -folder.length - 3) : s; },
  opencode: (s) => s.replace(MARK.opencode, ""),
};

// What a pane runs, for its icon: its program, or for a mod pane what its mod gives in shared("<mod>.program").
export const programOf = (x) => x.mod ? shared(`${x.mod}.program`) ?? null : x.program;

// What a mod pane reports of its tab in shared("<mod>.status"), as the word an agent would.
export const modStatus = (x) => shared(`${x.mod}.status`)?.[x.tab] ?? null;

const isAgyProgram = (program) => {
  const key = program?.key?.toLowerCase();
  const name = program?.name?.toLowerCase();
  return key === "antigravity" || key === "agy" || name === "antigravity";
};

function sessionLabel(program, labels) {
  if (!program?.agent || !labels) return null;
  const keys = [
    "agent.title",
    "session.title",
    ...(isAgyProgram(program) ? ["agy.title"] : []),
    "claude.title",
  ];
  for (const k of keys) {
    const val = labels[k]?.trim();
    if (val) return val;
  }
  return null;
}

// Snapshot once per index build; the returned function takes a pane.
export function namer() {
  const term = new Map(terminals().map((k) => [k.address, k]));
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((c) => [c.id, { ...c, space: s.name }])));
  return (x) => {
    if (x.mod) return shared(`${x.mod}.titles`)?.[x.tab] || x.title;
    const address = x.address ?? x.terminal;
    const termLabels = term.get(address)?.labels;
    const session = sessionLabel(x.program, termLabels);
    if (session) return session;
    const tab = tabs.get(x.tab);
    // A title that only names the folder says what the space already does.
    const folder = (term.get(address)?.cwd ?? x.cwd ?? "").split(/[\\/]/).pop();
    const own = OWN[x.program?.key];
    // An agent's title outlives it: not an agent and in an agent's marks, the title is one left behind.
    const left = !x.program?.agent && Object.values(MARK).some((m) => m.test(clean(x.title)));
    const live = left ? "" : own ? own(clean(x.title), folder) : clean(x.title);
    const telling = live && live !== x.program?.name && live.toLowerCase() !== x.program?.key
      && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live !== address
      && live !== folder && live !== (x.space_name ?? tab?.space);
    return (x.program?.key === "pi" && term.get(address)?.labels?.["pi.session"]) || (x.status != null && tab?.named && tab.name)
      || (telling && live) || x.program?.name || address || "shell";
  };
}
