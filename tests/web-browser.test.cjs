const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const sourceMod = path.resolve(__dirname, "../mods/web-browser");
const COLORS = {
  background: "#111", popover: "#181818", hover: "#262626", selected: "#333",
  border: "#444", foreground: "#eee", muted: "#aaa", dim: "#777", accent: "#78a9ff",
};
const BUILDERS = [
  "size_full", "h_full", "w_full", "w", "h", "flex", "flex_1", "flex_none", "min_w", "min_h",
  "items_center", "gap", "p", "px", "py", "pt", "pb", "mx", "mt", "rounded", "bg",
  "border_1", "border_b", "border_t", "border_color", "text_size", "text_color", "text_right",
  "truncate", "font_semibold", "overflow_hidden", "overflow_y_scrollbar", "cursor_pointer",
  "cursor_text", "relative", "absolute", "inset_0", "scrollable", "selectable", "track_scroll",
];

const LSOF = [
  "p843",
  "cSpotify",
  "f222",
  "n*:57621",
  "p38951",
  "cpython3.13",
  "f3",
  "n127.0.0.1:47811",
  "p39352",
  "cterminal-browser",
  "f31",
  "n127.0.0.1:54542",
  "p39381",
  "cnative-scroll-helper",
  "f31",
  "n127.0.0.1:54542",
  "p69128",
  "cpython3.13",
  "f8",
  "n[::1]:9090",
  "f9",
  "n127.0.0.1:9090",
  "p91511",
  "copencode",
  "f7",
  "n127.0.0.1:49374",
  "",
].join("\n");
const SS = [
  'LISTEN 0      512                                 127.0.0.1:42305 0.0.0.0:* users:(("claude",pid=2197027,fd=38))',
  'LISTEN 0      4096                                127.0.0.1:8642  0.0.0.0:*',
  'LISTEN 0      511                            192.168.88.251:8807  0.0.0.0:* users:(("node-MainThread",pid=2893902,fd=21))',
  'LISTEN 0      5                                   127.0.0.1:47812 0.0.0.0:* users:(("python3",pid=1438010,fd=3))',
  'LISTEN 0      511                            192.168.88.251:3105  0.0.0.0:* users:(("next-server (v1",pid=1128,fd=21))',
  'LISTEN 0      4096                                127.0.0.1:43681 0.0.0.0:* users:(("agy",pid=1868814,fd=11))',
  "",
].join("\n");

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
  const state = {
    spaces: [{ id: "space-1", active: true, folder: "/repo", machine: null }],
    panes: [{ pane: "pane-term", tab: "tab-1", terminal: "term-1", cwd: "/repo", focused: true }],
    focused: { tab: "tab-1", pane: "pane-term", cwd: "/repo" },
    terminals: [],
    checking: false,
    runs: [],
    notifications: [],
    execCalls: [],
    execHandler: null,
    ...overrides,
  };
  globalThis.__herdr = {
    theme: () => COLORS,
    spaces: () => state.spaces,
    panes: () => state.panes,
    focused: () => state.focused,
    terminals: () => state.terminals,
    checking: () => state.checking,
    notify: (note) => { state.notifications.push(note); },
    run: (action, payload) => { state.runs.push({ action, payload }); },
    exec: async (cmd, args, opts) => {
      state.execCalls.push({ cmd, args, opts });
      if (state.execHandler) {
        const res = await state.execHandler(cmd, args, opts);
        if (res) return res;
      }
      return { code: 1, stdout: "", stderr: "unexpected exec" };
    },
  };
  return state;
}

