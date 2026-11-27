// Includes code from JinJieBeWater/herdr-t3@17bbad1f7206ce4c5fb165059976887fde6a0fbc, mods/t3-picker/main.js.
// Licensed under Apache-2.0; modified. Line ranges: PROVENANCE.md.
// Go to anything: one overlay to jump to any agent, pane, tab or space. t3-picker's quick pane list and
// tui-goto's preview and actions in one, ranked by the command palette's fuzzy scorer (score.js).
// Empty: the pane you came from, then agents needing you, then the ones you visited last, grouped.
// Typing: one ranked list. A leading @ # / ! narrows it (agents, tabs, spaces, blocked), > opens the palette.
// Enter goes, ↑/↓ or ctrl+j/k move, alt+1..9 go to the Nth row in view, ctrl+r renames a tab or space,
// ctrl+d (twice) closes, ctrl+y sends Enter to an agent, ctrl+p toggles the preview, Esc leaves.
// Two more modes pick a destination instead of a place to go: "move-tab" (a space for the focused tab) and
// "move-space" (a sidebar folder for the focused space). A copy with props {daemon: true} only waits for the
// goto.move-tab / goto.move-space keys, because an overlay that is not shown never receives key commands.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, run, hc, closeOverlay, openOverlay, nextCommand, notify, props, focused, shared, setShared, settings, exec, panes, spaces, checking, agents, layout } from "herdr";
import { buildIndex } from "./index.js";
import { moveTab } from "./move.js";
import { refreshPrs } from "./prs.js";
import { normalize, parseQuery, inScope, rank, orderEmpty } from "./score.js";
import { focusPane } from "./zoom.js";
import { row, header, preview, ROW_H, HEAD_H } from "./rows.js";

const GROUPS = [["pane", "Agents & panes"], ["tab", "Tabs"], ["space", "Spaces"]];
const CHIPS = [["@", "agents"], ["#", "tabs"], ["/", "spaces"], ["!", "blocked"], [">", "commands"]];
// The preview needs room beside the list.
const PREVIEW_MIN = 700;
// A popup can size itself to its content, and the list's rows are absolute (no height of their own),
// so the body holds its own height or the popup collapses to one row.
const BODY_H = 520;
const MODIFIERS = new Set(["control", "shift", "alt", "platform", "function"]);
// Ctrl+Y arms for this long; a held key's repeats never arm or fire.
const ENTER_ARM_MS = 5000;
// The agent's own status, not the one the list maps an errored shell to: only a real blocked agent is answered.
const isBlockedAgent = (terminal) => agents().find((a) => a.address === terminal)?.status === "blocked";
// Whether the shown layout has a goto daemon block: it can run a move for a popup that may be closed.
const daemonShown = (node) => Boolean(node && typeof node === "object" &&
  ((node.content?.mod === "goto" && node.content?.props?.daemon) || Object.values(node).some(daemonShown)));
const zoom = () => Number(settings()?.zoom) || 1;
// The popup as mod.json gives it, for the copy the keys open.
const POPUP = { mod: "goto", kind: "popup", frame: "none", at: "top", offset: 72, width: 1120, height: 680 };

// The rows of the "move-space" mode: the space's machine's folders, and out of every folder.
function folderItems(space) {
  const s = spaces().find((x) => x.id === space);
  if (!s) return [];
  const mine = shared("space-folders")?.[s.machine ?? ""] ?? { list: [], of: {} };
  const current = mine.of?.[s.machine ? s.id.slice(s.machine.length + 1) : s.id];
  const item = (folderId, label, meta) => ({ id: `folder:${folderId ?? ""}`, kind: "folder", folderId, label, meta, status: null, fields: [{ name: "label", text: label }] });
  return [
    ...(mine.list ?? []).map((f) => item(f.id, f.name, f.id === current ? ["Current folder"] : [])),
    item(null, "No folder", ["Out of every folder"]),
  ];
}

