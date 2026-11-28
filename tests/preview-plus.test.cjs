const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const sourceMod = path.resolve(__dirname, "../mods/preview-plus");

function element() {
  const api = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : () => api });
  return api;
}

function makeCx() {
  const cx = {
    timers: [],
    spawn(task) { return Promise.resolve().then(() => task(cx)); },
    notify() {},
    focus_handle() { return { focus() {}, is_focused() { return false; } }; },
    timer: { every(ms, task) { cx.timers.push({ ms, task }); }, after() {} },
  };
  return cx;
}

// The nextCommand loop never ends, so spawned tasks cannot be awaited; yield to the event loop instead.
async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

async function tick(cx, ms) {
  for (const timer of cx.timers) if (timer.ms === ms) timer.task(cx);
  await settle();
}

let Mod, root;
before(async () => {
  globalThis.__element = element;
  globalThis.__stub = () => ({ on() {}, release() {}, focus() {}, value: () => "", set_value() {} });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-plus-test-"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const packages = {
    "gpui-kit": ["export class View {}", ...["div", "image", "svg", "uniform_list"]
      .map((name) => `export const ${name} = () => globalThis.__element();`)].join("\n"),
    "gpui-base": [...["v_flex", "h_flex"].map((name) => `export const ${name} = () => globalThis.__element();`),
      ...["Editor", "Input", "TextView", "Scrollbar"].map((name) => `export const ${name} = new Proxy({}, { get: () => () => globalThis.__element() });`),
      "export const EditorState = { new: () => globalThis.__stub() };",
      "export const InputState = { new: () => globalThis.__stub() };"].join("\n"),
    herdr: ["props", "shared", "setShared", "spaces", "panes", "terminals", "focused", "run", "readTextFile", "writeTextFile",
      "watchFolder", "checking", "settings", "nextCommand", "exec", "window", "appHome", "theme"]
      .map((name) => `export const ${name} = (...args) => globalThis.__herdr.${name}(...args);`).join("\n"),
  };
  for (const [name, content] of Object.entries(packages)) {
    const dir = path.join(root, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await fs.writeFile(path.join(dir, "index.js"), content);
  }
  const target = path.join(root, "mod");
  await fs.mkdir(target);
  for (const file of await fs.readdir(sourceMod)) {
    if (file.endsWith(".js") && file !== "mermaid.bundle.js") await fs.copyFile(path.join(sourceMod, file), path.join(target, file));
  }
  Mod = (await import(pathToFileURL(path.join(target, "main.js")))).default;
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function remotePreview(state) {
  globalThis.__herdr = {
    props: () => ({ file: "/srv/docs/guide.md", root: "/srv/docs", on: "linux", space: "linux/sp1" }),
    shared: () => undefined, setShared() {}, spaces: () => [{ id: "linux/sp1", active: true, machine: "linux" }],
    panes: () => [], terminals: () => [], focused: () => ({ space: "linux/sp1", pane: "p1" }), run() {},
    readTextFile: async (file, opts) => { state.reads.push({ file, on: opts?.on }); if (state.failNext-- > 0) throw new Error("gone"); return state.content; },
    writeTextFile: async () => {}, watchFolder: () => new Promise(() => {}), checking: () => false,
    settings: () => ({}), nextCommand: () => new Promise(() => {}), exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    window: () => ({ platform: "macos" }), appHome: () => root, theme: () => ({}),
  };
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  return { mod, cx };
}

test("the 10 s poll keeps an unchanged remote file rendered instead of reloading it", async () => {
  const state = { reads: [], failNext: 0, content: "# Guide\n\nBody text.\n" };
  const { mod, cx } = remotePreview(state);
  await settle();
  const blocks = mod.markdownBlocks;
  assert.ok(blocks);

  await tick(cx, 10000);

  assert.deepEqual(state.reads.map((read) => read.on), ["linux", "linux"]);
  assert.equal(mod.markdownBlocks, blocks);
  assert.equal(mod.loading, false);
});

test("the 10 s poll reloads a remote file whose content changed", async () => {
  const state = { reads: [], failNext: 0, content: "# Guide\n\nBody text.\n" };
  const { mod, cx } = remotePreview(state);
  await settle();
  const blocks = mod.markdownBlocks;

  state.content = "# Guide\n\nEdited text.\n";
  await tick(cx, 10000);

  assert.notEqual(mod.markdownBlocks, blocks);
  assert.equal(mod.text, state.content);
});

test("the 10 s poll reloads when the read fails", async () => {
  const state = { reads: [], failNext: 0, content: "# Guide\n\nBody text.\n" };
  const { mod, cx } = remotePreview(state);
  await settle();
  const blocks = mod.markdownBlocks;

  state.failNext = 1;
  await tick(cx, 10000);

  assert.equal(state.reads.length, 3);
  assert.notEqual(mod.markdownBlocks, blocks);
  assert.equal(mod.error, null);
});

test("the 10 s poll retries a view that failed to render", async () => {
  const state = { reads: [], failNext: 0, content: "binary\0data" };
  const { mod, cx } = remotePreview(state);
  await settle();
  assert.match(mod.error, /binary/);

  await tick(cx, 10000);

  assert.equal(state.reads.length, 3);
  assert.match(mod.error, /binary/);
});
