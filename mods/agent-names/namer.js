// Tab naming: a chain of namers, each tried only when the one before failed.
// Pure helpers plus a factory that takes the host functions (exec, home, ...)
// as `env`, so this module imports nothing from "herdr" and loads under node.
// The tab's panes carry text other programs wrote, so it reaches every namer
// as data: the agents are tool-less and the prompt is flattened to plain lines.

import { STALE_SUFFIX } from "./cleanup.js";

export const MAX_NAME = 32;
const MAX_REPLY_LINE = 40;
const FREE_MODELS_TRIED = 2;
const MODEL_FAILED_MS = 60 * 60 * 1000;
const FIELD_MAX = 200;
const AGY_MODEL = "gemini-3.8-flash-low";

// The free models get only the tab-namer agent. A private, hidden config dir
// (.xdg: opencode writes into a config dir it loads, and a visible file there
// would reload the mod) replaces the global instructions, MCP servers, plugins
// and agents; project and ~/.claude instruction discovery are off; inherited
// config variables are cleared; --standalone makes the server read this env.
// ~/.agents skills are still discovered whatever XDG_CONFIG_HOME is, so the
// agent's deny-all permission is what keeps them, and every tool, out.
const OPENCODE_ENV = (namerDir) => [
  "-u", "OPENCODE_CONFIG", "-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT",
  `XDG_CONFIG_HOME=${namerDir}/.xdg`,
  "OPENCODE_DISABLE_CLAUDE_CODE=1",
  "OPENCODE_DISABLE_PROJECT_CONFIG=1",
];

const EDGE = /^[\s"'`“”‘’]+|[\s"'`“”‘’.,;:!?…]+$/g;
// Controls (not whitespace, which collapses), zero-width, bidi and tag characters: a name is shown in a tab bar, so none may reach it.
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1B(?:[()][0-9A-Za-z]|[@-Z\\-_])/g;
const PUA = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const BOX_EDGE = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•]+|[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•]+$/g;
const TIMESTAMP_ONLY = /^(?:[\u2800-\u28FF✳✶✻✽✢◐◓◑◒]\s*)*[\[(]?(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?|\d+(?:\.\d+)?\s*(?:ms|s|m|h)(?:\s+\d+\s*(?:ms|s|m))*)[\])]?$/i;

