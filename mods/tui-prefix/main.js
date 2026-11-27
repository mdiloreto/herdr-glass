// Includes code from herdrdev/herdr-app@034f8b85f7e6bb71f8ff55cb4a80c548b2578c0f, defaults/mods/agents/main.js.
// Licensed under Apache-2.0; modified. Line ranges: PROVENANCE.md.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  closeOverlay,
  exec,
  focused,
  hc,
  layout,
  nextCommand,
  notify,
  props,
  run,
  setShared,
  shared,
  spaces,
  terminals,
  theme,
  window,
} from "herdr";

// The herdr-github checkout path is install-specific, so ask herdr where it is.
async function openGithub(action, name) {
  let bin;
  try {
    const r = await exec("herdr", ["plugin", "list", "--json"]);
    if (r.code !== 0) throw new Error(`herdr plugin list exited ${r.code}`);
    const plugin = JSON.parse(r.stdout).result.plugins.find(
      (p) => p.plugin_id === "herdr-github",
    );
    if (!plugin) throw new Error("herdr-github plugin is not installed");
    bin = `${plugin.plugin_root}/bin/herdr-github`;
  } catch (err) {
    notify({
      title: "GitHub plugin not found",
      body: String(err?.message ?? err),
      level: "error",
    });
    return;
  }
  run("terminal.open", { argv: [bin, "action", action], name });
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

function kidStatus(k, listed) {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
}

function subTree(all, rootAddress) {
  const byParent = new Map();
  for (const t of all) {
    if (!t.parent) continue;
    const group = byParent.get(t.parent) ?? [];
    group.push(t);
    byParent.set(t.parent, group);
  }
  const out = [];
  const walk = (addr) => {
    for (const child of byParent.get(addr) ?? []) {
      out.push(child);
      walk(child.address);
    }
  };
  walk(rootAddress);
  return out;
}

// Compute the exact same ordered agent list as mods/agents/main.js.
function orderedAgents() {
  let list = agents();
  const listed = new Map(list.map((a) => [a.address, a.status]));
  const all = terminals();
  const byPriority = (shared("agents.sort") ?? "priority") === "priority";
  if (byPriority) {
    const urgency = new Map(
      list.map((a) => [
        a.address,
        Math.max(
          RANK[a.status] ?? 0,
          ...subTree(all, a.address).map((s) => RANK[kidStatus(s, listed)] ?? 0),
        ),
      ]),
    );
    list = [...list].sort(
      (x, y) =>
        (urgency.get(y.address) ?? 0) - (urgency.get(x.address) ?? 0) ||
        y.seq - x.seq,
    );
  }
  const pinned = list.filter((a) => a.pinned);
  const rest = list.filter((a) => !a.pinned);
  return [...pinned, ...rest];
}

// Prefer the order the sidebar shows (published as shared "agents.order").
function sidebarAgentOrder() {
  const published = shared("agents.order");
  const allAgents = agents();
  const allTerminals = terminals();
  const live = new Set([...allAgents, ...allTerminals].map((a) => a.address));
  if (
    published?.layout === shared("layout") &&
    Array.isArray(published.order) &&
    published.order.length > 0
  ) {
    const filtered = published.order.filter((addr) => live.has(addr));
    if (filtered.length > 0) return filtered;
  }
  return orderedAgents().map((a) => a.address);
}

// Match the terminal directly in `order` first; only walk up `parent` if it isn't a top-level
// entry (e.g. a peeked pane-less sub-agent). Agents spawned via herdr-spawn keep `parent` pointing
// at their spawner (or a shell) even when they have their own tab/pane in the sidebar list.
function findInOrder(address, order, byAddr) {
  let cur = address;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    const idx = order.indexOf(cur);
    if (idx >= 0) return idx;
    seen.add(cur);
    cur = byAddr.get(cur)?.parent;
  }
  return -1;
}

function focusAgentByIndex(index1Based) {
  const order = sidebarAgentOrder();
  const target = order[index1Based - 1];
  if (target) {
    run("agent.focus", { terminal: target });
  }
}

