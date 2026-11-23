const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const sourceMod = path.resolve(__dirname, "../mods/markdown-browser");
const COLORS = {
  background: "#111", popover: "#181818", hover: "#262626", selected: "#333",
  border: "#444", foreground: "#eee", muted: "#aaa", dim: "#777", accent: "#78a9ff",
};
const BUILDERS = [
  "size_full", "h_full", "w_full", "h", "flex", "flex_1", "flex_none", "min_w", "min_h",
  "items_center", "gap", "p", "px", "py", "pt", "pb", "mx", "mt", "rounded", "bg", "border_1", "border_b", "border_t",
  "border_color", "text_size", "text_color", "text_right", "truncate", "font_semibold",
  "overflow_hidden", "cursor_pointer", "cursor_text", "relative", "absolute", "inset_0",
  "scrollable", "selectable", "track_scroll",
];

function element(kind) {
  const node = { kind, id: null, text: [], children: [], props: {}, handlers: {} };
  const api = {
    node,
    id(value) { node.id = value; return api; },
    child(child) {
      if (typeof child === "string") node.text.push(child);
      else if (child != null && child !== false) node.children.push(child);
      return api;
    },
    children(children) { for (const child of children) api.child(child); return api; },
    when(condition, draw) { if (condition) draw(api); return api; },
    on_click(handler) { node.handlers.click = handler; return api; },
    on_mouse_down(button, handler) { node.handlers[`mouseDown:${button}`] = handler; return api; },
    on_key_down(handler) { node.handlers.keyDown = handler; return api; },
    on_item_click(handler) { node.handlers.itemClick = handler; return api; },
    on_item_secondary_click(handler) { node.handlers.itemSecondaryClick = handler; return api; },
    hover() { return api; },
  };
  for (const method of BUILDERS) api[method] = (value) => { node.props[method] = value ?? true; return api; };
  return api;
}

function nodes(tree) {
  if (!tree || typeof tree === "string") return [];
  const node = tree.node ?? tree;
  return [node, ...node.children.flatMap(nodes)];
}
function byId(tree, id) { return nodes(tree).find((node) => node.id === id); }
function visible(tree) { return nodes(tree).flatMap((node) => node.text); }

function makeCx() {
  const cx = {
    pending: [], timers: [], notified: 0, stopped: 0,
    spawn(task) {
      const promise = Promise.resolve().then(() => task(cx));
      cx.pending.push(promise);
      return promise;
    },
    notify() { cx.notified++; },
    stop_propagation() { cx.stopped++; },
    sleep() { return Promise.resolve(); },
    timer: { every(ms, task) { cx.timers.push({ ms, task }); } },
  };
  return cx;
}