// Cut to n UTF-16 units without leaving half a surrogate pair.
function cut(s, n) {
  const out = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

// Parse `hc read <addr> --json` ({ text }) into a compact excerpt of the last
// informative screen lines, stripped of ANSI escapes, nerd-font PUA icons,
// box borders, spinners, timestamps and consecutive duplicates.
export function extractScreenExcerpt(result, maxChars = 480) {
  if (!result || maxChars <= 0) return "";
  let text = "";
  if (typeof result.text === "string") {
    text = result.text;
  } else if (result.code === 0 && typeof result.stdout === "string") {
    const out = parseObject(result.stdout);
    if (typeof out?.text === "string") text = out.text;
  }
  if (!text) return "";

  const stripped = text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_ESC, "");
  const lines = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine
      .replace(INVISIBLE, "")
      .replace(PUA, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(BOX_EDGE, "")
      .trim();
    if (!line || !/[\p{L}\p{N}]/u.test(line) || TIMESTAMP_ONLY.test(line)) continue;
    if (lines.length && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  if (!lines.length) return "";

  const kept = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const sep = kept.length ? 3 : 0;
    if (len + sep + line.length <= maxChars) {
      kept.push(line);
      len += sep + line.length;
    } else if (!kept.length) {
      kept.push(cut(line, maxChars).trim());
      break;
    } else {
      break;
    }
  }
  return kept.reverse().join(" | ");
}

// A trailing " · stale" is the cleanup mark, never part of a name.
function unmark(s) {
  while (s.endsWith(STALE_SUFFIX)) s = s.slice(0, -STALE_SUFFIX.length).replace(EDGE, "");
  return s;
}

export function sanitize(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  s = unmark(s.replace(INVISIBLE, "").replace(/\s+/g, " ").replace(EDGE, ""));
  if (s.length > MAX_NAME) {
    const head = s.slice(0, MAX_NAME + 1);
    const at = head.lastIndexOf(" ");
    s = unmark((at > 0 ? head.slice(0, at) : cut(s, MAX_NAME)).replace(EDGE, ""));
  }
  return s;
}

// A model reply that explains itself, runs long or carries markup is not a
// name; the chain moves on instead of cutting it down to a fragment.
export function cleanReply(raw) {
  if (typeof raw !== "string") return "";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0]?.trim() ?? "";
  // A heading, markup, or a "name:" / "title:" label is a reply about the name, not a name.
  if (lines.length !== 1 || first.length > MAX_REPLY_LINE || /[<*]/.test(raw) || /^#+\s/.test(first) || /\b(?:name|title)\s*:/i.test(first)) return "";
  return sanitize(raw);
}

// Pane text is untrusted. "@" becomes a fullwidth lookalike because the claude
// and agy CLIs turn "@path" in a prompt into a file attachment.
function flat(v, max = FIELD_MAX) {
  return cut(String(v).replace(/\s+/g, " ").trim(), max).replaceAll("@", "＠");
}

// info: { space, typed, panes: [{ program, shell, status, session, step, screen, folder, folderName, branch, title }] }
export function buildPrompt(info) {
  const lines = [`Space: ${flat(info.space)}`];
  if (info.typed) lines.push(`Typed name: ${flat(info.typed)}`);
  info.panes.forEach((p, i) => {
    const parts = [p.shell ? "shell" : flat(p.program)];
    if (p.status) parts.push(flat(p.status));
    if (p.session) parts.push(`session "${flat(p.session)}"`);
    else if (p.title) parts.push(`title "${flat(p.title)}"`);
    if (p.step) parts.push(`step "${flat(p.step)}"`);
    if (p.screen) parts.push(`screen "${flat(p.screen, 480)}"`);
    if (p.folder) parts.push(`folder ${flat(p.folder)}`);
    if (p.branch) parts.push(`branch ${flat(p.branch)}`);
    lines.push(`Pane ${i + 1}: ${parts.join(", ")}`);
  });
  return lines.join("\n");
}

// Last resort: what the panes already say about themselves.
export function ruleName(info) {
  const names = info.panes.map((p) => p.session || (p.shell ? null : p.program)).filter(Boolean);
  const joined = sanitize([...new Set(names)].join(" · "));
  return joined || sanitize(info.panes.find((p) => p.folderName)?.folderName ?? "");
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Only a reply that is JSON as a whole, or whose last `{` line is: nothing that
// could be quoted out of prompt or model text.
function strictJsonObject(stdout) {
  const text = stdout.trim();
  return parseObject(text) ?? parseObject(text.split("\n").reverse().find((l) => l.trim().startsWith("{")) ?? "");
}

// The JSON object a CLI printed, tolerating text around it; null when there is none.
function lastJsonObject(stdout) {
  const text = stdout.trim();
  return strictJsonObject(text) ?? parseObject(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

export function parseAgy(stdout) {
  const out = lastJsonObject(stdout);
  return out?.status === "SUCCESS" ? cleanReply(out.response) : "";
}

export function parseOpencode(stdout) {
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === "text" && typeof ev.part?.text === "string") text = ev.part.text;
  }
  return cleanReply(text);
}

export function parseClaude(stdout) {
  const out = lastJsonObject(stdout);
  return out && !out.is_error ? cleanReply(out.result) : "";
}

// Did a person type this tab's name? `seen` is the name the mod saw on the
// previous render (undefined at first sight). A name that is neither ours nor
// in flight counts when it changed live (restart: the person's name stands for
// the rename window, whatever it is, even an earlier hint typed again), or when
// it is new at load and differs from what we last set. A name first seen at
// load and never owned is only stored as a hint (restart false).
export function typedName(tab, { owned, pending, typed, seen }) {
  if (!tab.named || tab.name === owned || tab.name === pending) return null;
  if (seen !== undefined && seen !== tab.name) return { restart: true };
  if (tab.name === typed) return null;
  return { restart: owned != null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// agy keeps every call as a conversation; these are the paths keyed by its id,
// the dir under brain/ and annotations/<id>.pbtxt included, which hold the full
// prompt. agy's conversation_summaries.db keeps a row per call whose preview is
// the prompt's first line (the space name); it is left alone on purpose. The id
// feeds `rm -rf`, so it comes from a strict parse only.
export function agyConversationPaths(home, stdout) {
  const id = strictJsonObject(stdout)?.conversation_id;
  if (typeof id !== "string" || !UUID.test(id)) return [];
  const base = `${home}/.gemini/antigravity-cli`;
  return [
    ...[".db", ".db-wal", ".db-shm"].map((e) => `${base}/conversations/${id}${e}`),
    `${base}/presence/${id}.lock`,
    `${base}/brain/${id}`,
    `${base}/annotations/${id}.pbtxt`,
  ];
}

export function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? md.slice(m[0].length) : md).trim();
}

// The reply was unusable, as opposed to the namer failing to run.
class NoName extends Error {}

export function createNamer(env) {
  const failedUntil = new Map(); // namer or model id -> ms until it is tried again
  let rules = null;
  const dir = () => `${env.appHome()}/mods/agent-names/namer`;

  // after(result) runs on every finished process, ahead of the checks; it must not throw.
  async function run(command, args, timeout, parse, { after, on } = {}) {
    const r = await env.exec(command, args, on ? { on, timeout } : { cwd: dir(), timeout });
    await after?.(r);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    const name = parse(r.stdout);
    if (!name) throw new NoName("no name");
    return name;
  }

  async function forgetConversation(r) {
    const paths = agyConversationPaths(env.home(), r.stdout);
    if (!paths.length) {
      if (r.code === 0) env.log?.("agy conversation id not found; files kept");
      return;
    }
    try {
      await env.exec("rm", ["-rf", "--", ...paths], { timeout: 5000 });
    } catch (e) {
      env.log?.(`agy conversation not deleted: ${e?.message ?? e}`);
    }
  }

  // agy reports its own failures (auth, quota) as a status in JSON with exit 0.
  function parseAgyOrFail(stdout) {
    const name = parseAgy(stdout);
    if (!name && lastJsonObject(stdout)?.status !== "SUCCESS") throw new Error("agy status not SUCCESS");
    return name;
  }

  const agy = (prompt) =>
    run(
      "agy",
      ["--agent", "tab-namer", "--model", AGY_MODEL, "--disable-slash-commands", "--print-timeout", "40s",
        "--output-format", "json", "-p", prompt],
      45000,
      parseAgyOrFail,
      { after: forgetConversation },
    );

  const cooling = (id) => (failedUntil.get(id) ?? 0) > env.now();
  const cool = (id) => failedUntil.set(id, env.now() + MODEL_FAILED_MS);

  async function freeModels() {
    const text = await env.readTextFile(`${env.home()}/.local/state/hierarchical-implementation/free-models.json`);
    const models = JSON.parse(text ?? "{}").models ?? {};
    const nowSec = env.now() / 1000;
    return Object.entries(models)
      .filter(([id, m]) => (m?.cooldown_until ?? 0) <= nowSec && !cooling(id))
      .sort(([, a], [, b]) => (b?.last_ok ?? 0) - (a?.last_ok ?? 0))
      .map(([id]) => id)
      .slice(0, FREE_MODELS_TRIED);
  }

  async function opencode(prompt) {
    for (const model of await freeModels()) {
      try {
        return await run("env", [...OPENCODE_ENV(dir()), "opencode", "run", "--standalone", "--agent", "tab-namer",
          "--title", "tab-namer", "-m", model, "--format", "json", prompt], 40000, parseOpencode);
      } catch (e) {
        if (!(e instanceof NoName)) cool(model);
      }
    }
    throw new Error("no free model answered");
  }

  async function claude(prompt, on) {
    rules ??= stripFrontmatter((await env.readTextFile(`${dir()}/.agents/agents/tab-namer.md`)) ?? "");
    if (!rules) throw new Error("no rules");
    return run(
      "claude",
      ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-chrome", "--no-session-persistence",
        "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
        "--model", "haiku", "--output-format", "json",
        "--system-prompt", rules, prompt],
      45000,
      parseClaude,
      { on },
    );
  }

  const chain = [["agy", agy], ["opencode", opencode], ["claude", claude]];

  // fallback: the rule namer's result, computed by the caller from the same info.
  return async function inferName(prompt, fallback, { on } = {}) {
    for (const [by, namer] of chain) {
      if (cooling(by)) continue;
      try {
        return { name: await namer(prompt), by };
      } catch (e) {
        // A rejected reply may be a one-off; only a namer that fails to run is benched.
        // opencode cools per model (again only for a failed run), so the rest stay available.
        if (!(e instanceof NoName) && by !== "opencode") cool(by);
      }
    }
    if (on) {
      const by = `${on}:claude`;
      if (!cooling(by)) {
        try {
          return { name: await claude(prompt, on), by };
        } catch (e) {
          if (!(e instanceof NoName)) cool(by);
        }
      }
    }
    return { name: fallback, by: "rule" };
  };
}