export default class Goto extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.daemon = Boolean(given.daemon);
    if (this.daemon) {
      cx.spawn(async () => {
        for (;;) {
          const c = String(await nextCommand()).split(".").pop();
          const here = focused();
          if (!here) continue;
          if (c === "move-tab") openOverlay({ ...POPUP, props: { mode: "move-tab", tab: here.tab } });
          else if (c === "move-space") openOverlay({ ...POPUP, props: { mode: "move-space", space: here.space } });
        }
      });
      // A tab dropped on a space in the sidebar (space-folders-next asks here): cleared before it runs.
      // One move at a time: moves of the same terminals would race, so a request that arrives meanwhile is dropped.
      let moving = false;
      cx.timer.every(250, (cx) => {
        const req = shared("goto.move-tab");
        if (!req) return;
        setShared("goto.move-tab", null);
        const age = Date.now() - req.at;
        if (!(age >= 0 && age < 10000)) return;
        if (moving) return notify({ title: "Still moving a tab", body: "Try again when it has finished.", level: "warning" });
        moving = true;
        cx.spawn(async (cx) => {
          try {
            const r = await moveTab({ tab: req.tab, target: req.target }, { spaces, panes, run, hc, sleep: (ms) => cx.sleep(ms) });
            if (r.error) notify({ title: "Couldn't move the tab", body: r.error, level: "error" });
          } finally { moving = false; }
        });
      });
      return;
    }
    this.query = "";
    this.mode = given.mode ?? "search";
    this.moving = this.mode === "move-tab" || this.mode === "move-space";
    this.moveId = given.tab ?? given.space;
    this.busy = false;
    this.status = null;
    let placeholder = "Go to an agent, tab or space…";
    if (this.mode === "move-tab") placeholder = `Move tab "${buildIndex().items.find((it) => it.id === `tab:${this.moveId}`)?.label ?? ""}" to…`;
    else if (this.mode === "move-space") placeholder = `Move space "${spaces().find((s) => s.id === this.moveId)?.name ?? ""}" to folder…`;
    this.at = 0;
    this.reveal = true;
    this.armed = null;
    this.armedEnter = null;
    this.scrollTop = 0;
    this.listH = 380;
    this.width = 900;
    this.rows = [];
    this.visible = [];
    this.current = null;
    this.maxScroll = 0;
    this.showPreview = true;
    this.previewTerm = null;
    this.previewText = "";
    this.fetchedAt = 0;
    this.fetching = false;
    this.closed = false;
    this.input = InputState.new({ placeholder });
    this.input.on("change", (_e, cx) => {
      if (this.mode === "rename") return;
      this.query = this.input.value();
      this.at = 0;
      this.scrollTop = 0;
      this.armed = null;
      this.armedEnter = null;
      this.status = null;
      if (this.mode === "search" && this.query.trimStart().startsWith(">")) return this.toPalette();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    // The screen of the selected pane, again every 1.5 s, at once for a new selection. Only while this is open.
    cx.timer.every(400, (cx) => this.tick(cx));
    // PRs of the panes' branches, fetched in the background; shared changes re-render this by themselves.
    if (!checking() && !this.moving) cx.spawn(async () => { await refreshPrs({ exec, panes, spaces, shared, setShared }); });
  }

  async close() { this.closed = true; }

  dismiss() { closeOverlay(props().overlay); }

  // The palette takes no starting text: it just opens.
  toPalette() {
    this.dismiss();
    run("app.palette");
  }

  tick(cx) {
    if (this.armedEnter && Date.now() - this.armedEnter.at > ENTER_ARM_MS) { this.armedEnter = null; cx.notify(); }
    const term = this.showPreview && this.width >= PREVIEW_MIN && this.current?.kind === "pane" ? this.current.terminal : null;
    if (this.closed || !term || this.fetching) return;
    if (term === this.previewTerm && Date.now() - this.fetchedAt < 1500) return;
    if (term !== this.previewTerm) this.previewText = "";
    this.previewTerm = term;
    this.fetchedAt = Date.now();
    this.fetching = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", term, "--lines", "26"]);
        if (r.code === 0 && this.previewTerm === term && !this.closed) {
          this.previewText = r.stdout.replace(/\s+$/, "");
          cx.notify();
        }
      } catch {} finally { this.fetching = false; }
    });
  }

  // The rows for the query: grouped when nothing is typed, else ranked.
  build() {
    if (this.moving) return this.buildMove();
    const { scope, q } = parseQuery(this.query);
    const idx = buildIndex();
    const pool = idx.items.filter((it) => inScope(it, scope));
    const entries = [];
    const grouped = !q && scope === "all";
    const plain = (list) => list.map((it) => ({ it, hits: [], back: it.id === idx.back }));
    if (grouped) {
      for (const [kind, head] of GROUPS) {
        const list = orderEmpty(pool.filter((it) => it.kind === kind), idx);
        if (list.length) entries.push({ head }, ...plain(list));
      }
    } else if (!q) {
      entries.push(...plain(orderEmpty(pool, idx)));
    } else {
      entries.push(...rank(pool, q, idx.recent).map((r) => ({ it: r.item, hits: r.hits })));
    }
    return { scope, q, entries, grouped };
  }

  // The move modes' rows: this computer's other spaces (a tab can only move there), or the folders.
  buildMove() {
    const q = normalize(this.query);
    let items;
    if (this.mode === "move-tab") {
      const own = spaces().find((s) => s.tabs.some((c) => c.id === this.moveId))?.id;
      items = buildIndex().items.filter((it) => it.kind === "space" && !it.machine && it.space !== own);
    } else items = folderItems(this.moveId);
    const entries = q ? rank(items, q).map((r) => ({ it: r.item, hits: r.hits })) : items.map((it) => ({ it, hits: [] }));
    return { scope: "all", q, entries, grouped: false };
  }

  // Enter on a row in a move mode: a space for the tab (shown here if it fails), a folder for the space
  // (space-folders-next applies the request).
  move(it, cx) {
    if (this.busy) return;
    if (this.mode === "move-space") {
      setShared("space-folders.move", { space: this.moveId, folder: it.folderId, at: Date.now() });
      return this.dismiss();
    }
    // The daemon outlives this popup (Esc, a click beside it), so it runs the move when it can. A layout switch
    // mid-move is a known gap: another layout starts its mods fresh and cancels the running task.
    if (daemonShown(layout())) {
      setShared("goto.move-tab", { tab: this.moveId, target: it.space, at: Date.now() });
      return this.dismiss();
    }
    this.busy = true;
    this.status = "Moving…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await moveTab({ tab: this.moveId, target: it.space }, { spaces, panes, run, hc, sleep: (ms) => cx.sleep(ms) });
      this.busy = false;
      if (r.error) {
        this.status = r.error;
        cx.notify();
      } else this.dismiss();
    });
  }

  go(it, cx) {
    if (!it) return;
    if (this.moving) return this.move(it, cx);
    // The pane this leaves, for the next open's Back row: only jumps from here are seen.
    const from = focused()?.pane;
    if (from && it.pane !== from) setShared("goto.back", from);
    setShared("goto.recent", [it.id, ...(shared("goto.recent") ?? []).filter((id) => id !== it.id)].slice(0, 40));
    this.dismiss();
    if (it.kind === "space") run("space.select", { id: it.space });
    else if (it.kind === "tab") run("tab.select", { id: it.tab });
    else focusPane(it.pane);
  }

  submit(cx) {
    const it = this.current;
    if (this.mode === "rename" && this.renameOf) {
      const name = this.input.value().trim();
      const { kind, tab, space } = this.renameOf;
      this.endRename();
      run(kind === "tab" ? "tab.rename" : "space.rename", kind === "tab" ? { id: tab, name } : { id: space, name });
      cx.notify();
    } else this.go(it, cx);
  }

  startRename(it) {
    if (!it || (it.kind !== "tab" && it.kind !== "space")) return;
    const cur = it.kind === "tab" ? it.tabName : it.spaceName;
    this.mode = "rename";
    this.renameOf = it;
    this.input.set_value(cur);
    this.input.set_selected_range({ start: 0, end: cur.length });
    this.input.focus();
  }

  endRename() {
    this.renameOf = null;
    this.input.set_value(this.query);
    this.mode = "search";
  }

  // ctrl+d asks, a second ctrl+d on the same row does it.
  askClose(it) {
    if (!it) return;
    if (this.armed !== it.id) { this.armed = it.id; return; }
    this.armed = null;
    if (it.kind === "pane") run("pane.close", { pane: it.pane });
    else if (it.kind === "tab") run("tab.close", { id: it.tab, confirmed: true });
    else run("space.close", { id: it.space, confirmed: true });
  }

  // ctrl+y asks, a second ctrl+y on the same terminal within a few seconds sends it Enter. A hover moves the
  // target, so only a blocked agent qualifies, and the arm is on the terminal, not the row.
  askEnter(it, cx) {
    this.notBlocked = false;
    const term = it?.kind === "pane" ? it.terminal : null;
    if (!term || !isBlockedAgent(term)) { this.armedEnter = null; this.notBlocked = true; return; }
    const a = this.armedEnter;
    if (!a || a.terminal !== term || Date.now() - a.at > ENTER_ARM_MS) { this.armedEnter = { terminal: term, at: Date.now() }; return; }
    this.armedEnter = null;
    cx.spawn(async () => { await hc(["keys", term, "enter"]); this.fetchedAt = 0; });
  }

  onKey(e, cx) {
    const k = e.key, ctrl = e.modifiers.control, n = this.rows.length;
    // A move that is half done must finish: leaving now would strand its terminals.
    if (this.busy) { cx.stop_propagation(); return; }
    if (k === "escape") {
      if (this.mode !== "rename") return this.dismiss();
      this.endRename();
    } else if (e.modifiers.alt && /^[1-9]$/.test(k)) {
      this.go(this.visible[Number(k) - 1], cx);
    } else if (k === "down" || (ctrl && k === "j")) {
      if (n) this.at = (this.at + 1) % n;
      this.reveal = true;
    } else if (k === "up" || (ctrl && k === "k")) {
      if (n) this.at = (this.at - 1 + n) % n;
      this.reveal = true;
    } else if (this.moving) {
      return;
    } else if (ctrl && k === "p") {
      this.showPreview = !this.showPreview;
    } else if (ctrl && k === "r") {
      this.startRename(this.current);
    } else if (ctrl && k === "d") {
      this.askClose(this.current);
    } else if (ctrl && k === "y") {
      if (!e.is_held) this.askEnter(this.current, cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  chips(t, scope) {
    return h_flex().flex_none().px(18).pb(8).gap(6).items_center().flex_wrap().text_size(11.5)
      .children(CHIPS.map(([ch, what]) => {
        const on = this.query.trimStart().startsWith(ch);
        return h_flex().id(`chip-${ch}`).gap(4).px(6).h(20).items_center().rounded(5).cursor_pointer()
          .bg(on ? t.selected : t.foreground + "0d").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (ch === ">") return this.toPalette();
            this.query = on ? "" : ch;
            this.input.set_value(this.query);
            this.input.focus();
            this.at = 0;
            this.scrollTop = 0;
            cx.notify();
          })
          .child(div().font_semibold().text_color(on ? t.accent : t.muted).child(ch))
          .child(div().text_color(on ? t.foreground : t.dim).child(what));
      }));
  }

  render() {
    if (this.daemon) return div();
    const t = theme();
    const { scope, q, entries, grouped } = this.build();
    const rows = entries.filter((e) => e.it);
    this.rows = rows.map((e) => e.it);
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    this.current = rows[this.at]?.it ?? null;
    // An armed close only holds for the row it was asked on.
    if (this.armed && this.armed !== this.current?.id) this.armed = null;
    if (this.armedEnter && (this.armedEnter.terminal !== this.current?.terminal || !isBlockedAgent(this.armedEnter.terminal))) this.armedEnter = null;

    // Each entry at a fixed y, so scrolling and revealing the selection are arithmetic.
    let y = 0, seen = -1, selTop = 0, selBottom = 0;
    const tops = entries.map((e, i) => {
      const top = y;
      y += e.head ? HEAD_H : ROW_H;
      if (e.it && ++seen === this.at) { selTop = entries[i - 1]?.head ? top - HEAD_H : top; selBottom = y; }
      return top;
    });
    const H = this.listH;
    this.maxScroll = Math.max(0, y - H);
    // Only the keyboard moves the view to the selection: the pointer's hover must not make the list jump.
    if (this.reveal && rows.length) {
      if (selTop < this.scrollTop) this.scrollTop = selTop;
      if (selBottom > this.scrollTop + H) this.scrollTop = selBottom - H;
    }
    this.reveal = false;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));

    this.visible = [];
    const drawn = [];
    let r = -1;
    entries.forEach((e, i) => {
      const h = e.head ? HEAD_H : ROW_H, top = tops[i] - this.scrollTop;
      if (e.it) r++;
      if (top + h <= 0 || top >= H) return;
      if (e.head) return drawn.push(header(t, e.head).absolute().left(0).right(0).top(top));
      if (top + h / 2 > 0 && top + h / 2 < H) this.visible.push(e.it);
      const idx = r;
      drawn.push(row(t, { it: e.it, hits: e.hits, back: e.back, tagged: !grouped && !this.moving, on: idx === this.at, armed: this.armed === e.it.id })
        .id(`g-${e.it.id}`).absolute().left(0).right(0).top(top)
        .on_hover((over, cx) => { if (over && this.at !== idx) { this.at = idx; cx.notify(); } })
        .on_click((_e, cx) => this.go(e.it, cx)));
    });

    const list = div().id("goto-list").relative().overflow_hidden().flex_1().min_w(0).h_full()
      .on_size_change((size, cx) => {
        const h = size.height / zoom();
        if (h > 0 && h !== this.listH) { this.listH = h; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => {
        cx.stop_propagation();
        const next = Math.max(0, Math.min(this.scrollTop - e.delta.y / zoom(), this.maxScroll));
        if (next === this.scrollTop) return;
        this.scrollTop = next;
        cx.notify();
      })
      .children(drawn)
      .when(rows.length === 0, (el) => el.child(div().py(40).text_center().text_size(13).text_color(t.dim)
        .child(q || scope !== "all" ? "Nothing matches." : "Nothing to go to.")));

    const key = (label) => div().flex().flex_none().min_w(20).h(20).px(4).items_center().justify_center().rounded(4).bg(t.foreground + "14").text_size(12).text_color(t.foreground).child(label);
    const hint = (label, what) => h_flex().gap(4).items_center().children(label.split(" ").map(key)).child(what);
    const showPreview = this.showPreview && this.width >= PREVIEW_MIN && !this.moving;

    return v_flex().id("goto").size_full().min_h(0).rounded(12).border(1).border_color(t.border).bg(t.popover).shadow_2xl().text_size(14).line_height("20px")
      .on_size_change((size, cx) => {
        const w = size.width / zoom();
        if (w !== this.width) { this.width = w; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        // A key that is not a chord with a modifier alone disarms a pending close.
        if (!MODIFIERS.has(e.key)) {
          const ctrl = e.modifiers.control;
          if (!(ctrl && e.key === "d")) this.armed = null;
          if (!(ctrl && e.key === "y")) { this.armedEnter = null; this.notBlocked = false; }
        }
        this.onKey(e, cx);
      })
      .child(h_flex().h(36).my(6).flex_none().pl(18).pr(20).gap(7).items_center()
        .child(svg("mods/goto/icons/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground)))
      .child(this.mode === "rename" || this.moving
        ? h_flex().flex_none().px(18).pb(8).h(28).items_center().text_size(11.5).text_color(this.moving && this.status && !this.busy ? t.blocked : t.muted)
          .child(this.moving ? this.status ?? "Enter moves it, Esc cancels." : `Renaming ${this.renameOf?.kind}: Enter saves, Esc cancels.`)
        : this.chips(t, scope))
      .child(h_flex().flex_1().min_h(BODY_H).border_t(1).border_color(t.foreground + "12")
        .child(list)
        .when(showPreview, (el) => el.child(preview(t, this.current, this.previewTerm === this.current?.terminal ? this.previewText : ""))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().rounded_b(11).border_t(1).border_color(t.foreground + "12").bg(t.foreground + "06").font_medium().text_color(t.muted)
        .child(h_flex().gap(12).items_center().flex_wrap()
          .child(hint("↑ ↓", "Navigate"))
          .child(hint("Enter", this.moving ? "Move" : "Go"))
          .child(hint("Alt+1", "Nth row"))
          .when(!this.moving, (el) => el
            .child(hint("Ctrl+R", "Rename"))
            .child(hint("Ctrl+D", "Close"))
            .child(hint("Ctrl+Y", this.armedEnter ? div().text_color(t.blocked).child("Again to send Enter")
              : this.notBlocked ? div().text_color(t.blocked).child("Blocked agents only") : "Send Enter"))
            .child(hint("Ctrl+P", "Preview")))
          .child(hint("Esc", this.moving ? "Cancel" : "Leave"))));
  }
}