function install(overrides = {}) {
  let nextPane = 1;
  const state = {
    props: {},
    spaces: [{ id: "space-1", active: true, folder: "/repo", machine: null }],
    panes: [{ pane: "pane-term", tab: "tab-1", terminal: "term-1", cwd: "/repo", focused: true }],
    focused: { tab: "tab-1", pane: "pane-term", cwd: "/repo" },
    shared: {},
    files: ["README.md", "docs/guide.md"],
    repoRoot: "/repo",
    runs: [],
    overlays: [],
    closedOverlays: [],
    notifications: [],
    execCalls: [],
    hcCalls: [],
    hcHandler: null,
    execHandler: null,
    ...overrides,
  };
  globalThis.__herdr = {
    props: () => state.props,
    theme: () => COLORS,
    spaces: () => state.spaces,
    panes: () => state.panes,
    focused: () => state.focused,
    home: () => "/home/tester",
    window: () => ({ platform: "linux" }),
    shared: (key) => state.shared[key],
    setShared: (key, value) => { state.shared[key] = value; },
    readTextFile: async () => "",
    watchFolder: () => new Promise(() => {}),
    nextCommand: () => new Promise(() => {}),
    openOverlay: (spec) => { state.overlays.push(spec); },
    closeOverlay: (id) => { state.closedOverlays.push(id); },
    notify: (note) => { state.notifications.push(note); },
    hc: async (args) => {
      state.hcCalls.push(args);
      if (state.hcHandler) return state.hcHandler(args);
      return { code: 1, stdout: "", stderr: "" };
    },
    exec: async (cmd, args, opts) => {
      state.execCalls.push({ cmd, args, opts });
      if (state.execHandler) {
        const res = await state.execHandler(cmd, args, opts);
        if (res) return res;
      }
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${state.repoRoot}\n`, stderr: "" };
      }
      if (cmd === "git" && args.includes("ls-files")) {
        return { code: 0, stdout: `${state.files.join("\0")}\0`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected exec" };
    },
    run: (action, payload) => {
      state.runs.push({ action, payload });
      if (action === "pane.split") {
        const pane = `pane-preview-${nextPane++}`;
        state.panes.push({ pane, tab: state.focused.tab, mod: payload.mod, props: payload.props, focused: false });
      } else if (action === "pane.focus") {
        for (const p of state.panes) p.focused = p.pane === payload.pane;
        state.focused = { ...state.focused, pane: payload.pane };
      } else if (action === "pane.close") {
        state.panes = state.panes.filter((p) => p.pane !== payload.pane);
      }
    },
  };
  return state;
}

let Mod, Mentions, root;
before(async () => {
  globalThis.__kit = {
    View: class {},
    element,
    InputState: {
      new() {
        const listeners = {};
        return {
          _value: "",
          focused: false,
          on(event, fn) { listeners[event] = fn; },
          emit(event, cx) { listeners[event]?.({}, cx); },
          focus() { this.focused = true; },
          value() { return this._value; },
          set_value(v) { this._value = v; },
        };
      },
    },
    VirtualListScrollHandle: { new() { return { scroll_to_item() {} }; } },
    v_virtual_list(id, count, _rowHeight, _keyFn, renderRange) {
      const el = element("v_virtual_list").id(id);
      el.children(renderRange({ start: 0, end: count }));
      return el;
    },
  };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "markdown-browser-test-"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const packages = {
    "gpui-kit": 'export const View = globalThis.__kit.View; export const div = () => globalThis.__kit.element("div");',
    "gpui-base": [
      'export const h_flex = () => globalThis.__kit.element("h_flex");',
      'export const v_flex = () => globalThis.__kit.element("v_flex");',
      'export const TextView = { markdown: (id, text) => globalThis.__kit.element("TextView").id(id).child(text) };',
      'export const InputState = globalThis.__kit.InputState;',
      'export const Input = { new: () => globalThis.__kit.element("Input") };',
      'export const v_virtual_list = (...args) => globalThis.__kit.v_virtual_list(...args);',
      'export const Scrollbar = { vertical: (id) => globalThis.__kit.element("Scrollbar").id(id) };',
      'export const VirtualListScrollHandle = globalThis.__kit.VirtualListScrollHandle;',
    ].join("\n"),
    herdr: [
      "props", "readTextFile", "watchFolder", "theme", "spaces", "panes", "focused", "run",
      "notify", "openOverlay", "closeOverlay", "nextCommand", "shared", "setShared", "home", "exec", "hc", "window",
    ].map((name) => `export const ${name} = (...args) => globalThis.__herdr.${name}(...args);`).join("\n"),
  };
  for (const [name, content] of Object.entries(packages)) {
    const dir = path.join(root, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await fs.writeFile(path.join(dir, "index.js"), content);
  }
  const target = path.join(root, "mod");
  await fs.mkdir(target);
  for (const file of ["main.js", "list.js", "open.js", "mentions.js"]) {
    await fs.copyFile(path.join(sourceMod, file), path.join(target, file));
  }
  Mod = (await import(pathToFileURL(path.join(target, "main.js")))).default;
  Mentions = await import(pathToFileURL(path.join(target, "mentions.js")));
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function initListMod(state) {
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  await cx.pending[0];
  return { mod, cx };
}

test("clicking a local file splits preview-plus and records panes and last", async () => {
  const state = install();
  const { mod, cx } = await initListMod(state);
  const tree = mod.render(cx);
  const list = byId(tree, "mb-files");
  list.handlers.itemClick("README.md", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: undefined,
      mod: "preview-plus",
      props: { file: "/repo/README.md", root: "/repo", on: null, space: "space-1" },
    },
  }]);
  assert.deepEqual(state.shared["markdown-browser.panes"], {
    "pane-preview-1": { file: "/repo/README.md", on: null },
  });
  assert.deepEqual(state.shared["markdown-browser.last"], {
    "tab-1": "pane-preview-1",
  });
  assert.deepEqual(state.notifications, []);
});

test("previewing the same file again focuses the existing preview-plus pane without splitting", async () => {
  const state = install();
  const { mod, cx } = await initListMod(state);
  await mod.queuePreview("/repo/README.md", null, cx);
  state.runs.length = 0;

  await mod.queuePreview("/repo/README.md", null, cx);

  assert.deepEqual(state.runs, [{
    action: "pane.focus",
    payload: { pane: "pane-preview-1" },
  }]);
  assert.equal(state.panes.filter((p) => p.mod === "preview-plus").length, 1);
});

test("previewing a different file replaces the existing preview-plus pane and updates state", async () => {
  const state = install();
  const { mod, cx } = await initListMod(state);
  await mod.queuePreview("/repo/README.md", null, cx);
  state.runs.length = 0;

  await mod.queuePreview("/repo/docs/guide.md", null, cx);

  assert.deepEqual(state.runs, [
    {
      action: "pane.split",
      payload: {
        direction: "right",
        pane: "pane-preview-1",
        mod: "preview-plus",
        props: { file: "/repo/docs/guide.md", root: "/repo", on: null, space: "space-1" },
      },
    },
    { action: "pane.focus", payload: { pane: "pane-preview-2" } },
    { action: "pane.swap", payload: { direction: "left" } },
    { action: "pane.close", payload: { pane: "pane-preview-1" } },
  ]);
  assert.deepEqual(state.shared["markdown-browser.panes"], {
    "pane-preview-2": { file: "/repo/docs/guide.md", on: null },
  });
  assert.deepEqual(state.shared["markdown-browser.last"], {
    "tab-1": "pane-preview-2",
  });
  assert.deepEqual(state.panes.filter((p) => p.mod === "preview-plus").map((p) => p.pane), ["pane-preview-2"]);
});

test("Preview in new pane keeps the existing pane open and forwards root and remote host", async () => {
  const state = install({
    spaces: [{ id: "space-remote", active: true, folder: "/srv/docs", machine: "192.168.88.251" }],
    panes: [{ pane: "pane-term", tab: "tab-1", terminal: "term-1", cwd: "/srv/docs", focused: true }],
    focused: { tab: "tab-1", pane: "pane-term", cwd: "/srv/docs" },
    repoRoot: "/srv/docs",
  });
  const { mod, cx } = await initListMod(state);
  await mod.queuePreview("/srv/docs/README.md", "192.168.88.251", cx);
  state.runs.length = 0;

  const list = byId(mod.render(cx), "mb-files");
  list.handlers.itemSecondaryClick("docs/guide.md", {}, cx);
  assert.equal(state.overlays.length, 1);
  assert.deepEqual(state.overlays[0].props, {
    file: "/srv/docs/docs/guide.md",
    root: "/srv/docs",
    on: "192.168.88.251",
  });

  state.props = { ...state.overlays[0].props, overlay: "menu-overlay-1" };
  const menuMod = new Mod(), menuCx = makeCx();
  menuMod.init({}, menuCx);
  const menuTree = menuMod.render(menuCx);
  byId(menuTree, "mb-preview").handlers.click({}, menuCx);
  await menuCx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: undefined,
      mod: "preview-plus",
      props: {
        file: "/srv/docs/docs/guide.md",
        root: "/srv/docs",
        on: "192.168.88.251",
        space: "space-remote",
      },
    },
  }]);
  assert.deepEqual(state.closedOverlays, ["menu-overlay-1"]);
  assert.deepEqual(state.panes.filter((p) => p.mod === "preview-plus").map((p) => p.pane), [
    "pane-preview-1",
    "pane-preview-2",
  ]);
  assert.deepEqual(state.shared["markdown-browser.panes"], {
    "pane-preview-1": { file: "/srv/docs/README.md", on: "192.168.88.251" },
    "pane-preview-2": { file: "/srv/docs/docs/guide.md", on: "192.168.88.251" },
  });
});

test("list view highlights the currently open preview-plus file row and tracks last focused preview", async () => {
  const state = install();
  const { mod, cx } = await initListMod(state);
  await mod.queuePreview("/repo/docs/guide.md", null, cx);

  // Focus the preview-plus pane and verify render() records it in LAST.
  state.shared["markdown-browser.last"] = {};
  for (const p of state.panes) p.focused = p.pane === "pane-preview-1";
  state.focused = { tab: "tab-1", pane: "pane-preview-1" };

  const tree = mod.render(cx);
  assert.deepEqual(state.shared["markdown-browser.last"], { "tab-1": "pane-preview-1" });

  const list = byId(tree, "mb-files");
  assert.equal(list.children.length, 2);
  const [readmeRow, guideRow] = list.children.map((el) => el.node);

  assert.ok(visible(readmeRow).includes("README.md"));
  assert.equal(readmeRow.props.bg, undefined);
  assert.equal(readmeRow.children[0].node.props.font_semibold, undefined);

  assert.ok(visible(guideRow).includes("guide.md"));
  assert.equal(guideRow.props.bg, COLORS.selected);
  assert.equal(guideRow.children[0].node.props.font_semibold, true);
});

test("extractMentions handles normal paths, OpenCode toast boxes, wrapped paths, URL skipping, and newest-first order", () => {
  const screen = [
    "Read @README.md#intro first",
    "See https://github.com/org/repo/blob/main/docs/remote.md for details",
    "╭───────────────────────────────────────────────╮",
    "│  Saved openspec/changes/fleet-provider-       │",
    "│  visibility/design.md                         │",
    "╰───────────────────────────────────────────────╯",
    "Opened file:///srv/docs/notes.markdown?v=2.",
    "Also checked docs/guide.md and README.md again.",
  ].join("\n");

  const mentions = Mentions.extractMentions(screen);
  assert.deepEqual(mentions, [
    "README.md",
    "docs/guide.md",
    "/srv/docs/notes.markdown",
    "openspec/changes/fleet-provider-visibility/design.md",
  ]);
});

test("terminalMentions merges OpenCode sidecar labeled links and hc read mentions on a remote SSH host", async () => {
  const remoteHost = "192.168.88.251";
  const sidecarPayload = JSON.stringify({
    updatedAt: Date.now(),
    cwd: "/srv/docs",
    links: [
      { label: "Design and wireframes", path: "openspec/changes/fleet/design.md" },
      { label: null, path: "docs/guide.md" },
    ],
  });

  const state = install({
    hcHandler: async (args) => {
      assert.deepEqual(args, ["read", "--lines", "120", "192.168.88.251/t7"]);
      return {
        code: 0,
        stdout: "Wrote openspec/changes/fleet/design.md\nOpened README.md\nIgnored missing.md\n",
        stderr: "",
      };
    },
    execHandler: async (cmd, args, opts) => {
      if (cmd !== "sh") return null;
      assert.equal(opts?.on, remoteHost);
      const script = args[1];
      if (script.includes("herdr-md-links")) {
        assert.equal(args[3], "t7");
        assert.equal(args[4], Mentions.fnv1aHex("/srv/docs"));
        return { code: 0, stdout: sidecarPayload, stderr: "" };
      }
      // Verification shell call: args = ["-c", VERIFY_SCRIPT, "sh", cwd, root, ...paths]
      const paths = args.slice(5);
      assert.deepEqual(paths, [
        "openspec/changes/fleet/design.md",
        "docs/guide.md",
        "missing.md",
        "README.md",
      ]);
      const lines = [
        "0\t/srv/docs/openspec/changes/fleet/design.md",
        "1\t/srv/docs/docs/guide.md",
        "3\t/srv/docs/README.md",
      ];
      return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    },
  });

  const result = await Mentions.terminalMentions({
    terminal: "192.168.88.251/t7",
    cwd: "/srv/docs",
    root: "/srv/docs",
    on: remoteHost,
  });

  assert.deepEqual(result, [
    {
      file: "/srv/docs/openspec/changes/fleet/design.md",
      label: "Design and wireframes",
      rel: "openspec/changes/fleet/design.md",
      on: remoteHost,
    },
    {
      file: "/srv/docs/docs/guide.md",
      label: null,
      rel: "docs/guide.md",
      on: remoteHost,
    },
    {
      file: "/srv/docs/README.md",
      label: null,
      rel: "README.md",
      on: remoteHost,
    },
  ]);
  assert.equal(state.hcCalls.length, 1);
  assert.equal(state.execCalls.filter((c) => c.cmd === "sh").length, 2);
});

test("quick-picker overlay renders terminal mentions first, opens preview-plus on click/Enter, and closes", async () => {
  const sidecarPayload = JSON.stringify({
    updatedAt: Date.now(),
    cwd: "/repo",
    links: [{ label: "Design doc", path: "openspec/design.md" }],
  });
  const state = install({
    props: { overlay: "picker-1" },
    files: ["README.md", "docs/guide.md", "openspec/design.md"],
    hcHandler: async () => ({ code: 0, stdout: "See docs/guide.md\n", stderr: "" }),
    execHandler: async (cmd, args) => {
      if (cmd !== "sh") return null;
      if (args[1].includes("herdr-md-links")) return { code: 0, stdout: sidecarPayload, stderr: "" };
      const paths = args.slice(5);
      const out = paths.map((p, i) => `${i}\t/repo/${p}`).join("\n");
      return { code: 0, stdout: `${out}\n`, stderr: "" };
    },
  });

  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  await Promise.all(cx.pending);

  assert.equal(mod.search.focused, true);
  const tree = mod.render(cx);
  const list = byId(tree, "mb-picker-files");
  assert.equal(list.children.length, 3);

  // Terminal mentions come first (deduplicated against repo list).
  const rowTexts = list.children.map((el) => visible(el.node));
  assert.ok(rowTexts[0].includes("Design doc"));
  assert.ok(rowTexts[0].includes("From this terminal"));
  assert.ok(rowTexts[1].includes("guide.md"));
  assert.ok(rowTexts[1].includes("From this terminal"));
  assert.ok(rowTexts[2].includes("README.md"));
  assert.ok(!rowTexts[2].includes("From this terminal"));

  // Clicking the first item opens preview-plus in the same tab and closes the overlay.
  list.handlers.itemClick("/repo/openspec/design.md", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: undefined,
      mod: "preview-plus",
      props: { file: "/repo/openspec/design.md", root: "/repo", on: null, space: "space-1" },
    },
  }]);
  assert.deepEqual(state.closedOverlays, ["picker-1"]);

  // Pressing down + Enter opens the next item and closes the overlay again.
  state.runs.length = 0;
  state.closedOverlays.length = 0;
  const pickerRoot = byId(mod.render(cx), "markdown-browser-picker");
  pickerRoot.handlers.keyDown({ key: "down", modifiers: {} }, cx);
  assert.equal(mod.at, 1);
  pickerRoot.handlers.keyDown({ key: "enter", modifiers: { shift: true } }, cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: undefined,
      mod: "preview-plus",
      props: { file: "/repo/docs/guide.md", root: "/repo", on: null, space: "space-1" },
    },
  }]);
  assert.deepEqual(state.closedOverlays, ["picker-1"]);
});

test("sidebar renders From this terminal section when mentions are present and supports click and right-click", async () => {
  const sidecarPayload = JSON.stringify({
    updatedAt: Date.now(),
    cwd: "/repo",
    links: [{ label: "Architecture Plan", path: "docs/guide.md" }],
  });
  const state = install({
    hcHandler: async () => ({ code: 0, stdout: "", stderr: "" }),
    execHandler: async (cmd, args) => {
      if (cmd !== "sh") return null;
      if (args[1].includes("herdr-md-links")) return { code: 0, stdout: sidecarPayload, stderr: "" };
      return { code: 0, stdout: "0\t/repo/docs/guide.md\n", stderr: "" };
    },
  });

  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  await Promise.all(cx.pending);

  const tree = mod.render(cx);
  const mentionsSection = byId(tree, "mb-mentions");
  assert.ok(mentionsSection);
  assert.ok(visible(mentionsSection).includes("From this terminal"));
  assert.ok(visible(mentionsSection).includes("Architecture Plan"));
  assert.ok(visible(mentionsSection).includes("docs/guide.md"));

  const mentionRow = byId(tree, "mb-mention-0");
  mentionRow.handlers.click({}, cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: undefined,
      mod: "preview-plus",
      props: { file: "/repo/docs/guide.md", root: "/repo", on: null, space: "space-1" },
    },
  }]);

  // Right-click opens context menu overlay with file & root.
  mentionRow.handlers["mouseDown:right"]({}, cx);
  assert.equal(state.overlays.length, 1);
  assert.deepEqual(state.overlays[0].props, {
    file: "/repo/docs/guide.md",
    root: "/repo",
    on: null,
  });
});

test("terminalMentions POSIX sh sidecar reader and verifier resolve real files including ~/ and root-relative paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-mentions-sh-"));
  try {
    const fakeHome = path.join(tmp, "home");
    const repoRoot = path.join(tmp, "repo");
    const subDir = path.join(repoRoot, "sub");
    const stateDir = path.join(fakeHome, ".local/state/herdr-md-links");
    await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(path.join(fakeHome, "notes"), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    await fs.writeFile(path.join(repoRoot, "docs/design.md"), "# Design\n");
    await fs.writeFile(path.join(fakeHome, "notes/todo.md"), "# Todo\n");

    const realRoot = await fs.realpath(repoRoot);
    const realHome = await fs.realpath(fakeHome);

    await fs.writeFile(
      path.join(stateDir, "terminal-t5.json"),
      JSON.stringify({
        updatedAt: Date.now(),
        cwd: repoRoot,
        links: [{ label: "Design Spec", path: "docs/design.md" }],
      }),
    );

    install({
      hcHandler: async () => ({
        code: 0,
        stdout: "See ~/notes/todo.md and docs/nonexistent.md\n",
        stderr: "",
      }),
      execHandler: async (cmd, args) => {
        if (cmd !== "sh") return null;
        try {
          const { stdout, stderr } = await execFileAsync("sh", args, {
            env: { ...process.env, HOME: fakeHome },
          });
          return { code: 0, stdout, stderr };
        } catch (err) {
          return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        }
      },
    });

    const result = await Mentions.terminalMentions({
      terminal: "t5",
      cwd: subDir,
      root: realRoot,
      on: null,
    });

    assert.deepEqual(result, [
      {
        file: path.join(realRoot, "docs/design.md"),
        label: "Design Spec",
        rel: "docs/design.md",
        on: null,
      },
      {
        file: path.join(realHome, "notes/todo.md"),
        label: null,
        rel: path.join(realHome, "notes/todo.md"),
        on: null,
      },
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