let Mod, handleLink, root;
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
  };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "web-browser-test-"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const packages = {
    "gpui-kit": 'export const View = globalThis.__kit.View; export const div = () => globalThis.__kit.element("div");',
    "gpui-base": [
      'export const h_flex = () => globalThis.__kit.element("h_flex");',
      'export const v_flex = () => globalThis.__kit.element("v_flex");',
      'export const InputState = globalThis.__kit.InputState;',
      'export const Input = { new: () => globalThis.__kit.element("Input") };',
    ].join("\n"),
    herdr: [
      "theme", "spaces", "panes", "focused", "exec", "checking", "run", "notify", "terminals",
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
  for (const file of ["main.js", "open.js", "link.js"]) {
    await fs.copyFile(path.join(sourceMod, file), path.join(target, file));
  }
  Mod = (await import(pathToFileURL(path.join(target, "main.js")))).default;
  ({ handleLink } = await import(pathToFileURL(path.join(target, "link.js"))));
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function panel(state, options = {}) {
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  mod.render(cx);
  await Promise.all(cx.pending);
  const tree = mod.render(cx);
  return { mod, cx, tree, ...options };
}

test("local panel lists loopback servers once and hides internals", async () => {
  const state = install({
    execHandler: async (cmd, args, opts) => {
      if (cmd !== "lsof") return null;
      assert.deepEqual(args, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
      assert.deepEqual(opts, { timeout: 5000 });
      return { code: 0, stdout: LSOF, stderr: "" };
    },
  });
  const { tree } = await panel(state);
  const list = byId(tree, "web-ports");
  assert.ok(list, "ports list rendered");

  assert.equal(state.execCalls.length, 1);
  assert.equal(state.execCalls[0].cmd, "lsof");
  assert.deepEqual(state.execCalls[0].args, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  assert.deepEqual(
    list.children.map((el) => visible(el.node).join(" ")),
    [":9090 python3.13", ":47811 python3.13"],
  );
});

test("remote panel keeps non-loopback hosts and hides agent and unroutable sockets", async () => {
  const state = install({
    spaces: [{ id: "space-remote", active: true, folder: "/srv", machine: "linux" }],
    execHandler: async (cmd, args, opts) => {
      if (cmd !== "ss") return null;
      assert.deepEqual(args, ["-Hltnp"]);
      assert.equal(opts?.on, "linux");
      return { code: 0, stdout: SS, stderr: "" };
    },
  });
  const { tree } = await panel(state);
  const rows = byId(tree, "web-ports").children.map((el) => visible(el.node));

  assert.equal(state.execCalls.length, 1);
  assert.equal(state.execCalls[0].cmd, "ss");
  assert.deepEqual(state.execCalls[0].args, ["-Hltnp"]);
  assert.equal(state.execCalls[0].opts?.on, "linux");
  assert.deepEqual(rows.map((row) => row[0]), [":3105", ":8807", ":47812"]);
  assert.deepEqual(rows[0], [":3105", "next-server (v1", "192.168.88.251"]);
  assert.deepEqual(rows[1], [":8807", "node-MainThread", "192.168.88.251"]);
  assert.deepEqual(rows[2], [":47812", "python3"]);
  assert.ok(!rows.some((row) => row[0] === ":8642"));
  assert.ok(!visible(tree).includes("claude"));
  assert.ok(!visible(tree).includes("agy"));
});

test("clicking a loopback port splits a terminal browser beside the focused terminal", async () => {
  const state = install({
    execHandler: async (cmd) => {
      if (cmd !== "lsof") return null;
      return { code: 0, stdout: LSOF, stderr: "" };
    },
  });
  const { cx, tree } = await panel(state);

  byId(tree, "web-port-47811").handlers.click({}, cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: "pane-term",
      argv: ["env", "-u", "TERM_PROGRAM", "terminal-browser", "open", "--no-merge", "http://localhost:47811/"],
    },
  }]);
});

test("a remote click without terminal-browser warns and does not split", async () => {
  const state = install({
    spaces: [{ id: "space-remote", active: true, folder: "/srv", machine: "linux" }],
    execHandler: async (cmd, args, opts) => {
      if (cmd === "ss") return { code: 0, stdout: SS, stderr: "" };
      if (cmd === "sh") {
        assert.deepEqual(args, ["-c", "command -v terminal-browser"]);
        assert.equal(opts?.on, "linux");
        return { code: 1, stdout: "", stderr: "" };
      }
      return null;
    },
  });
  const { cx, tree } = await panel(state);

  byId(tree, "web-port-8807").handlers.click({}, cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, []);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].level, "warning");
  assert.match(state.notifications[0].body, /https:\/\/terminal-browser\.sh\/install/);
  assert.ok(state.execCalls.some((call) =>
    call.cmd === "sh" && call.opts?.on === "linux" &&
    call.args[0] === "-c" && call.args[1] === "command -v terminal-browser"));
});

test("URL box normalizes a port and rejects text", async () => {
  const state = install();
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);

  mod.url.set_value("3000");
  mod.url.emit("submit", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: "pane-term",
      argv: ["env", "-u", "TERM_PROGRAM", "terminal-browser", "open", "--no-merge", "http://localhost:3000/"],
    },
  }]);

  state.runs.length = 0;
  mod.url.set_value("not a url");
  mod.url.emit("submit", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, []);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].level, "warning");

  const odd = "http://localhost:3000/?a=1&b=$(id);x`id`";
  mod.url.set_value(odd);
  mod.url.emit("submit", cx);
  await cx.pending.at(-1);
  assert.equal(state.runs[0].payload.argv.at(-1), odd, "the URL stays one argv word");
});

