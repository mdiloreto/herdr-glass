// Resolves Markdown files mentioned in the focused terminal: merges the OpenCode v2 sidecar
// (which preserves [label](path.md) links hidden by the TUI renderer) with paths scraped from
// `hc read`, and verifies them on the target machine in a single POSIX shell call.
import { exec, hc, panes, focused, spaces, window } from "herdr";

const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const MD_EXT = /\.(?:md|mdx|markdown)$/i;
const BARE_MD_EXT = /(?:^|[\\/])\.(?:md|mdx|markdown)$/i;
const VALID_TID = /^[a-zA-Z0-9_-]+$/;
const MAX_CANDIDATES = 60;
const MD_TOKEN = /(?:https?:\/\/|file:\/\/)?@?[^\s"'`<>()[\]{},;:*?|\u2500-\u259f]+?\.(?:md|mdx|markdown)(?![A-Za-z0-9_-])(?:[?#][^\s"'`<>()[\]{},;\u2500-\u259f]*)?/gi;

const READ_SIDECAR =
  'd="$HOME/.local/state/herdr-md-links"; ' +
  'for f in "terminal-$1.json" "dir-$2.json" "dir-$3.json"; do ' +
  'case "$f" in *_.json) continue ;; esac; ' +
  '[ -f "$d/$f" ] && cat "$d/$f" && exit 0; ' +
  "done; exit 0";

const VERIFY_SCRIPT = [
  'c="$1"; r="$2"; shift 2',
  "i=0",
  "canon() {",
  '  d=$(dirname -- "$1")',
  '  b=$(basename -- "$1")',
  '  p=$(cd -- "$d" 2>/dev/null && pwd -P) || return 1',
  '  case "$p" in /) printf "/%s" "$b" ;; *) printf "%s/%s" "$p" "$b" ;; esac',
  "}",
  'for raw in "$@"; do',
  '  p="$raw"',
  '  case "$p" in "~/"*) p="$HOME${p#?}" ;; esac',
  '  hit=""',
  '  case "$p" in',
  '    /*) [ -f "$p" ] && hit="$p" ;;',
  "    *)",
  '      if [ -n "$c" ] && [ -f "$c/$p" ]; then hit="$c/$p"',
  '      elif [ -n "$r" ] && [ -f "$r/$p" ]; then hit="$r/$p"',
  "      fi",
  "      ;;",
  "  esac",
  '  if [ -n "$hit" ]; then',
  '    abs=$(canon "$hit") && printf "%d\\t%s\\n" "$i" "$abs"',
  "  fi",
  "  i=$((i + 1))",
  "done",
].join("\n");

/** Deterministic 32-bit FNV-1a hex hash (8 lowercase hex chars) of a normalized directory path. */
export function fnv1aHex(input) {
  const normalized = String(input ?? "").replace(/[\\/]+$/, "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cleanMention(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^[\s"'`<>()[\]{}\u2500-\u259f]+|[\s"'`<>()[\]{},;:.!?\u2500-\u259f]+$/g, "");
  if (!s || /^https?:\/\//i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, "");
    if (s.startsWith("localhost/")) s = s.slice("localhost".length);
    try { s = decodeURIComponent(s); } catch {}
  }
  if (s.startsWith("@")) s = s.slice(1);
  s = s.replace(/[?#].*$/, "").trim();
  s = s.replace(/[,;:.!?]+$/, "");
  if (!s || !MD_EXT.test(s) || BARE_MD_EXT.test(s)) return null;
  return s;
}

const stripEdge = (line) => line.replace(/^[\s\u2500-\u259f]+|[\s\u2500-\u259f]+$/g, "");
const stripWrapEdge = (tok) => tok.replace(/^[\s"'`<>()[\]{}\u2500-\u259f]+|[\s"'`<>()[\]{}\u2500-\u259f]+$/g, "");

function lastWord(line) {
  const trimmed = stripEdge(line);
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  return stripWrapEdge(parts[parts.length - 1] ?? "");
}

function firstWord(line) {
  const trimmed = stripEdge(line);
  if (!trimmed) return "";
  return stripWrapEdge(trimmed.split(/\s+/)[0] ?? "");
}

function looksLikeWrapPrefix(prev, next) {
  if (!prev || !next) return false;
  if (/[.,:;!?]$/.test(prev)) return false;
  if (MD_EXT.test(prev.replace(/[?#].*$/, ""))) return false;
  if (/^(?:~\/|\.\.?\/|@|file:\/\/|https?:\/\/)/i.test(next)) return false;
  return /[\\/~]|^@|^file:\/\/|^https?:\/\/|[-_]$/.test(prev);
}

/** Extracts Markdown file paths from terminal text, newest (lowest) line first, deduplicated. */
export function extractMentions(text) {
  if (!text) return [];
  const cleaned = String(text).replace(ANSI, "");
  const lines = cleaned.split(/\r?\n/);
  const seen = new Set();
  const out = [];

  const add = (p) => {
    if (!p) return;
    const key = p.replace(/^\.\//, "").replace(/\/+/g, "/");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  for (let i = lines.length - 1; i >= 0; i--) {
    let skipFirstToken = null;

    if (i > 0) {
      const prev = lastWord(lines[i - 1]);
      const next = firstWord(lines[i]);
      if (looksLikeWrapPrefix(prev, next)) {
        const joined = prev + next;
        if (/^https?:\/\//i.test(joined)) {
          skipFirstToken = cleanMention(next);
        } else {
          for (const m of joined.matchAll(MD_TOKEN)) {
            const path = cleanMention(m[0]);
            if (path) {
              add(path);
              skipFirstToken = cleanMention(next);
            }
          }
        }
      }
    }

    const lineMatches = [...lines[i].matchAll(MD_TOKEN)].reverse();
    for (const m of lineMatches) {
      const path = cleanMention(m[0]);
      if (!path) continue;
      if (skipFirstToken && path === skipFirstToken) {
        skipFirstToken = null;
        continue;
      }
      add(path);
    }
  }

  return out;
}

/** Finds the focused pane's terminal, or the active tab's first terminal. */
export function focusedTerminal() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const tab = f?.tab ?? pane?.tab ?? null;
  let termPane = pane?.terminal ? pane : null;
  if (!termPane && tab != null) {
    termPane = all.find((p) => p.tab === tab && p.terminal) ?? null;
  }
  const terminal = termPane?.terminal ?? (f?.terminal || null);
  const cwd = termPane?.cwd || pane?.cwd || f?.cwd || space?.folder || null;
  const on = terminal?.includes("/")
    ? terminal.split("/")[0]
    : (f?.pane === null ? null : (space?.machine ?? null));
  const tid = terminal ? (terminal.includes("/") ? terminal.split("/").pop() : terminal) : null;
  return { terminal, tid, cwd, on, tab };
}

export function relativePath(file, root, cwd) {
  const cleanRoot = root ? root.replace(/[\\/]+$/, "") : "";
  if (cleanRoot && file.startsWith(`${cleanRoot}/`)) return file.slice(cleanRoot.length + 1);
  const cleanCwd = cwd ? cwd.replace(/[\\/]+$/, "") : "";
  if (cleanCwd && file.startsWith(`${cleanCwd}/`)) return file.slice(cleanCwd.length + 1);
  return file;
}

function parseSidecar(stdout, fallbackCwd) {
  if (!stdout || !stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || !Array.isArray(parsed.links)) return [];
    const base = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : (fallbackCwd || "");
    const out = [];
    for (const item of parsed.links) {
      if (!item || typeof item.path !== "string") continue;
      const p = item.path.trim();
      if (!p) continue;
      const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : null;
      out.push({ label, path: p, base });
    }
    return out;
  } catch {
    return [];
  }
}

/** Merges OpenCode sidecar links and `hc read` mentions, verifying files on the target host. */
export async function terminalMentions({ terminal, cwd, root, on } = {}) {
  try {
    if (!terminal && !cwd) return [];
    if (!on && window().platform === "windows") return [];

    const rawTid = terminal ? (terminal.includes("/") ? terminal.split("/").pop() : terminal) : "";
    const safeTid = VALID_TID.test(rawTid) ? rawTid : "";
    const dirKeyCwd = cwd ? fnv1aHex(cwd) : "";
    const dirKeyRoot = root && root !== cwd ? fnv1aHex(root) : "";

    const readTask = terminal
      ? Promise.resolve(hc(["read", "--lines", "120", terminal]))
          .then((r) => (r?.code === 0 && r.stdout ? extractMentions(r.stdout) : []))
          .catch(() => [])
      : Promise.resolve([]);

    const sidecarTask = (safeTid || dirKeyCwd || dirKeyRoot)
      ? Promise.resolve(exec("sh", ["-c", READ_SIDECAR, "sh", safeTid || "_", dirKeyCwd || "_", dirKeyRoot || "_"], { on }))
          .then((r) => (r?.code === 0 && r.stdout ? parseSidecar(r.stdout, cwd) : []))
          .catch(() => [])
      : Promise.resolve([]);

    const [screenPaths, sidecarLinks] = await Promise.all([readTask, sidecarTask]);

    // Combine sidecar links first (preserving label), then screen mentions, deduplicated by raw path.
    const candidates = [];
    const seenRaw = new Map();
    const pushCandidate = (rawPath, label, base) => {
      let resolved = rawPath;
      if (
        base &&
        base !== cwd &&
        base !== root &&
        !rawPath.startsWith("/") &&
        !rawPath.startsWith("~/")
      ) {
        resolved = `${base.replace(/[\\/]+$/, "")}/${rawPath}`;
      }
      const key = resolved.replace(/^\.\//, "").replace(/\/+/g, "/");
      const existing = seenRaw.get(key);
      if (existing) {
        if (existing.label === null && label !== null) existing.label = label;
        return;
      }
      const entry = { path: resolved, label: label ?? null };
      seenRaw.set(key, entry);
      candidates.push(entry);
    };

    for (const item of sidecarLinks) pushCandidate(item.path, item.label, item.base);
    for (const p of screenPaths) pushCandidate(p, null, null);

    const capped = candidates.slice(0, MAX_CANDIDATES);
    if (!capped.length) return [];

    const verify = await exec(
      "sh",
      ["-c", VERIFY_SCRIPT, "sh", cwd || "/", root || cwd || "/", ...capped.map((c) => c.path)],
      { on },
    ).catch(() => null);

    if (!verify || verify.code !== 0 || !verify.stdout) return [];

    const byFile = new Map();
    const result = [];
    for (const line of verify.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const idx = Number(line.slice(0, tab));
      const file = line.slice(tab + 1);
      if (!Number.isInteger(idx) || idx < 0 || idx >= capped.length || !file) continue;
      const cand = capped[idx];
      const existing = byFile.get(file);
      if (existing) {
        if (existing.label === null && cand.label !== null) existing.label = cand.label;
        continue;
      }
      const item = {
        file,
        label: cand.label ?? null,
        rel: relativePath(file, root, cwd),
        on: on ?? null,
      };
      byFile.set(file, item);
      result.push(item);
    }

    return result;
  } catch {
    return [];
  }
}
