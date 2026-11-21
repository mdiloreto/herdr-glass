const NODE = Symbol("node");
const STYLE_CALLBACKS = new Set(["hover"]);
const UNRECORDED = new Set(["when"]);

const fresh = () => ({ shared: {}, props: null, focused: null, exec: async () => ({ code: 1, stdout: "" }), execs: [], sets: [], ids: new Map() });
export const host = fresh();
export const resetHost = () => Object.assign(host, fresh());

const isElement = (x) => typeof x === "function" && x[NODE] != null;
export const nodeOf = (drawn) => drawn[NODE];

function recordArg(arg, name) {
  if (isElement(arg)) return arg[NODE];
  if (Array.isArray(arg)) return arg.map((x) => recordArg(x, name));
  if (typeof arg === "function" && STYLE_CALLBACKS.has(name)) return nodeOf(arg(element("style")));
  if (typeof arg === "function") return "fn";
  return arg;
}

function element(kind, args = []) {
  const node = { kind, args: args.map((a) => recordArg(a, kind)), calls: [], handlers: {} };
  const self = new Proxy(function stub() {}, {
    get(_target, key) {
      if (key === NODE) return node;
      return (...callArgs) => {
        if (key === "when") {
          if (callArgs[0]) callArgs[1](self);
          return self;
        }
        if (key === "id") host.ids.set(callArgs[0], node);
        if (key === "children" && !Array.isArray(callArgs[0])) throw new Error("children wants an array");
        callArgs.filter((a) => typeof a === "function" && !isElement(a)).forEach((f) => { node.handlers[key] = f; });
        if (!UNRECORDED.has(key)) node.calls.push([key, callArgs.map((a) => recordArg(a, key))]);
        return self;
      };
    },
  });
  return self;
}

export function View() {}
export const div = () => element("div");
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const svg = (path) => element("svg", [path]);
export const image = (path) => element("image", [path]);
export const HoverCard = { new: (id) => element("HoverCard", [id]) };

const THEME = new Proxy({}, { get: (_target, key) => (typeof key === "string" && !key.startsWith("ansi") ? `theme.${key}` : undefined) });
export const theme = () => THEME;
export const props = () => host.props;
export const focused = () => host.focused;
export const appHome = () => "/app";
export const shared = (key) => host.shared[key] ?? null;
export const setShared = (key, value) => {
  host.sets.push([key, value]);
  host.shared[key] = value;
};
export const exec = (...args) => {
  host.execs.push(args);
  return host.exec(...args);
};

export function fakeCx() {
  const cx = { pending: [], notified: 0, timers: [] };
  cx.spawn = (run) => { cx.pending.push(run(cx)); };
  cx.notify = () => { cx.notified += 1; };
  cx.timer = { every: (ms, run) => { cx.timers.push([ms, run]); } };
  return cx;
}

export async function settle(cx) {
  while (cx.pending.length) {
    const running = cx.pending.splice(0);
    await Promise.all(running);
  }
}
