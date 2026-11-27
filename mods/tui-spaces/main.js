// Includes code from herdrdev/herdr-app@034f8b85f7e6bb71f8ff55cb4a80c548b2578c0f, defaults/mods/picker/main.js.
// Licensed under Apache-2.0; modified. Line ranges: PROVENANCE.md.
// Herdr TUI Workspace Picker (prefix + w):
// Lists ALL spaces immediately (never hiding quiet spaces behind "earlier"),
// with active indicator, colored space badge, branch/folder, tab & agent counts.
// Type to filter, ↑/↓ or Ctrl+N/P to move, Enter to switch space, Ctrl+D to close space, Esc to close.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  agents,
  closeOverlay,
  hc,
  home,
  panes,
  props,
  run,
  setShared,
   settings,
  shared,
  spaces,
  theme,
} from "herdr";

const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(
    Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)),
  );
  let changed =
    Object.keys(kept).length !==
    Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) =>
      uses(c) < uses(best) ? c : best,
    );
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}

function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);
const HEAD_H = 26;

// A mark that reads on a hex fill: dark on a light one, white on a dark one.
function ink(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#2b2416" : "#ffffff";
}

function shortFolder(folder, userHome) {
  if (!folder) return "~";
  if (userHome && folder === userHome) return "~";
  if (userHome && folder.startsWith(userHome + "/")) {
    return "~/" + folder.slice(userHome.length + 1);
  }
  return folder;
}

