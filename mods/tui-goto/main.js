// Ultimate Herdr Session Navigator (Ctrl+Space g / Ctrl+Shift+K):
// Combines the best features from across the Herdr community:
// 1. Herdr TUI OpenNavigator: Spaces ▾/▸ -> Tabs ├──/└── -> Panes/Agents tree, j/k, Space expand, a/b/w/i/d filters, / search
// 2. CodeyPacker/jump: Vimium-style [f] jump hints, inline [r] rename, [x] close, [P] pin agent
// 3. sgomez/herdr-triage & mrolafsson/herdr-recap: Live terminal screen preview (hc read), wait/work timers, inline [m] reply & [y] approve
// 4. Orca / munza/branch-pr: Automatic GitHub PR association per branch (#num, CI checks, review state, [o] open PR in browser)

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  agents,
  closeOverlay,
  exec,
  hc,
  home,
  panes,
  props,
  run,
  setShared,
  settings,
  shared,
  spaces,
  terminals,
  theme,
  window,
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

function shortFolder(folder, userHome) {
  if (!folder) return "";
  if (userHome && folder === userHome) return "~";
  if (userHome && folder.startsWith(userHome + "/")) {
    return "~/" + folder.slice(userHome.length + 1);
  }
  return folder;
}

function relTime(ms) {
  if (!ms) return "";
  const sec = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
function makeHints(count) {
  if (count <= 0) return [];
  if (count <= HINT_ALPHABET.length) {
    return Array.from({ length: count }, (_, i) => HINT_ALPHABET[i]);
  }
  const out = [];
  for (let i = 0; i < HINT_ALPHABET.length && out.length < count; i++) {
    for (let j = 0; j < HINT_ALPHABET.length && out.length < count; j++) {
      out.push(HINT_ALPHABET[i] + HINT_ALPHABET[j]);
    }
  }
  return out;
}

const FILTERS = [
  ["all", "a", "all"],
  ["blocked", "b", "blocked"],
  ["working", "w", "working"],
  ["idle", "i", "idle"],
  ["done", "d", "done"],
];

export default class TuiGoto extends View {
  init(_props, cx) {
    this.userHome = home();
    this.query = "";
    this.statusFilter = "all";
    // mode: "nav" | "search" | "jump" | "rename" | "reply"
    this.mode = "nav";
    this.jumpTyped = "";
    this.showPreview = true;
    this.previewTerm = null;
    this.previewLines = "";
    this.previewLoading = false;
    this.prCache = { ...(shared("tui-goto.prs") ?? {}) };
    this.prPending = new Set();

    this.expanded = new Set(spaces().map((s) => s.id));

    this.input = InputState.new({
      placeholder:
        "/ search · f jump hints · m reply · r rename · o open PR…",
    });
    this.input.on("change", (_e, cx) => {
      if (this.mode === "search" || this.mode === "nav") {
        this.query = this.input.value();
        this.at = 0;
        cx.notify();
      }
    });
    this.input.on("focus", (_e, cx) => {
      if (this.mode === "nav") this.mode = "search";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.handleInputSubmit(cx));

    this.at = null;
    this.scroll = 0;
    this.machines = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(60, () => {
      if (this.mode === "nav") this.handle.focus();
    });

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

    this.refreshAllPrs(cx);
    cx.timer.every(1500, (cx) => {
      if (this.showPreview && this.previewTerm) {
        this.fetchPreview(this.previewTerm, cx);
      }
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  targetTerminalForRow(r) {
    if (!r) return null;
    const allPanes = panes();
    const allAgents = agents();
    if (r.kind === "pane") {
      return r.ag?.address ?? r.p?.terminal ?? null;
    }
    if (r.kind === "tab") {
      const ag = allAgents.find((a) => a.tab === r.ctx.id);
      if (ag?.address) return ag.address;
      const fp =
        allPanes.find((p) => p.tab === r.ctx.id && p.focused && p.terminal) ??
        allPanes.find((p) => p.tab === r.ctx.id && p.terminal);
      return fp?.terminal ?? null;
    }
    if (r.kind === "space") {
      const activeTab =
        (r.w.tabs ?? []).find((t) => t.active) ?? (r.w.tabs ?? [])[0];
      if (!activeTab) return null;
      const ag = allAgents.find((a) => a.tab === activeTab.id);
      if (ag?.address) return ag.address;
      const fp = allPanes.find((p) => p.tab === activeTab.id && p.terminal);
      return fp?.terminal ?? null;
    }
    return null;
  }

  fetchPreview(termAddr, cx) {
    if (!termAddr) {
      this.previewLines = "";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", termAddr, "--lines", "26"]);
        if (r.code === 0 && this.previewTerm === termAddr) {
          this.previewLines = r.stdout.replace(/\s+$/, "");
          cx.notify();
        }
      } catch {}
    });
  }

  refreshAllPrs(cx) {
    const allPanes = panes();
    for (const w of spaces()) {
      if (w.machine) continue; // Local spaces first for instant gh lookup
      const tabIds = new Set((w.tabs ?? []).map((t) => t.id));
      const cwd =
        allPanes.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || w.folder;
      const branch =
        w.branch ||
        allPanes.find((p) => tabIds.has(p.tab) && p.branch)?.branch;
      if (!cwd || !branch || branch === "main" || branch === "master" || branch === "HEAD") {
        continue;
      }
      const key = `${cwd}::${branch}`;
      const cached = this.prCache[key];
      if (cached && Date.now() - (cached.at ?? 0) < 120000) continue;
      if (this.prPending.has(key)) continue;
      this.prPending.add(key);

      cx.spawn(async (cx) => {
        try {
          const r = await exec(
            "gh",
            [
              "pr",
              "view",
              branch,
              "--json",
              "number,title,state,isDraft,reviewDecision,statusCheckRollup,url",
            ],
            { cwd },
          );
          if (r.code === 0 && r.stdout.trim()) {
            const data = JSON.parse(r.stdout);
            const rollup = data.statusCheckRollup ?? [];
            let checksPassed = 0;
            let checksFailed = 0;
            let checksPending = 0;
            for (const c of rollup) {
              const st = (c.conclusion || c.status || c.state || "").toUpperCase();
              if (st === "FAILURE" || st === "ERROR" || st === "TIMED_OUT" || st === "ACTION_REQUIRED") {
                checksFailed++;
              } else if (st === "SUCCESS" || st === "NEUTRAL" || st === "SKIPPED") {
                checksPassed++;
              } else {
                checksPending++;
              }
            }
            this.prCache[key] = {
              at: Date.now(),
              pr: {
                number: data.number,
                title: data.title,
                state: data.state,
                isDraft: Boolean(data.isDraft),
                reviewDecision: data.reviewDecision || "",
                url: data.url,
                checksPassed,
                checksFailed,
                checksPending,
                checksTotal: rollup.length,
              },
            };
          } else {
            this.prCache[key] = { at: Date.now(), pr: null };
          }
          setShared("tui-goto.prs", this.prCache);
        } catch {
          this.prCache[key] = { at: Date.now(), pr: null };
        } finally {
          this.prPending.delete(key);
          cx.notify();
        }
      });
    }
  }

  prForSpace(w, allPanes) {
    const tabIds = new Set((w.tabs ?? []).map((t) => t.id));
    const cwd =
      allPanes.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || w.folder;
    const branch =
      w.branch || allPanes.find((p) => tabIds.has(p.tab) && p.branch)?.branch;
    if (!cwd || !branch) return null;
    return this.prCache[`${cwd}::${branch}`]?.pr ?? null;
  }

  rows() {
    const q = this.query.trim().toLowerCase();
    const sf = this.statusFilter;
    const allAgents = agents();
    const allPanes = panes();
    const liveTerminals = terminals().filter((x) => x.state === "live");
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) =>
        liveTerminals
          .filter((x) => x.parent === a)
          .forEach((k) => {
            n++;
            walk(k.address);
          });
      addrs.forEach(walk);
      return n;
    };

    const out = [];
    const spList = spaces();

    spList.forEach((w, spIdx) => {
      const visibleTabs = (w.tabs ?? []).filter((t) => !t.settled);
      const tabIds = new Set(visibleTabs.map((t) => t.id));
      const spaceCwd =
        allPanes.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || w.folder || "";
      const spaceBranch =
        w.branch ||
        allPanes.find((p) => tabIds.has(p.tab) && p.branch)?.branch ||
        "";
      const pr = this.prForSpace(w, allPanes);
      const tabEntries = [];

      visibleTabs.forEach((ctx) => {
        const tabPanes = allPanes.filter((p) => p.tab === ctx.id);
        const tabAgents = allAgents.filter((a) => a.tab === ctx.id);
        const paneEntries = [];

        tabPanes.forEach((p) => {
          const ag = allAgents.find((a) => a.pane === p.pane);
          const st = ag?.status ?? p.status ?? null;
          if (sf !== "all" && st !== sf) return;
          const progName =
            ag?.program?.name ?? p.program?.name ?? p.app ?? "shell";
          const hay = [
            w.name,
            ctx.name,
            progName,
            p.title ?? "",
            p.branch ?? spaceBranch,
            shortFolder(p.cwd, this.userHome),
            st ?? "",
            pr ? `#${pr.number} ${pr.title}` : "",
          ]
            .join(" ")
            .toLowerCase();
          if (q && !hay.includes(q)) return;
          paneEntries.push({
            p,
            ag,
            st,
            progName,
            cwd: shortFolder(p.cwd, this.userHome),
          });
        });

        const tabHay = [
          w.name,
          ctx.name,
          spaceBranch,
          pr ? `#${pr.number} ${pr.title}` : "",
          ...tabAgents.map((a) => `${a.program?.name ?? ""} ${a.title ?? ""}`),
        ]
          .join(" ")
          .toLowerCase();
        const tabStatusMatch =
          sf === "all" ||
          ctx.status === sf ||
          tabAgents.some((a) => a.status === sf) ||
          paneEntries.length > 0;
        const tabQueryMatch =
          !q || tabHay.includes(q) || paneEntries.length > 0;

        if (tabStatusMatch && tabQueryMatch) {
          tabEntries.push({
            ctx,
            tabAgents,
            team: teamOf(tabAgents.map((a) => a.address)),
            paneEntries,
          });
        }
      });

      const spaceAgents = allAgents.filter((a) => a.space === w.id);
      const spaceHay = [
        w.name,
        spaceBranch,
        shortFolder(spaceCwd, this.userHome),
        pr ? `#${pr.number} ${pr.title}` : "",
      ]
        .join(" ")
        .toLowerCase();
      const spaceMatches =
        (sf === "all" ||
          w.status === sf ||
          spaceAgents.some((a) => a.status === sf) ||
          tabEntries.length > 0) &&
        (!q || spaceHay.includes(q) || tabEntries.length > 0);

      if (!spaceMatches) return;

      const isExpanded = Boolean(q || sf !== "all" || this.expanded.has(w.id));
      out.push({
        kind: "space",
        w,
        index: spIdx + 1,
        branch: spaceBranch,
        folder: shortFolder(spaceCwd, this.userHome),
        pr,
        expanded: isExpanded,
        tabCount: visibleTabs.length,
        agentCount: spaceAgents.length,
      });

      if (isExpanded) {
        tabEntries.forEach((te, tIdx) => {
          const isLastTab = tIdx === tabEntries.length - 1;
          const showPanes =
            te.paneEntries.length > 1 ||
            Boolean(q) ||
            sf !== "all" ||
            te.paneEntries.some((pe) => pe.ag || pe.st);
          out.push({
            kind: "tab",
            w,
            ctx: te.ctx,
            branch: spaceBranch,
            folder: shortFolder(spaceCwd, this.userHome),
            pr,
            tabAgents: te.tabAgents,
            team: te.team,
            tree: isLastTab && !showPanes ? "└──" : "├──",
          });
          if (showPanes) {
            te.paneEntries.forEach((pe, pIdx) => {
              const isLastPane = pIdx === te.paneEntries.length - 1;
              out.push({
                kind: "pane",
                w,
                ctx: te.ctx,
                p: pe.p,
                ag: pe.ag,
                st: pe.st,
                progName: pe.progName,
                cwd: pe.cwd || shortFolder(spaceCwd, this.userHome),
                branch: pe.p?.branch || spaceBranch,
                pr,
                branchPipe: isLastTab ? "    " : "│   ",
                tree: isLastPane ? "└──" : "├──",
              });
            });
          }
        });
      }
    });

    if (sf === "all") {
      out.push({ kind: "new-tab" });
      out.push({ kind: "new-space", machine: null });
      for (const m of this.machines) {
        out.push({ kind: "new-space", machine: m });
      }
    }

    const hints = makeHints(out.length);
    out.forEach((r, i) => {
      r.hint = hints[i] ?? "";
    });
    return out;
  }

  toggleExpand(r) {
    const spaceId = r?.w?.id;
    if (!spaceId) return;
    if (this.expanded.has(spaceId)) {
      this.expanded.delete(spaceId);
    } else {
      this.expanded.add(spaceId);
    }
  }

  go(r) {
    if (!r) return;
    this.close();
    if (r.kind === "space") {
      run("space.select", { id: r.w.id });
    } else if (r.kind === "tab") {
      run("tab.select", { id: r.ctx.id });
    } else if (r.kind === "pane") {
      if (r.ag?.address) {
        run("agent.focus", { terminal: r.ag.address });
      } else {
        run("tab.select", { id: r.ctx.id });
        if (r.p?.pane) run("pane.focus", { pane: r.p.pane });
      }
    } else if (r.kind === "new-tab") {
      run("tab.new");
    } else if (r.kind === "new-space") {
      run("space.new", { machine: r.machine ?? "" });
    }
  }

  startRename(sel, cx) {
    if (!sel || (sel.kind !== "space" && sel.kind !== "tab")) return;
    const curName = sel.kind === "tab" ? sel.ctx.name : sel.w.name;
    this.mode = "rename";
    this.renameTarget = sel;
    this.input.set_value(curName);
    this.input.set_selected_range({ start: 0, end: curName.length });
    this.input.focus();
    cx.notify();
  }

  startReply(sel, cx) {
    const term = this.targetTerminalForRow(sel);
    if (!term) return;
    this.mode = "reply";
    this.replyTerminal = term;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  handleInputSubmit(cx) {
    const rows = this.rows();
    const sel = rows[this.at];
    if (this.mode === "rename" && this.renameTarget) {
      const nextName = this.input.value().trim();
      const target = this.renameTarget;
      this.mode = "nav";
      this.renameTarget = null;
      this.input.set_value(this.query);
      this.handle.focus();
      if (target.kind === "tab") {
        run("tab.rename", { id: target.ctx.id, name: nextName });
      } else if (target.kind === "space") {
        run("space.rename", { id: target.w.id, name: nextName });
      }
      cx.notify();
      return;
    }
    if (this.mode === "reply" && this.replyTerminal) {
      const msg = this.input.value();
      const term = this.replyTerminal;
      this.mode = "nav";
      this.replyTerminal = null;
      this.input.set_value(this.query);
      this.handle.focus();
      if (msg.trim()) {
        cx.spawn(async (cx) => {
          await hc(["send", term, msg]);
          await hc(["keys", term, "enter"]);
          this.fetchPreview(term, cx);
        });
      }
      cx.notify();
      return;
    }
    this.go(sel);
  }

  approveSelected(sel, cx) {
    const term = this.targetTerminalForRow(sel);
    if (!term) return;
    cx.spawn(async (cx) => {
      await hc(["keys", term, "enter"]);
      this.fetchPreview(term, cx);
    });
  }

  openPrInBrowser(sel, cx) {
    const url = sel?.pr?.url;
    if (!url) return;
    cx.spawn(async () => {
      try {
        await exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]);
      } catch {}
    });
  }

  togglePin(sel) {
    const ag =
      sel?.ag ??
      (sel?.kind === "tab" ? sel.tabAgents?.[0] : null);
    if (!ag?.address) return;
    run("terminal.pin", { terminal: ag.address, pinned: !ag.pinned });
  }

  glyph(t, st) {
    if (st === "working") {
      return svg("mods/workspace-chrome/spinner.svg")
        .size(12)
        .flex_none()
        .text_color(t.working)
        .spin(900);
    }
    return div()
      .w(12)
      .flex_none()
      .text_color(t[st] ?? t.dim)
      .child(st === "idle" ? "○" : st ? "●" : "·");
  }

  prBadge(t, pr) {
    if (!pr) return null;
    const isFailed = pr.checksFailed > 0 || pr.reviewDecision === "CHANGES_REQUESTED";
    const isReady =
      !pr.isDraft &&
      pr.checksFailed === 0 &&
      (pr.reviewDecision === "APPROVED" || pr.checksPassed > 0);
    const color = pr.isDraft
      ? t.dim
      : isFailed
        ? t.blocked
        : isReady
          ? t.ansi2
          : t.working;
    const mark = pr.isDraft
      ? "draft"
      : isFailed
        ? "×"
        : pr.reviewDecision === "APPROVED"
          ? "✓"
          : "●";
    return h_flex()
      .flex_none()
      .px(5)
      .py(1)
      .rounded(4)
      .gap(3)
      .items_center()
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .text_size(10.5)
      .text_color(color)
      .child(`#${pr.number}`)
      .child(mark);
  }

  renderPreviewPane(t, sel) {
    if (!sel || sel.kind === "new-tab" || sel.kind === "new-space") {
      return v_flex()
        .w(370)
        .flex_none()
        .h_full()
        .p(12)
        .rounded(9)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .justify_center()
        .items_center()
        .text_color(t.dim)
        .child("Select a space, tab, or agent to inspect");
    }

    const title =
      sel.kind === "space"
        ? sel.w.name
        : sel.kind === "tab"
          ? `${sel.w.name} › ${sel.ctx.name}`
          : `${sel.w.name} › ${sel.ctx.name} › ${sel.progName}`;
    const status =
      sel.kind === "space"
        ? sel.w.status
        : sel.kind === "tab"
          ? sel.ctx.status
          : sel.st;
    const pr = sel.pr;
    const term = this.targetTerminalForRow(sel);

    return v_flex()
      .w(380)
      .flex_none()
      .h_full()
      .min_h(0)
      .p(12)
      .gap(8)
      .rounded(9)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .justify_between()
          .child(
            div()
              .flex_1()
              .truncate()
              .font_semibold()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(title),
          )
          .when(Boolean(status), (el) =>
            el.child(
              h_flex()
                .px(6)
                .py(1)
                .rounded(4)
                .gap(4)
                .items_center()
                .bg(t.background)
                .text_size(10.5)
                .text_color(t[status] ?? t.dim)
                .child(this.glyph(t, status))
                .child(status),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .when(Boolean(sel.branch), (el) =>
            el.child(
              h_flex()
                .gap(4)
                .items_center()
                .text_color(t.muted)
                .child(
                  svg("mods/workspace-chrome/branch.svg")
                    .size(11)
                    .text_color(t.dim),
                )
                .child(div().max_w(150).truncate().child(sel.branch)),
            ),
          )
          .child(
            div()
              .flex_1()
              .truncate()
              .child(sel.cwd || sel.folder || ""),
          ),
      )
      .when(Boolean(pr), (el) =>
        el.child(
          v_flex()
            .p(8)
            .gap(4)
            .rounded(7)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .font_semibold()
                        .text_size(11.5)
                        .text_color(t.accent)
                        .child(`PR #${pr.number}`),
                    )
                    .child(
                      div()
                        .flex_1()
                        .truncate()
                        .text_size(11.5)
                        .text_color(t.foreground)
                        .child(pr.title),
                    ),
                )
                .child(
                  div()
                    .id("tg-open-pr-btn")
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .text_size(10.5)
                    .text_color(t.accent)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.openPrInBrowser(sel, cx))
                    .child("[o] Open"),
                ),
            )
            .child(
              h_flex()
                .gap(10)
                .items_center()
                .text_size(10.5)
                .text_color(t.muted)
                .child(
                  pr.isDraft
                    ? "Draft PR"
                    : pr.reviewDecision === "APPROVED"
                      ? "✓ Approved"
                      : pr.reviewDecision === "CHANGES_REQUESTED"
                        ? "× Changes requested"
                        : "Review pending",
                )
                .when(pr.checksTotal > 0, (c) =>
                  c.child(
                    pr.checksFailed > 0
                      ? `× ${pr.checksFailed}/${pr.checksTotal} checks failed`
                      : pr.checksPending > 0
                        ? `◐ ${pr.checksPending}/${pr.checksTotal} checks running`
                        : `✓ ${pr.checksPassed}/${pr.checksTotal} checks passed`,
                  ),
                ),
            ),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(8)
          .rounded(7)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .overflow_y_scrollbar()
          .child(
            div()
              .text_size(10.5)
              .text_color(this.previewLines ? t.foreground : t.dim)
              .child(
                this.previewLines ||
                  (term
                    ? "Reading terminal output…"
                    : "No active terminal in selection"),
              ),
          ),
      )
      .when(Boolean(term), (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .justify_between()
            .text_size(10.5)
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(
                  div()
                    .id("tg-btn-reply")
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.startReply(sel, cx))
                    .child("[m] Reply"),
                )
                .child(
                  div()
                    .id("tg-btn-approve")
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_color(t.ansi2)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.approveSelected(sel, cx))
                    .child("[y] Enter/Approve"),
                )
                .child(
                  div()
                    .id("tg-btn-rename")
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.startRename(sel, cx))
                    .child("[r] Rename"),
                ),
            )
            .child(
              div().text_color(t.dim).child(term),
            ),
        ),
      );
  }

  render(cx) {
    const t = theme();
    const rows = this.rows();
    if (this.at === null) {
      const curIdx = rows.findIndex(
        (r) => r.kind === "tab" && r.w.active && r.ctx.active,
      );
      const spIdx = rows.findIndex((r) => r.kind === "space" && r.w.active);
      this.at = Math.max(0, curIdx >= 0 ? curIdx : spIdx);
    }
    if (rows.length > 0) {
      this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    } else {
      this.at = 0;
    }
    const sel = rows[this.at];

    const nextTerm = this.targetTerminalForRow(sel);
    if (this.showPreview && nextTerm !== this.previewTerm) {
      this.previewTerm = nextTerm;
      this.previewLines = "";
      if (nextTerm) this.fetchPreview(nextTerm, cx);
    }

    const ROW_H = 31;
    const tops = rows.map((_, i) => i * ROW_H);
    const total = rows.length * ROW_H;
    const height = Math.min(410, this.listHeight ?? 410);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + ROW_H > this.scroll + height) {
        this.scroll = tops[si] + ROW_H - height;
      }
    }
    const place = (el, i) =>
      fixed
        ? el
            .absolute()
            .left(0)
            .right(0)
            .top(tops[i] - this.scroll)
            .bottom(height - (tops[i] + ROW_H - this.scroll))
        : el;
    const visible = (i) =>
      !fixed ||
      (tops[i] + ROW_H > this.scroll && tops[i] < this.scroll + height);

    const allAgents = agents();
    const statusCounts = {
      all: allAgents.length,
      blocked: allAgents.filter((a) => a.status === "blocked").length,
      working: allAgents.filter((a) => a.status === "working").length,
      idle: allAgents.filter((a) => a.status === "idle").length,
      done: allAgents.filter((a) => a.status === "done").length,
    };

    const drawHint = (r) => {
      if (this.mode !== "jump" || !r.hint) return null;
      if (this.jumpTyped && !r.hint.startsWith(this.jumpTyped)) return null;
      return h_flex()
        .px(5)
        .py(1)
        .rounded(4)
        .bg(t.accent)
        .text_size(10.5)
        .font_bold()
        .text_color(t.accent_foreground ?? "#0e0f11")
        .child(r.hint);
    };

    const drawRow = (r, idx) => {
      const on = r === sel;
      const hintBadge = drawHint(r);

      if (r.kind === "new-tab" || r.kind === "new-space") {
        const label =
          r.kind === "new-tab"
            ? "+ new tab"
            : r.machine
              ? `+ new workspace on ${r.machine}`
              : "+ new workspace";
        return h_flex()
          .id(`tg-${r.kind}-${r.machine ?? "local"}`)
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
          .when(Boolean(hintBadge), (el) => el.child(hintBadge))
          .child(div().text_color(t.accent).font_semibold().child(label));
      }

      if (r.kind === "space") {
        const here = r.w.active;
        const prEl = this.prBadge(t, r.pr);
        return h_flex()
          .id(`tg-sp-${r.w.id}`)
          .mx(4)
          .px(8)
          .h(ROW_H)
          .rounded(7)
          .gap(7)
          .items_center()
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected ?? t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .when(Boolean(hintBadge), (el) => el.child(hintBadge))
          .child(
            div()
              .id(`tg-exp-${r.w.id}`)
              .w(16)
              .flex_none()
              .text_size(12)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.toggleExpand(r);
                cx.notify();
              })
              .child(r.expanded ? "▾" : "▸"),
          )
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(spaceColor(t, r.w))
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child([...r.w.name][0]?.toUpperCase() ?? "?"),
          )
          .child(
            div()
              .flex_shrink(0)
              .max_w(165)
              .truncate()
              .font_semibold()
              .text_color(here ? t.accent : t.foreground)
              .child(r.w.name),
          )
          .when(
            Boolean(
              r.branch &&
                r.branch !== "main" &&
                r.branch !== "master" &&
                r.branch.toLowerCase() !== r.w.name.toLowerCase(),
            ),
            (el) =>
              el.child(
                h_flex()
                  .gap(3)
                  .items_center()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(
                    svg("mods/workspace-chrome/branch.svg")
                      .size(11)
                      .text_color(t.dim),
                  )
                  .child(div().max_w(110).truncate().child(r.branch)),
              ),
          )
          .when(Boolean(prEl), (el) => el.child(prEl))
          .child(div().flex_1())
          .when(Boolean(r.w.status), (el) =>
            el.child(this.glyph(t, r.w.status)),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(
                `${r.tabCount}t${here ? " · ●" : ""}`,
              ),
          );
      }

      if (r.kind === "tab") {
        const here = r.w.active && r.ctx.active;
        const who = r.tabAgents
          .map((a) => (a.pinned ? `★ ${a.program?.name ?? "agent"}` : a.program?.name ?? "agent"))
          .join(" · ");
        const dur = relTime(r.ctx.working_since || r.ctx.changed_at);
        return h_flex()
          .id(`tg-tab-${r.ctx.id}`)
          .mx(4)
          .pl(24)
          .pr(10)
          .h(ROW_H)
          .rounded(7)
          .gap(7)
          .items_center()
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected ?? t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .when(Boolean(hintBadge), (el) => el.child(hintBadge))
          .child(div().text_size(11.5).text_color(t.dim).child(r.tree))
          .child(this.glyph(t, r.ctx.status))
          .child(
            div()
              .flex_1()
              .truncate()
              .text_color(here ? t.accent : t.foreground)
              .when(here, (d) => d.font_semibold())
              .child(`${r.ctx.index}: ${r.ctx.name}`),
          )
          .when(r.ctx.status === "blocked", (el) =>
            el.child(
              div().text_size(10.5).text_color(t.blocked).child("needs you"),
            ),
          )
          .when(r.ctx.status === "done", (el) =>
            el.child(
              div().text_size(10.5).text_color(t.done).child("finished"),
            ),
          )
          .when(Boolean(who), (el) =>
            el.child(
              div()
                .max_w(120)
                .truncate()
                .text_size(10.5)
                .text_color(t.dim)
                .child(who + (r.team ? ` +${r.team}` : "")),
            ),
          )
          .when(Boolean(dur), (el) =>
            el.child(
              div().text_size(10.5).text_color(t.dim).child(dur),
            ),
          );
      }

      // kind === "pane"
      const here = Boolean(r.p?.focused);
      const pinned = Boolean(r.ag?.pinned);
      return h_flex()
        .id(`tg-pane-${r.p?.pane ?? idx}`)
        .mx(4)
        .pl(24)
        .pr(10)
        .h(ROW_H)
        .rounded(7)
        .gap(7)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected ?? t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .when(Boolean(hintBadge), (el) => el.child(hintBadge))
        .child(
          div()
            .text_size(11.5)
            .text_color(t.dim)
            .child(`${r.branchPipe}${r.tree}`),
        )
        .child(this.glyph(t, r.st))
        .child(
          div()
            .flex_shrink(0)
            .text_size(12)
            .text_color(r.ag ? t.foreground : t.muted)
            .when(here, (d) => d.font_semibold().text_color(t.accent))
            .child(`${pinned ? "★ " : ""}${r.progName}`),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(
              r.p?.title && r.p.title !== r.progName
                ? r.p.title
                : r.cwd || "",
            ),
        )
        .when(Boolean(r.st), (el) =>
          el.child(
            div()
              .text_size(10.5)
              .text_color(t[r.st] ?? t.dim)
              .child(r.st),
          ),
        );
    };

    const modeBanner =
      this.mode === "rename"
        ? `Rename ${this.renameTarget?.kind ?? "item"} (Enter to save, Esc to cancel):`
        : this.mode === "reply"
          ? `Reply to ${this.replyTerminal} (Enter to send, Esc to cancel):`
          : this.mode === "jump"
            ? `Jump Hint Mode: type badge letters (${this.jumpTyped || "a..z"}) · Esc to cancel`
            : null;

    return v_flex()
      .id("tui-goto")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        const ch = e.key_char;
        const ctrl = e.modifiers.control;
        const shift = e.modifiers.shift;
        const n = rows.length;

        // 1. Jump Hint mode:
        if (this.mode === "jump") {
          cx.stop_propagation();
          if (k === "escape") {
            this.mode = "nav";
            this.jumpTyped = "";
            cx.notify();
            return;
          }
          if (k === "backspace") {
            this.jumpTyped = this.jumpTyped.slice(0, -1);
            cx.notify();
            return;
          }
          const letter = (ch || k || "").toLowerCase();
          if (/^[a-z]$/.test(letter)) {
            this.jumpTyped += letter;
            const matches = rows.filter((r) =>
              r.hint?.startsWith(this.jumpTyped),
            );
            if (matches.length === 1 && matches[0].hint === this.jumpTyped) {
              return this.go(matches[0]);
            }
            if (matches.length === 0) {
              this.mode = "nav";
              this.jumpTyped = "";
            }
            cx.notify();
          }
          return;
        }

        // 2. Search / Rename / Reply input modes:
        if (
          this.mode === "search" ||
          this.mode === "rename" ||
          this.mode === "reply"
        ) {
          if (k === "escape") {
            this.mode = "nav";
            this.renameTarget = null;
            this.replyTerminal = null;
            this.input.set_value(this.query);
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (this.mode === "search") {
            if ((k === "down" || (ctrl && k === "n")) && n) {
              this.at = (this.at + 1) % n;
              cx.stop_propagation();
              cx.notify();
              return;
            }
            if ((k === "up" || (ctrl && k === "p")) && n) {
              this.at = (this.at + n - 1) % n;
              cx.stop_propagation();
              cx.notify();
              return;
            }
          }
          return;
        }

        // 3. Normal TUI Navigator mode:
        if (k === "escape" || k === "q") {
          cx.stop_propagation();
          return this.close();
        }
        if (k === "enter") {
          cx.stop_propagation();
          return this.go(sel);
        }
        if ((k === "j" || k === "down" || (ctrl && k === "n")) && n) {
          this.at = (this.at + 1) % n;
        } else if ((k === "k" || k === "up" || (ctrl && k === "p")) && n) {
          this.at = (this.at + n - 1) % n;
        } else if (
          k === "space" ||
          k === " " ||
          k === "l" ||
          k === "h" ||
          k === "right" ||
          k === "left"
        ) {
          this.toggleExpand(sel);
        } else if (k === "/") {
          this.mode = "search";
          this.input.set_value(this.query);
          this.input.focus();
        } else if (k === "f" && !ctrl && !shift) {
          this.mode = "jump";
          this.jumpTyped = "";
        } else if (k === "p" && !ctrl && !shift) {
          this.showPreview = !this.showPreview;
        } else if (
          (k === "P" || (k === "p" && shift)) &&
          !ctrl
        ) {
          this.togglePin(sel);
        } else if (k === "r" && !ctrl && !shift) {
          return this.startRename(sel, cx);
        } else if (k === "m" && !ctrl && !shift) {
          return this.startReply(sel, cx);
        } else if (k === "y" && !ctrl && !shift) {
          this.approveSelected(sel, cx);
        } else if (k === "o" && !ctrl && !shift) {
          this.openPrInBrowser(sel, cx);
        } else if (
          !ctrl &&
          !shift &&
          (k === "a" || k === "b" || k === "w" || k === "i" || k === "d")
        ) {
          const found = FILTERS.find(([, key]) => key === k);
          if (found) {
            this.statusFilter =
              this.statusFilter === found[0] && found[0] !== "all"
                ? "all"
                : found[0];
            this.at = 0;
          }
        } else if ((ctrl && k === "d") || (k === "x" && !ctrl && !shift)) {
          if (sel?.kind === "pane" && sel.p?.pane) {
            run("pane.close", { pane: sel.p.pane });
          } else if (sel?.kind === "tab") {
            run("tab.close", { id: sel.ctx.id });
          } else if (sel?.kind === "space") {
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
                  .child("Session Navigator"),
              ),
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .children(
                FILTERS.map(([id, key, label]) => {
                  const active = this.statusFilter === id;
                  const count = statusCounts[id] ?? 0;
                  return h_flex()
                    .id(`tg-filter-${id}`)
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .gap(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(active ? t.selected : t.surface)
                    .border_1()
                    .border_color(active ? t.accent : t.border)
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.statusFilter =
                        this.statusFilter === id && id !== "all" ? "all" : id;
                      this.at = 0;
                      cx.notify();
                    })
                    .child(
                      div()
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(active ? t.accent : t.dim)
                        .child(`[${key}]`),
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(active ? t.foreground : t.muted)
                        .child(`${label}${count ? ` (${count})` : ""}`),
                    );
                }),
              )
              .child(
                h_flex()
                  .id("tg-toggle-preview")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .gap(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.showPreview ? t.selected : t.surface)
                  .border_1()
                  .border_color(this.showPreview ? t.accent : t.border)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.showPreview = !this.showPreview;
                    cx.notify();
                  })
                  .child(
                    div()
                      .text_size(10.5)
                      .font_semibold()
                      .text_color(this.showPreview ? t.accent : t.dim)
                      .child("[p]"),
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(this.showPreview ? t.foreground : t.muted)
                      .child("preview"),
                  ),
              ),
          ),
      )
      .when(Boolean(modeBanner), (el) =>
        el.child(
          div()
            .px(10)
            .py(4)
            .rounded(6)
            .bg(t.surface)
            .text_size(11.5)
            .font_semibold()
            .text_color(t.accent)
            .child(modeBanner),
        ),
      )
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(
            this.mode === "search" ||
              this.mode === "rename" ||
              this.mode === "reply"
              ? t.accent
              : t.border,
          )
          .bg(t.background)
          .child(
            svg("mods/workspace-chrome/search.svg")
              .size(14)
              .text_color(
                this.mode === "search" ||
                  this.mode === "rename" ||
                  this.mode === "reply"
                  ? t.accent
                  : t.dim,
              ),
          )
          .child(
            Input.new(this.input)
              .flex_1()
              .h_full()
              .text_size(12.5)
              .text_color(t.foreground),
          )
          .when(Boolean(this.query && this.mode === "search"), (el) =>
            el.child(
              div()
                .id("tg-clear-query")
                .px(5)
                .py(1)
                .rounded(4)
                .text_size(11)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.input.set_value("");
                  this.query = "";
                  this.at = 0;
                  cx.notify();
                })
                .child("clear"),
            ),
          ),
      )
      .child(
        h_flex()
          .h(Math.min(410, Math.max(240, total)))
          .min_h(0)
          .gap(12)
          .child(
            v_flex()
              .id("tg-list")
              .flex_1()
              .min_w(0)
              .h_full()
              .min_h(0)
              .on_size_change((size, cx) => {
                this.listHeight = size.height / settings().zoom;
                cx.notify();
              })
              .when(rows.length === 0, (el) =>
                el.child(
                  div()
                    .px(10)
                    .py(8)
                    .text_color(t.dim)
                    .child("no matching spaces, tabs, or agents"),
                ),
              )
              .when(fixed, (el) =>
                el.overflow_hidden().on_scroll_wheel((e, cx) => {
                  this.scroll = Math.max(
                    0,
                    Math.min(this.scroll - e.delta.y, maxScroll),
                  );
                  while (
                    this.at < rows.length - 1 &&
                    tops[this.at] < this.scroll
                  ) {
                    this.at++;
                  }
                  while (
                    this.at > 0 &&
                    tops[this.at] + ROW_H > this.scroll + height
                  ) {
                    this.at--;
                  }
                  cx.notify();
                }),
              )
              .children(
                rows
                  .map((r, i) => (visible(i) ? place(drawRow(r, i), i) : null))
                  .filter(Boolean),
              ),
          )
          .when(this.showPreview, (el) =>
            el.child(this.renderPreviewPane(t, sel)),
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
          .child(
            this.mode === "search"
              ? "search type · move ↑↓/ctrl+n/p · open enter · back esc"
              : "j/k move · space expand · f jump hints · / search · m reply · y approve · r rename · o PR · x close · esc",
          ),
      );
  }
}
