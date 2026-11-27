import { exec, home, machines, notify, panes, run, terminals } from "herdr";
import { join, MARKDOWN } from "./list.js";

const ROUTE_SOCKET = /^\/tmp\/herdr-md-[A-Za-z0-9]{6}\/route\.sock$/;
const ROUTE_QUERY_TIMEOUT_MS = 1500;
const READ_ROUTE = `
import os, socket, stat, sys

path = sys.argv[1]
parent = os.lstat(os.path.dirname(path))
endpoint = os.lstat(path)
uid = os.geteuid()
if (parent.st_uid != uid or not stat.S_ISDIR(parent.st_mode)
        or stat.S_IMODE(parent.st_mode) != 0o700
        or endpoint.st_uid != uid or not stat.S_ISSOCK(endpoint.st_mode)):
    sys.exit(1)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(0.5)
    client.connect(path)
    with client.makefile("rb") as stream:
        reply = stream.readline(16385)
if len(reply) > 16384 or not reply.endswith(b"\\n"):
    sys.exit(1)
sys.stdout.buffer.write(reply)
`;
const pathText = (p) => typeof p === "string" && p.length > 0
  && !p.startsWith("//") && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\\]/.test(p);
const absolute = (p) => pathText(p) && p.startsWith("/");

function fileUri(raw) {
  const match = /^file:(?:\/\/([^/]*))?(\/.*)$/i.exec(raw.split(/[?#]/, 1)[0]);
  if (!match) return null;
  const authority = match[1] ?? "";
  if (authority && !/^[a-z0-9][a-z0-9.-]*$/i.test(authority)) return null;
  try {
    const path = decodeURIComponent(match[2]);
    return absolute(path) ? { authority: authority.toLowerCase(), path } : null;
  } catch {
    return null;
  }
}

function sourceAvailable({ machine, pane, tab, space }) {
  return pane && tab && space && panes().some((p) => p.pane === pane && p.tab === tab && p.terminal)
    && (machine === null || machines().some((m) => m.name === machine && m.layout === "ready"));
}

const basename = (path) => typeof path === "string" ? path.split(/[\\/]/).at(-1) : "";

function openCodeSource(source) {
  const terminal = terminals().find((t) => t.address === source.terminal);
  if (terminal && terminal.state !== "live") return null;
  const foreground = terminal?.foreground;
  const command = basename(foreground?.argv?.[0]) || foreground?.name;
  if ([command, foreground?.name].some((name) => /^opencode(?:\.exe)?$/i.test(name))) return terminal;
  // Ignore leftover agent status from a foreground interactive shell.
  if (/^-?(?:sh|bash|zsh|fish|nu|dash|ksh|tcsh)$/.test(command)
      && !foreground?.argv?.slice(1).some((arg) => !/^[-+]/.test(arg) || /^-[^-]*c|^--commands?(?:=|$)/.test(arg))) return null;
  if (terminal?.report?.app === "opencode" || terminal?.status?.app === "opencode" || terminal?.program?.key === "opencode") return terminal;
  // A pane may know its program before the full terminal snapshot arrives.
  if (!foreground && panes().some((p) => p.pane === source.pane && p.terminal === source.terminal && p.program?.key === "opencode")) {
    return terminal ?? {};
  }
  return null;
}

function openCodeEndpoint(terminal) {
  const raw = terminal?.labels?.["opencode.link-context"];
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return pathText(value?.socket) && ROUTE_SOCKET.test(value.socket) && Number.isSafeInteger(value.pid)
      && value.pid > 0 && value.pid === terminal.foreground?.pid ? value : null;
  } catch {
    return null;
  }
}

async function openCodeContext(source, agent) {
  const endpoint = openCodeEndpoint(agent);
  if (!endpoint) return null;
  try {
    const started = Date.now();
    const result = await exec("python3", ["-I", "-c", READ_ROUTE, endpoint.socket], {
      on: source.machine, timeout: ROUTE_QUERY_TIMEOUT_MS,
    });
    // The command timeout alone does not cover delays in remote dispatch.
    const elapsed = Date.now() - started;
    if (elapsed < 0 || elapsed >= ROUTE_QUERY_TIMEOUT_MS || result.code !== 0 || result.stdout.length > 16_384) return null;
    const value = JSON.parse(result.stdout);
    const latest = openCodeEndpoint(openCodeSource(source));
    return pathText(value?.sessionID) && absolute(value?.directory) && value.pid === endpoint.pid
      && latest?.pid === endpoint.pid && latest.socket === endpoint.socket ? value : null;
  } catch {
    return null;
  }
}

function warnOpenCodeContext() {
  notify({ title: "OpenCode link context unavailable", body: "Use a local OpenCode server, wait for the visible session to settle, then click again.", level: "warning" });
  return "handled";
}

async function commandOutput(command, args, on) {
  try {
    const result = await exec(command, args, { on, timeout: 3000 });
    return result.code === 0 ? result.stdout.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

export async function handleLink({ link, source }) {
  if (link?.kind !== "file" || typeof link.raw !== "string") return "pass";
  const { raw, path } = link;
  // Passing a rejected local named URI would hand it to the OS opener.
  const named = /^file:[/\\]{2}[^/?#]/i.test(raw);
  const decline = source?.machine == null && named ? "handled" : "pass";
  if (!source || !pathText(raw)) return decline;
  const { cwd, machine, pane, space } = source;
  const isUri = /^file:/i.test(raw);
  const uri = isUri ? fileUri(raw) : null;
  if (isUri ? !uri : !raw.includes("/") || /^[a-z][a-z\d+.-]*:/i.test(raw)) return decline;
  if (!sourceAvailable(source)) return decline;

  const agent = !isUri && !absolute(raw) && !raw.startsWith("~/") ? openCodeSource(source) : null;
  if (!agent && path !== null && (machine !== null || !absolute(path))) return decline;
  // Native resolution used the shell cwd, not the visible OpenCode session.
  let file = (agent ? null : path) ?? uri?.path ?? raw.replace(/\.$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!MARKDOWN.test(file)) return decline;
  const context = agent ? await openCodeContext(source, agent) : null;
  // A label that yields no context is stale or racing; with no label, resolve against the pane cwd like other terminals.
  if (agent && !context && agent.labels?.["opencode.link-context"] != null) return warnOpenCodeContext();
  const root =context?.directory ?? (absolute(cwd) ? cwd : null);
  if (uri?.authority && uri.authority !== "localhost") {
    // The authority is only compared, never used as an execution or preview target.
    const hostname = await commandOutput("hostname", [], machine);
    if (hostname?.toLowerCase() !== uri.authority) return decline;
  } else if (file.startsWith("~/")) {
    const base = machine === null ? home() : await commandOutput("printenv", ["HOME"], machine);
    if (!absolute(base)) return decline;
    file = join(base, file.slice(2));
  } else if (!absolute(file)) {
    if (!root || /^[~$]/.test(file)) return context ? warnOpenCodeContext() : decline;
    file = join(root, file);
  }

  // Recheck after any lookup. The host rejects a missing explicit pane at dispatch.
  if (!absolute(file) || !sourceAvailable(source)) return agent ? "handled" : decline;
  if (file.split("/").includes("..")) {
    // Preview normalizes lexically; the filesystem must resolve parents after symlinks.
    const slash = file.lastIndexOf("/");
    const parent = await commandOutput("realpath", ["--", file.slice(0, slash)], machine);
    if (!sourceAvailable(source)) return "handled";
    if (!absolute(parent)) {
      notify({ title: "Could not resolve Markdown link", body: file, level: "warning" });
      return "handled";
    }
    if (context) {
      const current = await openCodeContext(source, openCodeSource(source));
      if (!sourceAvailable(source)) return "handled";
      if (current?.sessionID !== context.sessionID || current.directory !== context.directory || current.pid !== context.pid) {
        return warnOpenCodeContext();
      }
    }
    file = join(parent, file.slice(slash + 1));
  }
  run("pane.split", { direction: "right", pane, mod: "preview-plus", props: { file, root, on: machine, space } });
  return "handled";
}