export default class TuiSpaces extends View {
  init(_props, cx) {
    this.userHome = home();
    this.filter = "";
    this.input = InputState.new({
      placeholder: "Switch workspace (type to filter)…",
    });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => {
      const pickable = this.pickableRows();
      this.go(pickable[this.at]);
    });
    this.input.focus();
    cx.timer.after(60, () => this.input.focus());
    this.at = null;
    this.scroll = 0;
    this.machines = [];
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) {
          this.machines = (JSON.parse(r.stdout).machines ?? [])
            .filter((m) => m.state === "connected" && !m.temporary)
            .map((m) => m.name);
        }
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const f = this.filter.trim().toLowerCase();
    const allAgents = agents();
    const allPanes = panes();
    const spList = spaces();
    const out = [];
    const ws = [];
    // Folders come from the space-folders mod: this computer's first, then each machine's.
    const byMachine = Object.entries(shared("space-folders") ?? {}).sort(
      ([a], [b]) => (a === "" ? -1 : 0) - (b === "" ? -1 : 0),
    );
    const defs = byMachine.flatMap(([mk, m]) =>
      (m.list ?? []).map((d) => ({ ...d, fid: `${mk}/${d.id}` })),
    );

    spList.forEach((w, idx) => {
      const spaceAgents = allAgents.filter((a) => a.space === w.id);
      const tabIds = new Set((w.tabs ?? []).map((t) => t.id));
      const firstCwd =
        allPanes.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || w.folder || "";
      const folderLabel = shortFolder(firstCwd, this.userHome);
      const branch =
        w.branch ||
        allPanes.find((p) => tabIds.has(p.tab) && p.branch)?.branch ||
        "";
      const mk = w.machine ?? "";
      const m = (shared("space-folders") ?? {})[mk];
      const id = m?.of?.[localId(w)];
      const folder = id && defs.find((d) => d.fid === `${mk}/${id}`);
      const hay = [
        w.name,
        folder?.name ?? "",
        branch,
        folderLabel,
        w.machine ?? "local",
        ...spaceAgents.map((a) => a.program?.name ?? ""),
        ...(w.tabs ?? []).map((t) => t.name),
      ]
        .join(" ")
        .toLowerCase();

      if (f && !hay.includes(f)) return;

      const counts = { blocked: 0, done: 0, working: 0, idle: 0 };
      for (const a of spaceAgents) {
        if (counts[a.status] !== undefined) counts[a.status]++;
      }

      ws.push({
        kind: "workspace",
        fid: folder?.fid,
        w,
        index: idx + 1,
        branch,
        folderLabel,
        tabCount: (w.tabs ?? []).filter((t) => !t.settled).length || (w.tabs ?? []).length,
        agentCount: spaceAgents.length,
        counts,
      });
    });

    const groups = defs
      .map((d) => ({ ...d, items: ws.filter((r) => r.fid === d.fid) }))
      .filter((g) => g.items.length);
    if (groups.length) {
      const loose = ws.filter((r) => !r.fid);
      if (loose.length) groups.push({ fid: "none", name: "No folder", items: loose });
      for (const g of groups) {
        out.push({ kind: "folder", fid: g.fid, name: g.name, color: g.color, count: g.items.length });
        out.push(...g.items);
      }
    } else {
      out.push(...ws);
    }

    out.push({ kind: "new-space", machine: null });
    for (const m of this.machines) {
      out.push({ kind: "new-space", machine: m });
    }
    return out;
  }

  pickableRows() {
    return this.rows().filter((r) => r.kind !== "folder");
  }

  go(r) {
    if (!r) return;
    this.close();
    if (r.kind === "workspace") {
      run("space.select", { id: r.w.id });
    } else if (r.kind === "new-space") {
      run("space.new", { machine: r.machine ?? "" });
    }
  }

  statusSummary(t, r) {
    if (r.agentCount === 0) {
      return div().text_size(11).text_color(t.dim).child("no agents");
    }
    const { blocked, done, working, idle } = r.counts;
    if (blocked === 0 && done === 0 && working === 0) {
      return h_flex()
        .gap(4)
        .items_center()
        .text_size(11)
        .text_color(t.dim)
        .child(div().text_color(t.idle ?? t.dim).child("○"))
        .child("all idle");
    }
    return h_flex()
      .gap(8)
      .items_center()
      .text_size(11)
      .when(blocked > 0, (el) =>
        el.child(
          h_flex()
            .gap(3)
            .items_center()
            .text_color(t.blocked)
            .child("●")
            .child(`${blocked} blocked`),
        ),
      )
      .when(done > 0, (el) =>
        el.child(
          h_flex()
            .gap(3)
            .items_center()
            .text_color(t.done)
            .child("●")
            .child(`${done} done`),
        ),
      )
      .when(working > 0, (el) =>
        el.child(
          h_flex()
            .gap(4)
            .items_center()
            .text_color(t.working)
            .child(
              svg("mods/workspace-chrome/spinner.svg")
                .size(11)
                .flex_none()
                .text_color(t.working)
                .spin(900),
            )
            .child(`${working} working`),
        ),
      )
      .when(idle > 0, (el) =>
        el.child(
          h_flex()
            .gap(3)
            .items_center()
            .text_color(t.dim)
            .child("○")
            .child(`${idle}`),
        ),
      );
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind !== "folder");
    const grouped = pickable.length < rows.length;
    if (this.at === null) {
      const activeIdx = pickable.findIndex(
        (r) => r.kind === "workspace" && r.w.active,
      );
      this.at = Math.max(0, activeIdx);
    }
    if (pickable.length > 0) {
      this.at = Math.max(0, Math.min(this.at, pickable.length - 1));
    } else {
      this.at = 0;
    }
    const sel = pickable[this.at];

    const ROW_H = 38;
    const heights = rows.map((r) => (r.kind === "folder" ? HEAD_H : ROW_H));
    const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
    const total = tops.length ? tops[tops.length - 1] + heights[heights.length - 1] : 0;
    const height = Math.min(380, this.listHeight ?? 380);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + heights[si] > this.scroll + height) {
        this.scroll = tops[si] + heights[si] - height;
      }
    }
    const place = (el, i) =>
      fixed
        ? el
            .absolute()
            .left(0)
            .right(0)
            .top(tops[i] - this.scroll)
            .bottom(height - (tops[i] + heights[i] - this.scroll))
        : el;
    const visible = (i) =>
      !fixed ||
      (tops[i] + heights[i] > this.scroll && tops[i] < this.scroll + height);

    const drawRow = (r) => {
      const on = r === sel;
      if (r.kind === "folder") {
        const color = r.color ? (MARK[r.color] ?? r.color) : t.dim;
        return h_flex()
          .id(`ts-folder-${r.fid}`)
          .mx(4)
          .px(10)
          .h(HEAD_H)
          .items_center()
          .gap(8)
          .child(
            h_flex()
              .size(16)
              .flex_none()
              .rounded(4)
              .bg(color)
              .items_center()
              .justify_center()
              .child(
                svg("mods/workspace-chrome/folder.svg")
                  .size(11)
                  .text_color(ink(color)),
              ),
          )
          .child(
            div()
              .text_size(11.5)
              .font_semibold()
              .text_color(t.muted)
              .child(r.name),
          )
          .child(div().text_size(11.5).text_color(t.dim).child(`${r.count}`));
      }
      if (r.kind === "new-space") {
        const label = r.machine
          ? `+ new workspace on ${r.machine}`
          : "+ new workspace";
        return h_flex()
          .id(`ts-new-${r.machine ?? "local"}`)
          .mx(4)
          .px(10)
          .h(ROW_H)
          .items_center()
          .rounded(7)
          .gap(8)
          .text_color(t.muted)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected ?? t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(div().text_color(t.accent).font_semibold().child(label));
      }

      const here = r.w.active;
      const showBranch =
        r.branch &&
        r.branch !== "main" &&
        r.branch !== "master" &&
        r.branch.toLowerCase() !== r.w.name.toLowerCase();

      return h_flex()
        .id(`ts-space-${r.w.id}`)
        .mx(4)
        .pl(grouped ? 26 : 10)
        .pr(10)
        .h(ROW_H)
        .rounded(7)
        .gap(9)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected ?? t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(
          div()
            .w(14)
            .flex_none()
            .text_size(12)
            .text_color(here ? t.accent : t.dim)
            .child(here ? "◉" : `${r.index <= 9 ? r.index : "·"}`),
        )
        .child(
          h_flex()
            .size(20)
            .flex_none()
            .rounded(5)
            .bg(spaceColor(t, r.w))
            .items_center()
            .justify_center()
            .text_size(11)
            .font_bold()
            .text_color("#ffffff")
            .child([...r.w.name][0]?.toUpperCase() ?? "?"),
        )
        .child(
          div()
            .flex_shrink(0)
            .max_w(180)
            .truncate()
            .text_color(t.foreground)
            .when(here, (d) => d.font_semibold())
            .child(r.w.name),
        )
        .when(Boolean(r.w.machine), (el) =>
          el.child(
            div()
              .px(5)
              .py(1)
              .rounded(4)
              .bg(t.surface)
              .text_size(10.5)
              .text_color(t.muted)
              .child(r.w.machine),
          ),
        )
        .when(Boolean(showBranch), (el) =>
          el.child(
            h_flex()
              .gap(4)
              .items_center()
              .text_size(11)
              .text_color(t.muted)
              .child(
                svg("mods/workspace-chrome/branch.svg")
                  .size(11)
                  .text_color(t.dim),
              )
              .child(div().max_w(130).truncate().child(r.branch)),
          ),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(r.folderLabel),
        )
        .child(this.statusSummary(t, r))
        .child(
          div()
            .w(48)
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(`${r.tabCount} tab${r.tabCount === 1 ? "" : "s"}`),
        );
    };

    const totalSpaces = spaces().length;

    return v_flex()
      .id("tui-spaces")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        const ctrl = e.modifiers.control;
        if (k === "escape") return this.close();
        if (k === "down" || (ctrl && k === "n")) {
          if (pickable.length) this.at = (this.at + 1) % pickable.length;
        } else if (k === "up" || (ctrl && k === "p")) {
          if (pickable.length) {
            this.at = (this.at + pickable.length - 1) % pickable.length;
          }
        } else if (k === "d" && ctrl) {
          if (sel?.kind === "workspace") {
            this.close();
            run("space.close", { id: sel.w.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .text_size(15)
                  .font_semibold()
                  .text_color(t.accent)
                  .child("▌"),
              )
              .child(
                div()
                  .text_size(15)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("Switch Workspace"),
              )
              .child(
                div()
                  .text_size(11.5)
                  .text_color(t.dim)
                  .child(`${totalSpaces} spaces`),
              ),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child("Ctrl+Space w · Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(
            svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim),
          )
          .child(
            Input.new(this.input)
              .flex_1()
              .h_full()
              .text_size(12.8)
              .text_color(t.foreground),
          ),
      )
      .child(
        v_flex()
          .id("ts-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(Math.min(380, total))
          .min_h(0)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(
                0,
                Math.min(this.scroll - e.delta.y, maxScroll),
              );
              while (
                this.at < pickable.length - 1 &&
                tops[rows.indexOf(pickable[this.at])] < this.scroll
              ) {
                this.at++;
              }
              while (
                this.at > 0 &&
                tops[rows.indexOf(pickable[this.at])] +
                  heights[rows.indexOf(pickable[this.at])] >
                  this.scroll + height
              ) {
                this.at--;
              }
              cx.notify();
            }),
          )
          .children(
            rows
              .map((r, i) => (visible(i) ? place(drawRow(r), i) : null))
              .filter(Boolean),
          ),
      )
      .child(
        h_flex()
          .pt(4)
          .border_t(1)
          .border_color(t.border)
          .justify_between()
          .text_size(11)
          .text_color(t.dim)
          .child("search type · move ↑↓/ctrl+n/p · open enter · close space ^d · back esc"),
      );
  }
}