// Cycle through sidebar agents in displayed order, anchored on the actually focused pane/tab
// rather than AppWindow::shown_agent()'s cached agent or root_agent() (which both break for
// herdr-spawn agents whose `parent` is another agent or a shell).
function cycleAgent(delta) {
  const order = sidebarAgentOrder();
  if (order.length === 0) return;

  const f = focused();
  const allTerminals = terminals();
  const byAddr = new Map(allTerminals.map((t) => [t.address, t]));
  const allAgents = agents();

  let idx = findInOrder(f?.terminal, order, byAddr);

  if (idx < 0 && f?.tab) {
    const tabAgent = allAgents.find(
      (a) => a.tab === f.tab && order.includes(a.address),
    );
    if (tabAgent) idx = order.indexOf(tabAgent.address);
  }

  if (idx < 0 && f?.agent) {
    idx = findInOrder(f.agent, order, byAddr);
  }

  const nextIdx =
    idx >= 0
      ? (idx + delta + order.length) % order.length
      : delta > 0
        ? 0
        : order.length - 1;

  const target = order[nextIdx];
  if (target) {
    run("agent.focus", { terminal: target });
  }
}

// Live sub-agents of `addr`, depth first, in the sidebar's tree order (mods/rail-next/views/agents.js).
function subAgents(all, addr) {
  return all
    .filter((k) => k.parent === addr && k.state === "live" && k.program?.agent)
    .flatMap((k) => [k.address, ...subAgents(all, k.address)]);
}

// A peek leaves focus on the coordinator's pane, so remember which sub-agent it shows.
let peekedSub = null;