test("a short process name is not hidden as a prefix of a hidden one", async () => {
  const state = install({
    execHandler: async (cmd) => cmd === "lsof"
      ? { code: 0, stdout: "p1\ncc\nf3\nn127.0.0.1:4000\np2\ncterminal-\nf4\nn127.0.0.1:4001\n", stderr: "" }
      : null,
  });
  const { tree } = await panel(state);
  assert.deepEqual(byId(tree, "web-ports").children.map((el) => visible(el.node).join(" ")), [":4000 c"]);
});

test("an existing terminal-browser in the tab gets a new tab, not a split", async () => {
  const state = install({
    panes: [
      { pane: "pane-term", tab: "tab-1", terminal: "term-1", cwd: "/repo", focused: true },
      { pane: "pane-browser", tab: "tab-1", terminal: "term-2", cwd: "/repo", focused: false },
    ],
    terminals: [
      { address: "term-1", foreground: { name: "zsh", pid: 1 } },
      { address: "term-2", foreground: { name: "terminal-browser", pid: 4242 } },
    ],
    execHandler: async (cmd, args) => {
      if (cmd === "ps") {
        assert.deepEqual(args, ["-o", "tty=", "-p", "4242"]);
        return { code: 0, stdout: "ttys027\n", stderr: "" };
      }
      if (cmd === "env" && args.includes("ls")) {
        return {
          code: 0,
          stdout: JSON.stringify({ browsers: [{ key: "b1", tty: "/dev/ttys027" }] }),
          stderr: "",
        };
      }
      if (cmd === "env" && args.includes("action")) {
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return null;
    },
  });
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);

  mod.url.set_value("http://127.0.0.1:3000/");
  mod.url.emit("submit", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs, [{ action: "pane.focus", payload: { pane: "pane-browser" } }]);
  assert.ok(!state.runs.some((run) => run.action === "pane.split"));

  const action = state.execCalls.find((call) => call.cmd === "env" && call.args.includes("action"));
  assert.deepEqual(action.args, [
    "-u", "TERM_PROGRAM", "terminal-browser", "action", "--browser", "b1", "--",
    "tab", "new", "http://127.0.0.1:3000/",
  ]);
});

test("a reused browser that can't take focus still gets no second split", async () => {
  const state = install({
    panes: [
      { pane: "pane-term", tab: "tab-1", terminal: "term-1", cwd: "/repo", focused: true },
      { pane: "pane-browser", tab: "tab-1", terminal: "term-2", cwd: "/repo", focused: false },
    ],
    terminals: [
      { address: "term-1", foreground: { name: "zsh", pid: 1 } },
      { address: "term-2", foreground: { name: "terminal-browser", pid: 4242 } },
    ],
    execHandler: async (cmd, args) => {
      if (cmd === "ps") return { code: 0, stdout: "ttys027\n", stderr: "" };
      if (cmd === "env" && args.includes("ls")) {
        return {
          code: 0,
          stdout: JSON.stringify({ browsers: [{ key: "b1", tty: "/dev/ttys027" }] }),
          stderr: "",
        };
      }
      if (cmd === "env" && args.includes("action")) return { code: 0, stdout: "{}", stderr: "" };
      return null;
    },
  });
  globalThis.__herdr.run = (action, payload) => {
    state.runs.push({ action, payload });
    if (action === "pane.focus") throw new Error("no focus");
  };
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);

  mod.url.set_value("3000");
  mod.url.emit("submit", cx);
  await cx.pending.at(-1);

  assert.deepEqual(state.runs.map((run) => run.action), ["pane.focus"]);
});

test("handleLink passes files and unknown panes and handles loopback URLs", async () => {
  const state = install();

  assert.equal(await handleLink({
    link: { kind: "file", raw: "README.md" },
    source: { pane: "pane-term", machine: null, tab: "tab-1" },
  }), "pass");
  assert.equal(await handleLink({
    link: { kind: "url", raw: "http://127.0.0.1:47811/" },
    source: { pane: "gone", machine: null, tab: "tab-1" },
  }), "pass");
  assert.deepEqual(state.runs, []);

  assert.equal(await handleLink({
    link: { kind: "url", raw: "http://127.0.0.1:47811/" },
    source: { pane: "pane-term", machine: null, tab: "tab-1" },
  }), "handled");

  assert.deepEqual(state.runs, [{
    action: "pane.split",
    payload: {
      direction: "right",
      pane: "pane-term",
      argv: ["env", "-u", "TERM_PROGRAM", "terminal-browser", "open", "--no-merge", "http://127.0.0.1:47811/"],
    },
  }]);
});

test("checking mode renders without querying ports", async () => {
  const state = install({ checking: true });
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  const tree = mod.render(cx);

  assert.ok(byId(tree, "web-browser"));
  assert.equal(state.execCalls.length, 0);
  assert.equal(state.runs.length, 0);
});
