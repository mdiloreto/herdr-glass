// Everything goto can go to, read from the live app: one item per pane, per tab and per space, each with the
// text fields score.js searches and what a row shows. Rebuilt on every render; the lists are small.
import { spaces, panes, terminals, focused, home, shared } from "herdr";
import { namer, programOf, modStatus } from "./name.js";
import { prText } from "./prs.js";

// What `status` an agent's terminal is in, an error counting as blocked, as the other pickers read it.
const ownStatus = (word, address, all) => (all.get(address)?.status === "error" ? "blocked" : word);

const field = (name, text) => ({ name, text: text ?? "" });

// The folder a space sits in, from space-folders' shared state ({ list, of } per machine, "" being this one).
function folderOf(s) {
  const mine = shared("space-folders")?.[s.machine ?? ""];
  const id = mine?.of?.[s.machine ? s.id.slice(s.machine.length + 1) : s.id];
  return mine?.list?.find((f) => f.id === id)?.name ?? "";
}

export function buildIndex() {
  const sp = spaces(), ps = panes(), all = new Map(terminals().map((k) => [k.address, k]));
  const name = namer(), userHome = home(), prs = shared("goto.prs") ?? {};
  const short = (cwd) => (cwd && userHome && (cwd === userHome || cwd.startsWith(`${userHome}/`)) ? `~${cwd.slice(userHome.length)}` : cwd ?? "");
  const prOf = (cwd, branch) => prText(prs[`${cwd}::${branch}`]);
  const prNum = (cwd, branch) => { const n = prs[`${cwd}::${branch}`]?.number; return n ? `#${n}` : ""; };
  const order = shared("agents.order")?.order ?? [];
  const here = focused();
  // ctrl-1..9 jump to order[N-1]: the number a pane would answer to, or 0.
  const jumpOf = (terminal) => { const i = terminal ? order.indexOf(terminal) : -1; return i >= 0 && i < 9 ? i + 1 : 0; };
  const panesOut = [], tabsOut = [], spacesOut = [];

  for (const s of sp) {
    const folder = folderOf(s);
    const common = { space: s.id, spaceName: s.name, folder, machine: s.machine ?? "" };
    for (const c of s.tabs) {
      const inTab = ps.filter((p) => p.tab === c.id && p.mod !== "t3-home");
      const labels = [];
      for (const p of inTab) {
        const label = name(p), program = programOf(p), branch = p.branch ?? s.branch ?? "";
        labels.push(label);
        panesOut.push({
          ...common, id: `pane:${p.pane}`, kind: "pane", pane: p.pane, terminal: p.terminal, tab: c.id, tabName: c.name,
          label, program, programName: program?.name ?? "", branch, cwd: short(p.cwd),
          status: p.mod ? modStatus(p) : ownStatus(p.status, p.terminal, all),
          here: s.active && c.active && p.focused,
          jump: jumpOf(p.terminal),
          fields: [field("label", label), field("tab", c.name), field("space", s.name), field("folder", folder), field("branch", branch),
            field("cwd", short(p.cwd)), field("program", program?.name), field("machine", s.machine), field("pr", prOf(p.cwd, branch))],
          meta: [program?.name, c.name !== label ? c.name : "", s.name, folder, branch, prNum(p.cwd, branch), s.machine].filter(Boolean),
        });
      }
      // A tab nobody named is its position ("4"): it is called after what runs in it.
      const label = c.named ? c.name : labels[0] ?? c.name;
      tabsOut.push({
        ...common, id: `tab:${c.id}`, kind: "tab", tab: c.id, tabName: c.name, label, status: c.status, branch: s.branch ?? "",
        fields: [field("label", label), field("space", s.name), field("folder", folder), field("branch", s.branch), field("machine", s.machine),
          ...labels.map((l) => field("member", l))],
        meta: [s.name, folder, s.branch, `${c.panes} pane${c.panes === 1 ? "" : "s"}`, s.machine].filter(Boolean),
      });
    }
    const tabIds = new Set(s.tabs.map((c) => c.id));
    const cwd = ps.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || s.folder;
    spacesOut.push({
      ...common, id: `space:${s.id}`, kind: "space", label: s.name, status: s.status, branch: s.branch ?? "",
      fields: [field("label", s.name), field("folder", folder), field("branch", s.branch), field("cwd", short(cwd)), field("machine", s.machine),
        field("pr", prOf(cwd, s.branch))],
      meta: [folder, s.branch, short(cwd), `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`, s.machine].filter(Boolean),
    });
  }

  // The pane the last jump left, if it still exists and is not where you are.
  const backPane = shared("goto.back");
  const back = backPane && backPane !== here?.pane && panesOut.some((p) => p.pane === backPane) ? `pane:${backPane}` : null;
  return { items: [...panesOut, ...tabsOut, ...spacesOut], recent: shared("goto.recent") ?? [], order, back };
}

// An agent shows as one, whatever it runs: the tag a row wears while the list is ranked.
export const tagOf = (it) => (it.kind === "pane" ? (it.program?.agent ? "agent" : "pane") : it.kind);