// Cycle through the focused coordinator and its sub-agents, which sidebarAgentOrder() leaves out.
// Opens a sub-agent as the sidebar does: focus its pane if it has one, else peek at it.
function cycleSubagent(delta) {
  const order = sidebarAgentOrder();
  const f = focused();
  const allTerminals = terminals();
  const byAddr = new Map(allTerminals.map((t) => [t.address, t]));

  let topIdx = findInOrder(f?.terminal, order, byAddr);
  if (topIdx < 0 && f?.tab) {
    const tabAgent = agents().find((a) => a.tab === f.tab && order.includes(a.address));
    if (tabAgent) topIdx = order.indexOf(tabAgent.address);
  }
  if (topIdx < 0 && f?.agent) topIdx = findInOrder(f.agent, order, byAddr);
  const coordinator = order[topIdx];
  if (!coordinator) return;
  const ring = [coordinator, ...subAgents(allTerminals, coordinator)];
  if (ring.length < 2) return;

  let idx = ring.indexOf(f?.terminal);
  if (idx <= 0 && ring.includes(peekedSub)) idx = ring.indexOf(peekedSub);
  const target = ring[(Math.max(idx, 0) + delta + ring.length) % ring.length];

  if (target !== coordinator && !agents().some((a) => a.address === target)) {
    peekedSub = target;
    run("terminal.peek", { terminal: target });
    return;
  }
  if (peekedSub) run("overlay.close", {});
  peekedSub = null;
  run(target === coordinator ? "agent.focus" : "pane.focus", { terminal: target });
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function toggleRightPanelTab(targetId) {
  const root = layout();
  const panel = findNode(root, "panel");
  const body = findNode(root, "panel-body");
  if (!panel) return;
  const isShowingTarget = !panel.hidden && body?.active === targetId;
  if (isShowingTarget) {
    run("layout.hide", { id: "panel" });
  } else {
    if (body) run("layout.select", { stack: "panel-body", child: targetId });
    run("layout.show", { id: "panel" });
  }
}

function toggleSidebarRail() {
  const sidebar = findNode(layout(), "sidebar");
  if (sidebar?.hidden) {
    run("layout.show", { id: "sidebar" });
  }
  const width = sidebar?.size?.px ?? Infinity;
  const isNarrow = width < 160;
  if (!isNarrow && Number.isFinite(width)) {
    setShared("sidebar.width", width);
  }
  setShared("sidebar.collapsed", !isNarrow);
  const nextPx = isNarrow
    ? (shared("sidebar.width") ?? 268)
    : window()?.platform === "macos"
      ? 76
      : 44;
  run("layout.resize", { id: "sidebar", px: nextPx });
}

function toggleSidebarInbox() {
  const root = layout();
  const sidebar = findNode(root, "sidebar");
  if (sidebar?.hidden) {
    run("layout.show", { id: "sidebar" });
  }
  if ((sidebar?.size?.px ?? Infinity) < 160) {
    setShared("sidebar.collapsed", false);
    run("layout.resize", {
      id: "sidebar",
      px: shared("sidebar.width") ?? 268,
    });
  }
  const stack = findNode(root, "sidebar-lists");
  const nextChild = stack?.active === "inbox" ? "lists" : "inbox";
  run("layout.select", { stack: "sidebar-lists", child: nextChild });
}

function moveFocusedPaneToNeighborTab(direction) {
  const step = direction === "left" ? -1 : 1;
  const f = focused();
  if (!f?.terminal || !f?.tab) return;
  const allSpaces = spaces();
  const sp =
    allSpaces.find((s) => s.id === f.space) ??
    allSpaces.find((s) => s.focused);
  if (!sp?.tabs) return;
  const visibleTabs = sp.tabs.filter((t) => !t.settled);
  const curIdx = visibleTabs.findIndex((t) => t.id === f.tab);
  if (curIdx < 0) return;
  const targetTab = visibleTabs[curIdx + step];
  if (!targetTab) return;

  run("tab.select", { id: targetTab.id });
  run("terminal.park", { terminal: f.terminal });
  run("terminal.keep", { terminal: f.terminal, place: "right" });
  run("pane.focus", { terminal: f.terminal });
}

// The herdr TUI's prefix keys (~/.config/herdr/config.toml): Ctrl+Space, then a key.
// Keys use TUI spelling: uppercase = shift+letter, "alt+n" = alt chord, "ctrl+h" = ctrl chord.
// Each binding is [key, label, command, args].
const BINDINGS = [
  ["c", "New tab", "tab.new"],
  [",", "Rename tab", "tab.rename"],
  ["T", "Rename tab", "tab.rename"],
  ["&", "Close tab", "tab.close"],
  ["X", "Close tab", "tab.close"],
  ["]", "Next tab", "tab.next"],
  ["[", "Previous tab", "tab.prev"],
  ["n", "Next tab", "tab.next"],
  ["p", "Previous tab", "tab.prev"],
  ...Array.from({ length: 9 }, (_, i) => [
    String(i + 1),
    `Tab ${i + 1}`,
    "tab.select",
    { index: i + 1 },
  ]),
  ["%", "Split right", "pane.split", { direction: "right" }],
  ["v", "Split right", "pane.split", { direction: "right" }],
  ['"', "Split down", "pane.split", { direction: "down" }],
  ["-", "Split down", "pane.split", { direction: "down" }],
  ["x", "Close pane", "pane.close"],
  ["z", "Zoom pane", "pane.zoom"],
  ["h", "Focus left", "pane.go", { direction: "left" }],
  ["j", "Focus down", "pane.go", { direction: "down" }],
  ["k", "Focus up", "pane.go", { direction: "up" }],
  ["l", "Focus right", "pane.go", { direction: "right" }],
  ["H", "Swap left", "pane.swap", { direction: "left" }],
  ["J", "Swap down", "pane.swap", { direction: "down" }],
  ["K", "Swap up", "pane.swap", { direction: "up" }],
  ["L", "Swap right", "pane.swap", { direction: "right" }],
  ["ctrl+h", "Move pane left tab", "__custom__", "move-pane:left"],
  ["ctrl+l", "Move pane right tab", "__custom__", "move-pane:right"],
  ["up", "Previous agent", "__custom__", "prev-agent"],
  ["down", "Next agent", "__custom__", "next-agent"],
  ["alt+n", "New space", "space.new"],
  ["N", "New space in ~", "space.new", { folder: "" }],
  ["W", "Rename space", "space.rename"],
  ["D", "Close space", "space.close"],
  ["alt+g", "Worktree dialog", "mod.open", { name: "worktree" }],
  ["w", "Spaces picker", "mod.open", { name: "tui-spaces" }],
  ["g", "Recap session navigator", "mod.open", { name: "recap" }],
  ["r", "Recap session navigator", "mod.open", { name: "recap" }],
  ["space", "T3 pane/session picker", "mod.open", { name: "t3-picker" }],
  ["alt+t", "Tree session navigator", "mod.open", { name: "tui-goto" }],
  ["i", "Toggle T3 Inbox / Spaces sidebar", "__custom__", "toggle-inbox"],
  ["S", "Settle / unsettle agent (T3)", "t3-inbox.settle"],
  ["b", "Minimize/maximize sidebar", "__custom__", "toggle-sidebar"],
  ["f", "Toggle files panel", "__custom__", "panel:files"],
  ["G", "Toggle changes panel", "__custom__", "panel:changes"],
  ["o", "Toggle GitHub PRs panel", "__custom__", "panel:prs"],
  ["O", "Toggle right panel", "__custom__", "panel:toggle"],
  ["alt+o", "GitHub PRs (TUI)", "__custom__", "github-prs"],
  ["alt+p", "Agent PR", "__custom__", "agent-pr"],
  ["s", "Settings", "app.settings"],
  ["q", "Detach (minimize)", "window.minimize"],
];

function keyName(e) {
  const m = e.modifiers;
  if (m.alt) return `alt+${e.key}`;
  if (m.control) return `ctrl+${e.key}`;
  if (m.platform) return null;
  return (
    e.key_char ?? (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key)
  );
}

export default class TuiPrefix extends View {
  init(_props, cx) {
    this.isDaemon = Boolean(props()?.daemon);
    if (!this.isDaemon) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    this.all = false;

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) continue;
        try {
          if (cmd.startsWith("focus-agent:")) {
            const n = parseInt(cmd.slice("focus-agent:".length), 10);
            if (n >= 1) focusAgentByIndex(n);
          } else if (cmd === "prev-agent") {
            cycleAgent(-1);
          } else if (cmd === "next-agent") {
            cycleAgent(1);
          } else if (cmd === "prev-subagent") {
            cycleSubagent(-1);
          } else if (cmd === "next-subagent") {
            cycleSubagent(1);
          } else if (cmd === "move-pane:left" || cmd === "move-pane-left") {
            moveFocusedPaneToNeighborTab("left");
          } else if (cmd === "move-pane:right" || cmd === "move-pane-right") {
            moveFocusedPaneToNeighborTab("right");
          } else if (cmd === "toggle-sidebar") {
            toggleSidebarRail();
          } else if (cmd === "toggle-inbox") {
            toggleSidebarInbox();
          } else if (cmd === "github-prs") {
            await openGithub("open", "GitHub PRs");
          } else if (cmd === "agent-pr") {
            await openGithub("pr", "Agent PR");
          } else if (!this.isDaemon) {
            this.sendPrefix(cx);
          }
        } catch (err) {
          console.log(`tui-prefix: command "${cmd}" failed: ${err?.stack ?? err}`);
        }
        cx.notify();
      }
    });
  }

  dismiss() {
    if (!this.isDaemon && props()?.overlay) {
      closeOverlay(props().overlay);
    }
  }

  sendPrefix(cx) {
    const terminal = focused()?.terminal;
    if (!terminal) return this.dismiss();
    const pending = hc(["keys", terminal, "ctrl+space"]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`tui-prefix: ${result.stderr}`);
    });
    this.dismiss();
  }

  key(e, cx) {
    cx.stop_propagation();
    if (e.key === "escape") return this.dismiss();
    if (e.modifiers.control && e.key === "space") return this.sendPrefix(cx);
    const key = keyName(e);
    if (key === "?") {
      this.all = !this.all;
      cx.notify();
      return;
    }
    const binding = BINDINGS.find((b) => b[0] === key);
    this.dismiss();
    if (!binding) return;
    if (binding[2] === "__custom__") {
      if (binding[3] === "prev-agent") cycleAgent(-1);
      if (binding[3] === "next-agent") cycleAgent(1);
      if (binding[3] === "move-pane:left") moveFocusedPaneToNeighborTab("left");
      if (binding[3] === "move-pane:right") moveFocusedPaneToNeighborTab("right");
      if (binding[3] === "toggle-sidebar") toggleSidebarRail();
      if (binding[3] === "toggle-inbox") toggleSidebarInbox();
      if (binding[3] === "panel:files") toggleRightPanelTab("files");
      if (binding[3] === "panel:changes") toggleRightPanelTab("changes");
      if (binding[3] === "panel:prs") toggleRightPanelTab("pull-requests");
      if (binding[3] === "panel:toggle") run("layout.toggle", { id: "panel" });
      if (binding[3] === "github-prs") openGithub("open", "GitHub PRs");
      if (binding[3] === "agent-pr") openGithub("pr", "Agent PR");
    } else {
      run(binding[2], binding[3] ?? {});
    }
  }

  render() {
    if (props()?.daemon) {
      return div().id("tui-prefix-daemon").size(0);
    }
    const t = theme();
    const rows = this.all
      ? BINDINGS
      : BINDINGS.filter(([key]) => !/^\d$/.test(key));
    return v_flex()
      .id("tui-prefix")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(14)
      .gap(8)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .child(
        h_flex()
          .justify_between()
          .child(div().font_semibold().child("Ctrl+Space · Herdr TUI Keybindings"))
          .child(div().text_color(t.muted).child("Esc close · ^Space send prefix")),
      )
      .child(
        v_flex()
          .h(280)
          .min_h(0)
          .overflow_y_scrollbar()
          .children(
            rows.map(([key, label]) =>
              h_flex()
                .h(20)
                .flex_none()
                .items_center()
                .gap(12)
                .child(div().w(56).text_color(t.accent).child(key))
                .child(div().flex_1().child(label)),
            ),
          ),
      )
      .child(div().text_color(t.muted).child("1–9 tabs · Ctrl+1–9 agents · Ctrl+Shift+1–9 agents 10–18 · ? toggle all"));
  }
}
