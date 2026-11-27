// Core daemon engine for quota-resume.
// Pure dependency-injected ESM — runs under both Herdr (gpui-shell) and Node.js tests.

import {
  CLAIM_TTL_MS,
  COMMAND_KEY,
  DEFAULT_PROMPT,
  MAX_CANCEL_EPOCHS,
  MAX_CLAIMS,
  MAX_EPISODE_ATTEMPTS_KEYS,
  MAX_HANDLED_BANNERS,
  MAX_HANDLED_FINGERPRINTS,
  MAX_PROMOTED_EPISODES,
  MAX_TERMINAL_COOLDOWNS,
  STATE_KEY,
  SUPPORTED_AGENTS,
  USAGE_LIMITS_STATE_KEY,
  appendHistory,
  isEntryExpired,
  isUuid,
  machineOf,
  normalizeState,
  parseCommand,
} from "./protocol.mjs";
import {
  detectScreenRateLimit,
  extractScreenText,
  hasUnsentDraft,
  parseResetTime,
} from "./screen.mjs";
import {
  buildTranscriptExecArgs,
  findActiveQuotaError,
  hasAssistantReplyAfterTime,
  parseTranscriptTail,
  toEpochMs,
  verifyActiveTranscriptError,
} from "./transcript.mjs";

export const DEFAULT_TICK_MS = 15_000;
export const STAGGER_MS = 2_000;
export const TRANSCRIPT_TIMEOUT_MS = 8_000;
export const HC_TIMEOUT_MS = 10_000;
export const HC_SEND_TIMEOUT_MS = 75_000;
export const SCREEN_READ_LINES = "0";
export const MAX_COMPLETED_FINGERPRINTS = MAX_HANDLED_FINGERPRINTS;
export const TERMINAL_COOLDOWN_MS = 10 * 60 * 1000;
export const SAME_BANNER_SUPPRESS_MS = TERMINAL_COOLDOWN_MS;
export const MAX_EPISODE_ATTEMPTS = 1;
export const MAX_GET_FAILURES = 12;
export const MAX_IO_FAILURES = 12;
export const RETRY_BACKOFF_MS = 30_000;
export const MAX_GLOBAL_IN_FLIGHT = 32;
const HUNG_OP_EVICT_MULTIPLIER = 2;
const HUNG_OP_EVICT_SKIPPED_TICKS = 3;

const IDLE_STATES = new Set(["idle", "done", "error"]);
const SHELL_RE = /^-?(?:zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|nushell|pwsh|powershell|cmd)(?:\.exe)?$/i;
const RUNTIME_WRAPPERS = new Set(["node", "bun", "deno", "env", "mise", "npx"]);
const JS_RUNTIMES = new Set(["node", "bun", "deno"]);
const JS_RUNTIME_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--max-old-space-size",
  "-c",
  "--config",
  "--preload",
  "--cwd",
  "--inspect",
  "--inspect-brk",
  "--title",
  "--redirect-warnings",
  "--diagnostic-dir",
  "--heapsnapshot-signal",
  "--input-type",
  "--icu-data-dir",
  "--v8-pool-size",
  "--stack-size",
  "--watch-path",
]);
const SYNC_COMMAND_ACTIONS = new Set([
  "cancel",
  "toggle-enabled",
  "toggle-agent",
  "clear-history",
]);

const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const GLOBAL_CLAIMS_SYM = Symbol.for("herdr.quota-resume.claims");
let instanceSeq = 0;

function getStoreClaimsMap(sharedFn) {
  let registry = globalThis[GLOBAL_CLAIMS_SYM];
  if (!(registry instanceof WeakMap)) {
    registry = new WeakMap();
    globalThis[GLOBAL_CLAIMS_SYM] = registry;
  }
  if (typeof sharedFn !== "function") return null;
  let map = registry.get(sharedFn);
  if (!map) {
    map = new Map();
    registry.set(sharedFn, map);
  }
  return map;
}

export function isSyncCommand(cmd) {
  return Boolean(cmd && typeof cmd === "object" && SYNC_COMMAND_ACTIONS.has(cmd.action));
}

function basenameLowerNoExe(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const base = trimmed.replace(/\\/g, "/").split("/").pop();
  return base ? base.toLowerCase().replace(/\.exe$/, "") : "";
}

export function isShellName(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  const base = name.trim().replace(/\\/g, "/").split("/").pop();
  return SHELL_RE.test(base);
}

function mapTokenToAgent(raw) {
  const base = basenameLowerNoExe(raw);
  if (!base) return null;
  if (base === "claude-code" || base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "opencode") return "opencode";
  return null;
}

function stripPackageVersion(token) {
  const s = token.trim();
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash === -1) return s;
    const atVer = s.indexOf("@", slash + 1);
    return atVer === -1 ? s : s.slice(0, atVer);
  }
  const atVer = s.indexOf("@");
  return atVer === -1 ? s : s.slice(0, atVer);
}

const AGENT_ENTRY_BASENAMES = new Set([
  "cli.js",
  "cli.mjs",
  "cli.cjs",
  "index.js",
  "index.mjs",
  "index.cjs",
  "bin.js",
  "bin.mjs",
  "bin.cjs",
  "main.js",
  "main.mjs",
  "main.cjs",
  "claude.js",
  "claude.mjs",
  "claude.cjs",
  "codex.js",
  "codex.mjs",
  "codex.cjs",
  "opencode.js",
  "opencode.mjs",
  "opencode.cjs",
]);

function mapScriptTokenToAgent(raw, { allowPackageSpec = false } = {}) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const candidate = allowPackageSpec ? stripPackageVersion(trimmed) : trimmed;
  const direct = mapTokenToAgent(candidate);
  if (direct) return direct;
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (allowPackageSpec) {
    if (/^@anthropic-ai\/claude-code$/.test(normalized)) return "claude";
    if (/^@openai\/codex$/.test(normalized)) return "codex";
    if (/^(?:@opencode\/cli|opencode-ai|opencode)$/.test(normalized)) return "opencode";
  }
  if (/(?:^|\/)node_modules\/@anthropic-ai\/claude-code\//.test(normalized)) return "claude";
  if (/(?:^|\/)node_modules\/@openai\/codex\//.test(normalized)) return "codex";
  if (/(?:^|\/)node_modules\/(?:@opencode\/cli|opencode-ai)\//.test(normalized)) return "opencode";
  const base = normalized.split("/").pop() || "";
  if (AGENT_ENTRY_BASENAMES.has(base)) {
    if (/(?:^|\/)(?:@anthropic-ai\/)?claude-code\//.test(normalized)) return "claude";
    if (/(?:^|\/)(?:@openai\/)?codex\//.test(normalized)) return "codex";
    if (/(?:^|\/)(?:@opencode\/cli|opencode-ai|opencode)\//.test(normalized)) return "opencode";
  }
  return null;
}

function identifyCommandArgv(argv, startIndex = 0, depth = 0) {
  if (depth > 4 || !Array.isArray(argv) || startIndex >= argv.length) return null;
  const firstRaw = typeof argv[startIndex] === "string" ? argv[startIndex].trim() : "";
  if (!firstRaw || isShellName(firstRaw)) return null;

  const direct = mapTokenToAgent(firstRaw);
  if (direct) return direct;

  const base = basenameLowerNoExe(firstRaw);
  if (!RUNTIME_WRAPPERS.has(base)) return null;

  // 1. node / bun / deno: skip leading runtime flags, reject eval/print (including attached -e/-p), inspect ONLY first positional script.
  if (JS_RUNTIMES.has(base)) {
    let i = startIndex + 1;
    let sawRunSubcmd = false;
    while (i < argv.length) {
      const tok = typeof argv[i] === "string" ? argv[i].trim() : "";
      if (!tok) return null;
      if (tok === "--") {
        i += 1;
        break;
      }
      if (tok.startsWith("-")) {
        if (
          /^-(?:e|p)/.test(tok) ||
          tok === "--eval" ||
          tok === "--print" ||
          tok.startsWith("--eval=") ||
          tok.startsWith("--print=")
        ) {
          return null;
        }
        if (!tok.includes("=") && JS_RUNTIME_VALUE_FLAGS.has(tok)) {
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if ((base === "bun" || base === "deno") && !sawRunSubcmd) {
        if (tok === "eval") return null;
        if (tok === "run") {
          sawRunSubcmd = true;
          i += 1;
          continue;
        }
      }
      return mapScriptTokenToAgent(tok);
    }
    if (i < argv.length) {
      return mapScriptTokenToAgent(argv[i]);
    }
    return null;
  }

  // 2. env: skip flags (-i, -0, -S, -u <name>, -C <dir>) and KEY=VALUE assignments, then recurse.
  if (base === "env") {
    let i = startIndex + 1;
    while (i < argv.length) {
      const tok = typeof argv[i] === "string" ? argv[i].trim() : "";
      if (!tok) return null;
      if (tok === "--") {
        i += 1;
        break;
      }
      if (tok === "-u" || tok === "--unset" || tok === "-C" || tok === "--chdir") {
        i += 2;
        continue;
      }
      if (
        tok === "-i" ||
        tok === "-0" ||
        tok === "-S" ||
        tok === "--ignore-environment" ||
        tok === "--null" ||
        tok.startsWith("--unset=") ||
        tok.startsWith("--chdir=")
      ) {
        i += 1;
        continue;
      }
      if (tok.startsWith("-")) return null;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        i += 1;
        continue;
      }
      return identifyCommandArgv(argv, i, depth + 1);
    }
    if (i < argv.length) {
      return identifyCommandArgv(argv, i, depth + 1);
    }
    return null;
  }

  // 3. npx: skip flags (-y, --yes, -q, --quiet, -p <pkg>, --package <pkg>), reject -c/--call, inspect ONLY command/package token.
  if (base === "npx") {
    let i = startIndex + 1;
    while (i < argv.length) {
      const tok = typeof argv[i] === "string" ? argv[i].trim() : "";
      if (!tok) return null;
      if (tok === "--") {
        i += 1;
        break;
      }
      if (tok === "-c" || tok === "--call" || tok.startsWith("--call=")) {
        return null;
      }
      if (tok === "-p" || tok === "--package") {
        i += 2;
        continue;
      }
      if (
        tok === "-y" ||
        tok === "--yes" ||
        tok === "-q" ||
        tok === "--quiet" ||
        tok === "--no" ||
        tok === "--no-install" ||
        tok === "--prefer-offline" ||
        tok === "--prefer-online" ||
        tok.startsWith("--package=")
      ) {
        i += 1;
        continue;
      }
      if (tok.startsWith("-")) return null;
      return mapScriptTokenToAgent(tok, { allowPackageSpec: true });
    }
    if (i < argv.length) {
      return mapScriptTokenToAgent(argv[i], { allowPackageSpec: true });
    }
    return null;
  }

  // 4. mise: allow ONLY `mise exec ... -- <cmd>` / `mise x ... -- <cmd>`, recursively inspecting `<cmd>`.
  if (base === "mise") {
    const sub = typeof argv[startIndex + 1] === "string" ? argv[startIndex + 1].trim() : "";
    if (sub !== "exec" && sub !== "x") return null;
    const dashDash = argv.indexOf("--", startIndex + 2);
    if (dashDash === -1 || dashDash + 1 >= argv.length) return null;
    return identifyCommandArgv(argv, dashDash + 1, depth + 1);
  }

  return null;
}

/**
 * Positively identifies a supported coding agent from the foreground process ONLY
 * (`foreground.name` and `foreground.argv`), allowing known JS/env/mise/npx wrappers
 * ONLY when the executable/script position explicitly names the agent binary/package.
 * Never scans arbitrary trailing data arguments and never falls back to outer shell metadata.
 */
export function identifyForegroundAgent(foreground) {
  if (!foreground || typeof foreground !== "object") return null;
  const name = typeof foreground.name === "string" ? foreground.name.trim() : "";
  if (name) {
    if (isShellName(name)) return null;
    const direct = mapTokenToAgent(name);
    if (direct) return direct;
    const base = basenameLowerNoExe(name);
    if (!RUNTIME_WRAPPERS.has(base)) return null;
    if (!Array.isArray(foreground.argv) || foreground.argv.length === 0) return null;
    const argv0Base = basenameLowerNoExe(foreground.argv[0]);
    if (argv0Base === base) {
      return identifyCommandArgv(foreground.argv, 0, 0);
    }
    return identifyCommandArgv([name, ...foreground.argv], 0, 0);
  }

  if (Array.isArray(foreground.argv) && foreground.argv.length > 0) {
    return identifyCommandArgv(foreground.argv, 0, 0);
  }

  return null;
}

export function identifyAgent(terminal) {
  if (!terminal || typeof terminal !== "object") return null;

  // Whenever foreground metadata is present, require a positive foreground match.
  if (terminal.foreground !== undefined) {
    return identifyForegroundAgent(terminal.foreground);
  }

  const candidates = [
    terminal.report?.app,
    typeof terminal.status === "object" ? terminal.status?.app : null,
    terminal.program?.key,
  ];
  for (const c of candidates) {
    const mapped = mapTokenToAgent(c);
    if (mapped) return mapped;
  }

  return null;
}

export function terminalStatusWord(terminal) {
  if (!terminal || typeof terminal !== "object") return null;
  if (typeof terminal.status === "string" && terminal.status) return terminal.status;
  if (terminal.status && typeof terminal.status === "object" && typeof terminal.status.state === "string") {
    return terminal.status.state;
  }
  if (typeof terminal.report?.state === "string" && terminal.report.state) return terminal.report.state;
  return null;
}

export function isCandidateTerminal(terminal) {
  if (!terminal || terminal.state !== "live") return false;
  if (!terminal.program?.agent || terminal.program?.shell) return false;
  const status = terminalStatusWord(terminal);
  if (!IDLE_STATES.has(status)) return false;
  if (terminal.foreground !== undefined && identifyForegroundAgent(terminal.foreground) === null) {
    return false;
  }
  return identifyAgent(terminal) !== null;
}

export function inspectionSignature(terminal) {
  const turn = terminal?.turn ?? "";
  const statusMs = terminal?.status_ms ?? terminal?.report?.at ?? "";
  const state = terminal?.state ?? "";
  const statusWord = terminalStatusWord(terminal) ?? "";
  const sessionId = terminal?.labels?.["claude.session"] ?? "";
  return `${turn}|${statusMs}|${state}|${statusWord}|${sessionId}`;
}

export function inferProvider(agent, bannerText = "") {
  if (agent === "opencode") {
    if (/anthropic|claude/i.test(bannerText)) return "claude";
    if (/openai|codex|chatgpt/i.test(bannerText)) return "codex";
  }
  return agent;
}

function getProviderReport(usageState, provider) {
  if (!usageState || typeof usageState !== "object") return null;
  const entry = usageState[provider];
  if (!entry || typeof entry !== "object") return null;
  const report =
    entry.report?.status === "ok"
      ? entry.report
      : entry.lastGood?.status === "ok"
        ? entry.lastGood
        : null;
  if (!report || !Array.isArray(report.windows) || report.windows.length === 0) return null;
  const observedAtMs = toEpochMs(report.observedAt);
  if (observedAtMs == null) return null;
  return { report, observedAtMs };
}

function matchesEntryReset(w, entryResetsAtMs) {
  return (
    w.resetsAtMs != null &&
    Number.isFinite(entryResetsAtMs) &&
    Math.abs(w.resetsAtMs - entryResetsAtMs) <= 120_000
  );
}

function selectConstrainedWindows(windows, reason, entryResetsAtMs) {
  const r = String(reason ?? "").toLowerCase();
  if (/five[_ -]?hour|5h\b|session/.test(r)) {
    const matched = windows.filter((w) => /session|5h|5-hour|primary/i.test(`${w.id} ${w.short} ${w.long}`));
    if (matched.length) return matched;
  }
  if (/seven[_ -]?day|weekly|7d\b/.test(r)) {
    const matched = windows.filter((w) => /week|wk|7d|secondary/i.test(`${w.id} ${w.short} ${w.long}`));
    if (matched.length) return matched;
  }
  if (Number.isFinite(entryResetsAtMs)) {
    const byReset = windows.filter((w) => matchesEntryReset(w, entryResetsAtMs));
    if (byReset.length) return byReset;
  }
  return [];
}

function buildEpisodeKey(entry) {
  if (Number.isFinite(entry.resetsAtMs)) {
    return `${entry.address}:${entry.agent}:${Math.floor(entry.resetsAtMs / 60_000)}`;
  }
  return `${entry.address}:${entry.agent}:${entry.errorFingerprint}`;
}

function promotionEpisodeKey(entry) {
  return `${entry.address}:${Math.floor(entry.resetsAtMs / 60_000)}`;
}

function isScreenFingerprint(fp) {
  return typeof fp === "string" && (fp.startsWith("screen:") || fp.startsWith("report:"));
}

function usageExhaustedSignature(usageState, nowMs) {
  if (!usageState || typeof usageState !== "object") return "";
  const parts = [];
  for (const p of SUPPORTED_AGENTS) {
    const found = getProviderReport(usageState, p);
    if (!found) continue;
    const exhaustedResets = found.report.windows
      .map((w) => ({ percent: Number(w.percent), resetsAtMs: toEpochMs(w.resetsAt) }))
      .filter((w) => Number.isFinite(w.percent) && w.percent >= 100 && w.resetsAtMs != null && w.resetsAtMs > nowMs)
      .map((w) => w.resetsAtMs)
      .sort((a, b) => a - b);
    if (exhaustedResets.length > 0) {
      parts.push(`${p}:${exhaustedResets.join(",")}`);
    }
  }
  return parts.join("|");
}

/**
 * Resolves a future reset timestamp from `shared("usage-limits.state")` when an agent
 * hits a limit without an explicit timestamp in its banner.
 * For OpenCode, ONLY checks `"claude"` or `"codex"` when `bannerText` explicitly names that provider.
 */
export function resolveQuotaResetFromUsage(usageState, provider, { bannerText = "", nowMs = Date.now() } = {}) {
  const inferred = inferProvider(provider, bannerText);
  const providersToTry = [];
  if (inferred && !providersToTry.includes(inferred)) providersToTry.push(inferred);
  if (provider !== "opencode" && !providersToTry.includes(provider)) {
    providersToTry.push(provider);
  }

  for (const p of providersToTry) {
    const found = getProviderReport(usageState, p);
    if (!found) continue;
    const exhaustedFuture = found.report.windows
      .map((w) => ({ percent: Number(w.percent), resetsAtMs: toEpochMs(w.resetsAt) }))
      .filter((w) => Number.isFinite(w.percent) && w.percent >= 100 && w.resetsAtMs != null && w.resetsAtMs > nowMs);
    if (exhaustedFuture.length > 0) {
      const latestReset = Math.max(...exhaustedFuture.map((w) => w.resetsAtMs));
      return { resetsAtMs: latestReset, provider: p };
    }
  }
  return null;
}

/**
 * Evaluates live `usage-limits.state` for a queued local entry:
 * - Defer if a fresh reading observed at/after `resetsAtMs` is STILL at >=100% with a newer future `resetsAt`.
 * - Set `sawExhausted` + `exhaustedObservedAtMs` ONLY when a window positively matching `entry.resetsAtMs`
 *   (within ±2 min) or matching the constrained window type with matching reset is observed at >=100%.
 * - Promote to ready at most once per `(address, resetsAtMs)` episode ONLY when `entry.sawExhausted === true`
 *   AND a strictly newer reading (`observedAtMs > Math.max(entry.detectedAtMs, entry.exhaustedObservedAtMs)`)
 *   has `exhausted.length === 0` AND a window matching `entry.resetsAtMs` (±2 min) dropped `< 100%`.
 */
export function evaluateQuotaForEntry(entry, usageState, nowMs, delaySec, promotedEpisodes = null) {
  if (!entry || entry.machine !== null || entry.status !== "waiting") return null;
  const found = getProviderReport(usageState, entry.provider);
  if (!found) return null;

  const { report, observedAtMs } = found;
  const windows = report.windows.map((w) => ({
    ...w,
    percentNum: Number(w.percent),
    resetsAtMs: toEpochMs(w.resetsAt),
  }));

  const exhausted = windows.filter((w) => Number.isFinite(w.percentNum) && w.percentNum >= 100);
  const constrained = selectConstrainedWindows(windows, entry.reason, entry.resetsAtMs);

  // 1. Deferral: reading observed at/after scheduled resetsAtMs still shows 100% with a newer future resetsAt.
  if (observedAtMs >= entry.resetsAtMs && exhausted.length > 0) {
    const newerResets = exhausted
      .map((w) => w.resetsAtMs)
      .filter((ms) => ms != null && ms > entry.resetsAtMs && ms > nowMs);
    if (newerResets.length > 0) {
      const nextResetsAtMs = Math.max(...newerResets);
      return {
        action: "defer",
        resetsAtMs: nextResetsAtMs,
        resumeAtMs: nextResetsAtMs + delaySec * 1000,
        observedAtMs,
      };
    }
  }

  // 2. Record `sawExhausted` ONLY when a window positively matching `entry.resetsAtMs` (within ±2 min)
  //    or matching the constrained window with matching reset is observed at >=100%.
  if (!entry.sawExhausted && exhausted.length > 0) {
    const matchedExhausted = exhausted.some(
      (w) =>
        matchesEntryReset(w, entry.resetsAtMs) ||
        (constrained.includes(w) && (w.resetsAtMs == null || matchesEntryReset(w, entry.resetsAtMs))),
    );
    if (matchedExhausted) {
      return { action: "observe-exhausted", observedAtMs };
    }
  }

  // 3. Strict early recovery: ONLY promote when `entry.sawExhausted === true`, reading is strictly newer
  //    than the exhausted observation, no windows are exhausted, AND a window whose `resetsAtMs` matches
  //    `entry.resetsAtMs` (±2 min) dropped below 100%.
  const hasExhaustedObs =
    typeof entry.exhaustedObservedAtMs === "number" && Number.isFinite(entry.exhaustedObservedAtMs);
  const minRecoveryObsMs = hasExhaustedObs
    ? Math.max(entry.detectedAtMs, entry.exhaustedObservedAtMs)
    : entry.detectedAtMs;
  if (
    entry.sawExhausted === true &&
    hasExhaustedObs &&
    observedAtMs > minRecoveryObsMs &&
    exhausted.length === 0
  ) {
    const matchingResetWindows = windows.filter((w) => matchesEntryReset(w, entry.resetsAtMs));
    if (matchingResetWindows.length > 0) {
      const promoKey = promotionEpisodeKey(entry);
      const alreadyPromoted = Array.isArray(promotedEpisodes)
        ? promotedEpisodes.includes(promoKey)
        : promotedEpisodes instanceof Set
          ? promotedEpisodes.has(promoKey)
          : false;
      if (alreadyPromoted) return null;

      const allBelow100 = matchingResetWindows.every(
        (w) => Number.isFinite(w.percentNum) && w.percentNum < 100,
      );
      if (allBelow100) {
        return { action: "promote", promoKey };
      }
    }
  }

  return null;
}

function buildTitleAndWhere(terminal, paneList, spaceList) {
  const pane = paneList.find((p) => p.terminal === terminal.address) ?? null;
  const space = pane ? spaceList.find((s) => Array.isArray(s.tabs) && s.tabs.some((tb) => tb.id === pane.tab)) ?? null : null;
  const tab = space && pane ? space.tabs.find((tb) => tb.id === pane.tab) ?? null : null;

  const title =
    terminal.labels?.["agent.title"]?.trim() ||
    terminal.labels?.["session.title"]?.trim() ||
    terminal.labels?.["claude.title"]?.trim() ||
    pane?.title?.trim() ||
    terminal.title?.trim() ||
    terminal.name?.trim() ||
    terminal.address;

  let where = null;
  if (space && tab) {
    where = tab.name && tab.name !== space.name ? `${space.name} / ${tab.name}` : space.name;
  } else if (space) {
    where = space.name;
  } else if (typeof terminal.cwd === "string" && terminal.cwd.trim()) {
    where = terminal.cwd.trim();
  }

  return { title, where };
}

function cloneHandledBanners(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    out[k] = { ...v };
  }
  return out;
}

function cloneClaims(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    out[k] = { ...v };
  }
  return out;
}

function cloneState(state) {
  return {
    version: state.version,
    enabled: state.enabled,
    updatedAtMs: state.updatedAtMs,
    lastHandledCommandId: state.lastHandledCommandId,
    settings: {
      delaySec: state.settings.delaySec,
      agents: { ...state.settings.agents },
      prompt: DEFAULT_PROMPT,
    },
    queue: state.queue.map((e) => ({ ...e })),
    history: state.history.map((h) => ({ ...h })),
    handledFingerprints: [...state.handledFingerprints],
    handledBanners: cloneHandledBanners(state.handledBanners),
    promotedEpisodes: [...state.promotedEpisodes],
    episodeAttempts: { ...state.episodeAttempts },
    terminalCooldowns: { ...state.terminalCooldowns },
    cancelEpochs: { ...state.cancelEpochs },
    cancelledSignatures: { ...state.cancelledSignatures },
    claims: cloneClaims(state.claims),
  };
}

function stateComparableKey(state) {
  return JSON.stringify({
    version: state.version,
    enabled: state.enabled,
    lastHandledCommandId: state.lastHandledCommandId,
    settings: state.settings,
    queue: state.queue.map(({ lastCheckMs: _ignored, ...rest }) => rest),
    history: state.history,
    handledFingerprints: state.handledFingerprints,
    handledBanners: state.handledBanners,
    promotedEpisodes: state.promotedEpisodes,
    episodeAttempts: state.episodeAttempts,
    terminalCooldowns: state.terminalCooldowns,
    cancelEpochs: state.cancelEpochs,
    cancelledSignatures: state.cancelledSignatures,
    claims: state.claims,
  });
}

function addBoundedList(list, item, limit) {
  if (!item) return;
  const existingIdx = list.indexOf(item);
  if (existingIdx !== -1) list.splice(existingIdx, 1);
  list.push(item);
  while (list.length > limit) {
    list.shift();
  }
}

function setBoundedMap(obj, key, value, limit) {
  if (!key) return;
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    delete obj[key];
  }
  obj[key] = value;
  const keys = Object.keys(obj);
  while (keys.length > limit) {
    const oldest = keys.shift();
    delete obj[oldest];
  }
}

export function createEngine(env) {
  const now = env.now ?? (() => Date.now());
  const defaultSleep = env.sleep ?? (() => Promise.resolve());
  const defaultAfter = typeof env.after === "function" ? env.after : null;
  const log = env.log ?? (() => {});
  const notify = env.notify ?? (() => {});
  const getPanes = env.panes ?? (() => []);
  const getSpaces = env.spaces ?? (() => []);
  const hcTimeoutMs = env.hcTimeoutMs ?? HC_TIMEOUT_MS;
  const hcSendTimeoutMs = env.hcSendTimeoutMs ?? HC_SEND_TIMEOUT_MS;
  const instanceId = `qr-${++instanceSeq}-${Math.random().toString(36).slice(2, 8)}`;
  const storeClaimsMap = getStoreClaimsMap(env.shared);

  const state = normalizeState(env.shared(STATE_KEY), now());
  const lastInspected = new Map();
  const liveSignatures = new Map();
  const pendingCancelTokens = new Map();
  const inFlightOps = new Map();
  const liveUnsettledOps = new Set();
  const activeTimeoutCancels = new Set();
  const activeWaitRejectors = new Set();
  let lastPublishedKey = null;
  let lastResumeSentAtMs = 0;
  let closed = false;

  function isClosed() {
    return closed;
  }

  function close() {
    closed = true;
    for (const cancel of [...activeTimeoutCancels]) {
      try {
        cancel();
      } catch {
        // ignore
      }
    }
    activeTimeoutCancels.clear();
    for (const rejectWait of [...activeWaitRejectors]) {
      try {
        rejectWait();
      } catch {
        // ignore
      }
    }
    activeWaitRejectors.clear();
  }

  function rememberFingerprint(fp) {
    addBoundedList(state.handledFingerprints, fp, MAX_HANDLED_FINGERPRINTS);
  }

  function hasHandledFingerprint(fp) {
    return Boolean(fp && state.handledFingerprints.includes(fp));
  }

  function rememberHandledBanner(address, { bannerKey, turn, statusMs, resetsAtMs, handledAtMs, cancelled }) {
    if (!address || !bannerKey) return;
    setBoundedMap(
      state.handledBanners,
      address,
      {
        bannerKey,
        turn: typeof turn === "number" && Number.isFinite(turn) ? turn : null,
        statusMs: typeof statusMs === "number" && Number.isFinite(statusMs) ? statusMs : null,
        resetsAtMs: typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs) ? resetsAtMs : null,
        handledAtMs,
        cancelled: Boolean(cancelled),
      },
      MAX_HANDLED_BANNERS,
    );
  }

  function isBannerSuppressed(address, detected, turn, statusMs, nowMs) {
    const handled = state.handledBanners[address];
    if (!handled) {
      // Upgrade migration: legacy screen/report fingerprints persisted in handledFingerprints
      // suppress same-turn replay and migrate into handledBanners for future turn/cooldown tracking.
      if (hasHandledFingerprint(detected.errorFingerprint)) {
        rememberHandledBanner(address, {
          bannerKey: detected.errorFingerprint,
          turn,
          statusMs,
          resetsAtMs: detected.resetsAtMs,
          handledAtMs: nowMs,
          cancelled: false,
        });
        const legacyIdx = state.handledFingerprints.indexOf(detected.errorFingerprint);
        if (legacyIdx !== -1) state.handledFingerprints.splice(legacyIdx, 1);
        return true;
      }
      return false;
    }
    if (handled.bannerKey !== detected.errorFingerprint) return false;

    const hasTurn = typeof turn === "number" && Number.isFinite(turn);
    const hasHandledTurn = typeof handled.turn === "number" && Number.isFinite(handled.turn);

    // Cancel + reload on same turn never requeues.
    if (handled.cancelled && hasTurn && hasHandledTurn && turn === handled.turn) {
      return true;
    }
    // Same turn never loops.
    if (hasTurn && hasHandledTurn && turn === handled.turn) {
      return true;
    }
    // Rapid stale-banner loop guard (10m cooldown).
    if (nowMs - handled.handledAtMs >= 0 && nowMs - handled.handledAtMs < SAME_BANNER_SUPPRESS_MS) {
      return true;
    }
    // Same absolute reset window never fires twice.
    if (
      Number.isFinite(detected.resetsAtMs) &&
      Number.isFinite(handled.resetsAtMs) &&
      Math.abs(detected.resetsAtMs - handled.resetsAtMs) <= 120_000
    ) {
      return true;
    }
    // Overnight stale-banner guard: dateless time-of-day banner ("resets 4pm (UTC)") or unchanged
    // status_ms where turn only advanced by 1 (from our resume) never rolls forward to fire again.
    if (hasTurn && hasHandledTurn && turn <= handled.turn + 1) {
      if (detected.isAbsoluteTimeOfDay) {
        return true;
      }
      if (statusMs != null && handled.statusMs != null && statusMs === handled.statusMs) {
        return true;
      }
    }
    return false;
  }

  function rememberPromotedEpisode(promoKey) {
    addBoundedList(state.promotedEpisodes, promoKey, MAX_PROMOTED_EPISODES);
  }

  function recordEpisodeAttempt(episodeKey) {
    const prev = state.episodeAttempts[episodeKey] ?? 0;
    setBoundedMap(state.episodeAttempts, episodeKey, prev + 1, MAX_EPISODE_ATTEMPTS_KEYS);
  }

  function getEpisodeAttempts(episodeKey) {
    return state.episodeAttempts[episodeKey] ?? 0;
  }

  function recordTerminalCooldown(address, atMs) {
    setBoundedMap(state.terminalCooldowns, address, atMs, MAX_TERMINAL_COOLDOWNS);
  }

  function isTerminalInCooldown(address, atMs) {
    const last = state.terminalCooldowns[address];
    return typeof last === "number" && Number.isFinite(last) && atMs - last >= 0 && atMs - last < TERMINAL_COOLDOWN_MS;
  }

  function getCancelEpoch(address) {
    return state.cancelEpochs[address] ?? 0;
  }

  function pruneTransientMaps(atMs) {
    for (const [k, claim] of Object.entries(state.claims)) {
      if (!claim || atMs - claim.atMs > CLAIM_TTL_MS) {
        delete state.claims[k];
      }
    }
    if (storeClaimsMap) {
      for (const [k, claim] of storeClaimsMap.entries()) {
        if (!claim || atMs - claim.atMs > CLAIM_TTL_MS) {
          storeClaimsMap.delete(k);
        }
      }
    }
    for (const [addr, ts] of Object.entries(state.terminalCooldowns)) {
      if (typeof ts !== "number" || atMs - ts > TERMINAL_COOLDOWN_MS) {
        delete state.terminalCooldowns[addr];
      }
    }
  }

  function mergeExternalBookkeeping(ext, atMs) {
    for (const fp of ext.handledFingerprints) {
      if (!state.handledFingerprints.includes(fp)) {
        rememberFingerprint(fp);
      }
    }
    for (const [addr, hb] of Object.entries(ext.handledBanners)) {
      const local = state.handledBanners[addr];
      if (!local || hb.handledAtMs > local.handledAtMs || (hb.cancelled && !local.cancelled)) {
        rememberHandledBanner(addr, hb);
      }
    }
    for (const pe of ext.promotedEpisodes) {
      if (!state.promotedEpisodes.includes(pe)) {
        rememberPromotedEpisode(pe);
      }
    }
    for (const [k, count] of Object.entries(ext.episodeAttempts)) {
      const local = state.episodeAttempts[k] ?? 0;
      if (count > local) {
        setBoundedMap(state.episodeAttempts, k, count, MAX_EPISODE_ATTEMPTS_KEYS);
      }
    }
    for (const [addr, ts] of Object.entries(ext.terminalCooldowns)) {
      const local = state.terminalCooldowns[addr] ?? 0;
      if (ts > local) {
        recordTerminalCooldown(addr, ts);
      }
    }
    for (const [addr, ep] of Object.entries(ext.cancelEpochs)) {
      const local = state.cancelEpochs[addr] ?? 0;
      if (ep > local) {
        setBoundedMap(state.cancelEpochs, addr, ep, MAX_CANCEL_EPOCHS);
        pendingCancelTokens.set(addr, (pendingCancelTokens.get(addr) ?? 0) + 1);
        if (ext.cancelledSignatures[addr]) {
          setBoundedMap(state.cancelledSignatures, addr, ext.cancelledSignatures[addr], MAX_CANCEL_EPOCHS);
        }
        // Drop any local queued entry that was cancelled externally.
        const idx = state.queue.findIndex((q) => q.address === addr);
        if (idx !== -1) state.queue.splice(idx, 1);
      }
    }
    // Drop any non-owned local claim that its owner has already released in shared state.
    for (const [k, local] of Object.entries(state.claims)) {
      if (local && local.owner !== instanceId && !ext.claims[k]) {
        delete state.claims[k];
      }
    }
    for (const [k, claim] of Object.entries(ext.claims)) {
      if (atMs - claim.atMs > CLAIM_TTL_MS) continue;
      if (claim.owner === instanceId) continue;
      const local = state.claims[k];
      if (!local || local.owner !== instanceId || claim.atMs <= local.atMs) {
        setBoundedMap(state.claims, k, { ...claim }, MAX_CLAIMS);
      }
    }
  }

  function syncFromShared(atMs = now()) {
    if (closed) return;
    const raw = env.shared(STATE_KEY);
    if (!raw || typeof raw !== "object") return;
    const ext = normalizeState(raw, atMs);

    const extUpdatedAtMs =
      typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
        ? raw.updatedAtMs
        : null;
    if (
      (extUpdatedAtMs !== null && extUpdatedAtMs > state.updatedAtMs) ||
      (ext.lastHandledCommandId && ext.lastHandledCommandId !== state.lastHandledCommandId)
    ) {
      state.enabled = ext.enabled;
      state.settings.agents = { ...ext.settings.agents };
      if (ext.lastHandledCommandId) {
        state.lastHandledCommandId = ext.lastHandledCommandId;
      }
      if (extUpdatedAtMs !== null) {
        state.updatedAtMs = extUpdatedAtMs;
      }
    }

    mergeExternalBookkeeping(ext, atMs);
  }

  function publish(force = false) {
    if (closed) return false;
    const atMs = now();
    // Always merge external bookkeeping (claims, attempts, cooldowns, cancels) before writing
    // so a stale writer (e.g. clear-history on another instance) never erases another instance's active claim.
    const raw = env.shared(STATE_KEY);
    if (raw && typeof raw === "object") {
      mergeExternalBookkeeping(normalizeState(raw, atMs), atMs);
    }
    pruneTransientMaps(atMs);
    const key = stateComparableKey(state);
    if (!force && key === lastPublishedKey) return false;
    state.updatedAtMs = atMs;
    lastPublishedKey = key;
    env.setShared(STATE_KEY, cloneState(state));
    return true;
  }

  function recordOutcome(entry, outcome, detail, atMs, { remember = true, cancelled = false } = {}) {
    const idx = state.queue.findIndex((q) => q.address === entry.address);
    if (idx !== -1) state.queue.splice(idx, 1);
    if (remember) {
      if (isScreenFingerprint(entry.errorFingerprint)) {
        rememberHandledBanner(entry.address, {
          bannerKey: entry.errorFingerprint,
          turn: entry.errorTurn,
          statusMs: entry.errorStatusMs ?? null,
          resetsAtMs: entry.resetsAtMs,
          handledAtMs: atMs,
          cancelled: cancelled || outcome === "cancelled",
        });
      } else {
        rememberFingerprint(entry.errorFingerprint);
      }
    }
    state.history = appendHistory(state.history, {
      id: `${atMs}-${entry.address}`,
      address: entry.address,
      machine: entry.machine,
      agent: entry.agent,
      title: entry.title,
      outcome,
      detail,
      atMs,
    });
  }

  function scheduleAfter(ms, fn, afterFn = defaultAfter) {
    if (closed) return null;
    let rawCancel = null;
    let wrappedCancel = null;
    const wrappedFn = () => {
      if (wrappedCancel) activeTimeoutCancels.delete(wrappedCancel);
      fn();
    };
    if (typeof afterFn === "function") {
      const cancel = afterFn(ms, wrappedFn);
      rawCancel = typeof cancel === "function" ? cancel : () => {};
    } else if (typeof globalThis.setTimeout === "function") {
      const handle = globalThis.setTimeout(wrappedFn, ms);
      if (handle && typeof handle.unref === "function") handle.unref();
      rawCancel = () => {
        if (typeof globalThis.clearTimeout === "function") {
          globalThis.clearTimeout(handle);
        }
      };
    } else {
      return null;
    }

    wrappedCancel = () => {
      activeTimeoutCancels.delete(wrappedCancel);
      rawCancel();
    };
    activeTimeoutCancels.add(wrappedCancel);
    return wrappedCancel;
  }

  function evictExpiredHungOps(atMs = now()) {
    for (const [k, op] of [...inFlightOps.entries()]) {
      if (!op) {
        inFlightOps.delete(k);
        continue;
      }
      if (op.timedOut && (atMs - op.startedAtMs >= op.evictAfterMs || op.skippedChecks >= HUNG_OP_EVICT_SKIPPED_TICKS)) {
        inFlightOps.delete(k);
      }
    }
  }

  async function runBoundedHostCall(opKey, invokeFn, { timeoutMs, after = defaultAfter, address = null } = {}) {
    if (closed) {
      throw new Error("engine closed");
    }
    const startedAtMs = now();
    evictExpiredHungOps(startedAtMs);

    if (opKey && inFlightOps.has(opKey)) {
      const existing = inFlightOps.get(opKey);
      if (existing.timedOut) {
        existing.skippedChecks += 1;
        if (
          startedAtMs - existing.startedAtMs >= existing.evictAfterMs ||
          existing.skippedChecks >= HUNG_OP_EVICT_SKIPPED_TICKS
        ) {
          inFlightOps.delete(opKey);
        } else {
          throw new Error(`host op ${opKey} still in flight`);
        }
      } else {
        throw new Error(`host op ${opKey} still in flight`);
      }
    }

    if (liveUnsettledOps.size >= MAX_GLOBAL_IN_FLIGHT) {
      throw new Error("global in-flight host call limit reached");
    }

    let opPromise;
    try {
      opPromise = Promise.resolve(invokeFn());
    } catch (e) {
      opPromise = Promise.reject(e);
    }

    liveUnsettledOps.add(opPromise);
    const cleanupGlobal = () => {
      liveUnsettledOps.delete(opPromise);
    };
    opPromise.then(cleanupGlobal, cleanupGlobal);

    let opRecord = null;
    if (opKey) {
      opRecord = {
        promise: opPromise,
        startedAtMs,
        evictAfterMs: Math.max(1000, (timeoutMs || HC_TIMEOUT_MS) * HUNG_OP_EVICT_MULTIPLIER),
        address,
        timedOut: false,
        skippedChecks: 0,
      };
      inFlightOps.set(opKey, opRecord);
      const cleanupOp = () => {
        if (inFlightOps.get(opKey) === opRecord) {
          inFlightOps.delete(opKey);
        }
      };
      opPromise.then(cleanupOp, cleanupOp);
    }

    let cancelTimeout = null;
    let onCloseReject = null;
    try {
      const racePromise = new Promise((_, reject) => {
        onCloseReject = () => reject(new Error("engine closed"));
        activeWaitRejectors.add(onCloseReject);
        cancelTimeout = scheduleAfter(
          timeoutMs,
          () => {
            if (opRecord) opRecord.timedOut = true;
            reject(new Error(`host op ${opKey ?? "hc"} timed out`));
          },
          after,
        );
      });
      return await Promise.race([opPromise, racePromise]);
    } finally {
      if (onCloseReject) activeWaitRejectors.delete(onCloseReject);
      if (typeof cancelTimeout === "function") {
        try {
          cancelTimeout();
        } catch {
          // already fired or cancelled
        }
      }
    }
  }

  async function runHc(args, { opKey = null, timeoutMs = hcTimeoutMs, after = defaultAfter, address = null } = {}) {
    return runBoundedHostCall(opKey, () => env.hc(args), { timeoutMs, after, address });
  }

  async function readTranscriptTail(sessionId, machine, address = "", afterFn = defaultAfter) {
    const args = buildTranscriptExecArgs(sessionId);
    if (!args) return { ok: true, entries: null, missing: true };
    const opKey = `${address || sessionId}:transcript`;
    try {
      const res = await runBoundedHostCall(
        opKey,
        () => env.exec("sh", args, { on: machine, timeout: TRANSCRIPT_TIMEOUT_MS }),
        { timeoutMs: TRANSCRIPT_TIMEOUT_MS + 1000, after: afterFn, address: address || null },
      );
      if (res && res.code === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
        return { ok: true, entries: parseTranscriptTail(res.stdout), missing: false };
      }
      if (res && res.code === 3) {
        return { ok: true, entries: null, missing: true };
      }
      return { ok: false, entries: null, missing: false };
    } catch {
      return { ok: false, entries: null, missing: false };
    }
  }

  async function readTerminalScreen(address, afterFn = defaultAfter) {
    try {
      const res = await runHc(["read", address, "--lines", SCREEN_READ_LINES], {
        opKey: `${address}:read`,
        timeoutMs: hcTimeoutMs,
        after: afterFn,
        address,
      });
      if (!res || res.code !== 0) return { ok: false, text: "" };
      return { ok: true, text: extractScreenText(res) };
    } catch {
      return { ok: false, text: "" };
    }
  }

  async function fetchFreshTerminal(address, afterFn = defaultAfter) {
    try {
      const res = await runHc(["get", address, "--json"], {
        opKey: `${address}:get`,
        timeoutMs: hcTimeoutMs,
        after: afterFn,
        address,
      });
      if (!res || res.code !== 0 || typeof res.stdout !== "string" || !res.stdout.trim()) {
        return { ok: false, terminal: null };
      }
      const parsed = JSON.parse(res.stdout);
      if (!parsed || typeof parsed !== "object") {
        return { ok: false, terminal: null };
      }
      return { ok: true, terminal: parsed };
    } catch {
      return { ok: false, terminal: null };
    }
  }

  function validateFreshTerminal(fresh, entry, atMs) {
    if (!fresh || fresh.state !== "live") {
      recordOutcome(entry, "skipped-closed", "Terminal is no longer live", atMs);
      return { ok: false, outcome: "skipped-closed" };
    }

    if (fresh.program?.shell || isShellName(fresh.foreground?.name)) {
      recordOutcome(entry, "skipped-session", "Terminal foreground is a shell", atMs);
      return { ok: false, outcome: "skipped-session" };
    }

    const freshAgent = identifyForegroundAgent(fresh.foreground);
    if (freshAgent !== entry.agent) {
      recordOutcome(
        entry,
        "skipped-session",
        `Expected ${entry.agent} in foreground, found ${freshAgent ?? fresh.foreground?.name ?? "missing"}`,
        atMs,
      );
      return { ok: false, outcome: "skipped-session" };
    }

    if (entry.agent === "claude" && entry.sessionId) {
      const liveSession = fresh.labels?.["claude.session"] ?? null;
      if (liveSession !== entry.sessionId) {
        recordOutcome(entry, "skipped-session", "Claude session label changed", atMs);
        return { ok: false, outcome: "skipped-session" };
      }
    }

    const freshStatus = terminalStatusWord(fresh);
    if (!IDLE_STATES.has(freshStatus)) {
      recordOutcome(entry, "skipped-busy", `Terminal is ${freshStatus ?? "busy"}`, atMs);
      return { ok: false, outcome: "skipped-busy" };
    }

    // Fail closed on turn check: require both recorded errorTurn and live fresh.turn to be present and equal.
    if (
      entry.errorTurn == null ||
      typeof fresh.turn !== "number" ||
      !Number.isFinite(fresh.turn)
    ) {
      recordOutcome(entry, "skipped-replied", "Terminal turn unavailable", atMs);
      return { ok: false, outcome: "skipped-replied" };
    }
    if (fresh.turn !== entry.errorTurn) {
      recordOutcome(entry, "skipped-replied", "Session turn advanced since error", atMs);
      return { ok: false, outcome: "skipped-replied" };
    }

    return { ok: true, status: freshStatus };
  }

  function handleTransientGetFailure(entry, atMs) {
    entry.getFailures = (entry.getFailures ?? 0) + 1;
    entry.lastCheckMs = atMs;
    if (entry.getFailures >= MAX_GET_FAILURES) {
      // Clear cached inspection signature so once the host recovers, the unchanged terminal is re-inspected.
      lastInspected.delete(entry.address);
      recordOutcome(entry, "skipped-closed", "Terminal unreachable after retries", atMs, { remember: false });
      return { sent: false, outcome: "skipped-closed" };
    }
    entry.resumeAtMs = atMs + RETRY_BACKOFF_MS;
    return { sent: false, outcome: "deferred" };
  }

  function applySyncCommand(rawCmd) {
    if (closed) return false;
    const cmd = parseCommand(rawCmd);
    if (!cmd || !isSyncCommand(cmd)) return false;
    if (cmd.id === state.lastHandledCommandId) return false;

    state.lastHandledCommandId = cmd.id;
    const atMs = now();

    if (cmd.action === "toggle-enabled") {
      state.enabled = typeof cmd.enabled === "boolean" ? cmd.enabled : !state.enabled;
      if (state.enabled) lastInspected.clear();
      publish(true);
      return true;
    }

    if (cmd.action === "toggle-agent") {
      if (SUPPORTED_AGENTS.includes(cmd.agent)) {
        const next = typeof cmd.enabled === "boolean" ? cmd.enabled : !state.settings.agents[cmd.agent];
        state.settings.agents[cmd.agent] = next;
        if (next) lastInspected.clear();
      }
      publish(true);
      return true;
    }

    if (cmd.action === "cancel") {
      pendingCancelTokens.set(cmd.address, (pendingCancelTokens.get(cmd.address) ?? 0) + 1);
      const nextEpoch = getCancelEpoch(cmd.address) + 1;
      setBoundedMap(state.cancelEpochs, cmd.address, nextEpoch, MAX_CANCEL_EPOCHS);
      const liveSig = liveSignatures.get(cmd.address);
      if (liveSig) {
        setBoundedMap(state.cancelledSignatures, cmd.address, liveSig, MAX_CANCEL_EPOCHS);
      }
      const entry = state.queue.find((e) => e.address === cmd.address);
      if (entry) {
        recordOutcome(entry, "cancelled", "Cancelled by user", atMs, { cancelled: true });
      }
      publish(true);
      return true;
    }

    if (cmd.action === "clear-history") {
      state.history = [];
      publish(true);
      return true;
    }

    return false;
  }

  function drainPendingSyncCommand() {
    if (closed) return;
    const pending = env.shared(COMMAND_KEY);
    if (pending && isSyncCommand(pending)) {
      applySyncCommand(pending);
    }
  }

  async function detectRateLimitForTerminal(terminal, agent, nowMs, afterFn = defaultAfter) {
    const machine = machineOf(terminal.address);
    const sessionId = agent === "claude" ? (terminal.labels?.["claude.session"] ?? null) : null;
    const usageState = machine === null ? env.shared(USAGE_LIMITS_STATE_KEY) : null;

    let transcriptOk = true;
    if (agent === "claude" && sessionId && isUuid(sessionId)) {
      const tRes = await readTranscriptTail(sessionId, machine, terminal.address, afterFn);
      if (closed) return { ok: false, detected: null };
      transcriptOk = tRes.ok;
      if (tRes.ok && Array.isArray(tRes.entries) && tRes.entries.length > 0) {
        const found = findActiveQuotaError(tRes.entries, nowMs);
        if (!found) {
          // Definitive transcript read with no active quota error -> do not scrape chat prose.
          return { ok: true, detected: null };
        }
        return {
          ok: true,
          detected: {
            resetsAtMs: found.resetsAtMs,
            resetSource: "transcript",
            reason: found.reason,
            errorFingerprint: found.uuid,
            transcriptUuid: found.transcriptUuid,
            provider: "claude",
            sessionId,
            matchedLine: null,
            matchedSnippet: null,
          },
        };
      }
    }

    // Screen banner detection (Claude fallback when transcript unavailable, Codex, OpenCode).
    const sRes = await readTerminalScreen(terminal.address, afterFn);
    if (closed || !sRes.ok) {
      return { ok: false, detected: null };
    }

    const detected = detectScreenRateLimit({
      agent,
      address: terminal.address,
      text: sRes.text,
      reportMsg: terminal.report?.msg ?? null,
      nowMs,
    });
    if (!detected) {
      return { ok: transcriptOk, detected: null };
    }

    let resetsAtMs = detected.resetsAtMs;
    let resetSource = "screen";
    let provider = inferProvider(agent, detected.matchedLine);

    if (resetsAtMs == null) {
      if (machine === null) {
        const fromQuota = resolveQuotaResetFromUsage(usageState, agent, {
          bannerText: detected.matchedLine,
          nowMs,
        });
        if (fromQuota) {
          resetsAtMs = fromQuota.resetsAtMs;
          resetSource = "quota";
          provider = fromQuota.provider;
        }
      }
      // Never schedule via arbitrary fallback without explicit reset time OR usage-limits corroboration.
      if (resetsAtMs == null) {
        return { ok: true, detected: null, needsUsageEvidence: machine === null };
      }
    }

    return {
      ok: true,
      detected: {
        resetsAtMs,
        resetSource,
        reason: detected.reason,
        errorFingerprint: detected.fingerprint,
        transcriptUuid: null,
        provider,
        sessionId,
        matchedLine: detected.matchedLine,
        matchedSnippet: detected.normalizedSnippet ?? null,
        isAbsoluteTimeOfDay: Boolean(detected.isAbsoluteTimeOfDay),
      },
    };
  }

  function expireStaleQueueEntries(nowMs) {
    for (const entry of [...state.queue]) {
      if (entry.status === "resuming") continue;
      if (isEntryExpired(entry, nowMs)) {
        recordOutcome(entry, "cancelled", "Expired after reset window passed", nowMs);
      }
    }
  }

  function reconcileQueueWithTerminals(liveTerminals, paneList, spaceList, nowMs) {
    const byAddr = new Map(liveTerminals.map((t) => [t.address, t]));
    const connectedMachines = new Set(liveTerminals.map((t) => machineOf(t.address)).filter(Boolean));
    const hasLocal = liveTerminals.some((t) => machineOf(t.address) === null);

    for (const entry of [...state.queue]) {
      if (entry.status === "resuming") continue;
      const t = byAddr.get(entry.address);
      if (!t) {
        const machineReporting =
          entry.machine === null ? hasLocal : connectedMachines.has(entry.machine);
        if (machineReporting) {
          recordOutcome(entry, "skipped-closed", "Terminal closed before reset", nowMs);
        }
        continue;
      }

      entry.lastCheckMs = nowMs;

      if (t.state !== "live") {
        recordOutcome(entry, "skipped-closed", "Terminal is no longer live", nowMs);
        continue;
      }
      if (t.program?.shell || isShellName(t.foreground?.name)) {
        recordOutcome(entry, "skipped-session", "Terminal returned to shell", nowMs);
        continue;
      }
      const liveAgent = identifyAgent(t);
      if (liveAgent && liveAgent !== entry.agent) {
        recordOutcome(entry, "skipped-session", `Terminal switched to ${liveAgent}`, nowMs);
        continue;
      }
      if (entry.sessionId && t.labels?.["claude.session"] && t.labels["claude.session"] !== entry.sessionId) {
        recordOutcome(entry, "skipped-session", "Claude session changed", nowMs);
        continue;
      }
      if (entry.errorTurn != null && typeof t.turn === "number" && t.turn !== entry.errorTurn) {
        recordOutcome(entry, "skipped-replied", "Terminal advanced past error turn", nowMs);
        continue;
      }

      const { title, where } = buildTitleAndWhere(t, paneList, spaceList);
      entry.title = title;
      entry.where = where;
    }
  }

  function reconcileQueueWithUsageLimits(nowMs) {
    const usageState = env.shared(USAGE_LIMITS_STATE_KEY);
    if (!usageState || typeof usageState !== "object") return;
    for (const entry of state.queue) {
      const decision = evaluateQuotaForEntry(
        entry,
        usageState,
        nowMs,
        state.settings.delaySec,
        state.promotedEpisodes,
      );
      if (!decision) continue;
      if (decision.action === "defer") {
        entry.resetsAtMs = decision.resetsAtMs;
        entry.resumeAtMs = decision.resumeAtMs;
        entry.resetSource = "quota";
        entry.sawExhausted = true;
        entry.exhaustedObservedAtMs = decision.observedAtMs;
        entry.earlyPromoted = false;
        entry.episodeKey = buildEpisodeKey(entry);
      } else if (decision.action === "observe-exhausted") {
        entry.sawExhausted = true;
        entry.exhaustedObservedAtMs = decision.observedAtMs;
      } else if (decision.action === "promote") {
        entry.earlyPromoted = true;
        rememberPromotedEpisode(decision.promoKey);
        if (entry.resumeAtMs > nowMs) {
          entry.resumeAtMs = nowMs;
        }
      }
    }
  }

  async function scanCandidates(liveTerminals, paneList, spaceList, nowMs, afterFn = defaultAfter) {
    if (closed || !state.enabled) return;

    const liveAddrs = new Set(liveTerminals.map((t) => t.address));
    for (const addr of [...lastInspected.keys()]) {
      if (!liveAddrs.has(addr)) lastInspected.delete(addr);
    }
    for (const addr of [...liveSignatures.keys()]) {
      if (!liveAddrs.has(addr)) liveSignatures.delete(addr);
    }
    for (const [opKey, op] of [...inFlightOps.entries()]) {
      if (op?.address && !liveAddrs.has(op.address)) {
        inFlightOps.delete(opKey);
      }
    }

    const queuedAddrs = new Set(state.queue.map((e) => e.address));
    const usageSig = usageExhaustedSignature(env.shared(USAGE_LIMITS_STATE_KEY), nowMs);

    for (const t of liveTerminals) {
      if (closed) return;
      drainPendingSyncCommand();
      syncFromShared(now());
      if (closed || !state.enabled) return;

      const sig = inspectionSignature(t);
      const usageScopedSig = `${sig}|usage:${usageSig}`;
      liveSignatures.set(t.address, sig);

      if (!isCandidateTerminal(t)) {
        lastInspected.delete(t.address);
        continue;
      }
      const agent = identifyAgent(t);
      if (!agent || !state.settings.agents[agent]) continue;
      if (queuedAddrs.has(t.address)) continue;

      // Skip terminals explicitly cancelled on this exact signature; clear once signature changes.
      const cancelledSig = state.cancelledSignatures[t.address];
      if (cancelledSig) {
        if (cancelledSig === sig) continue;
        delete state.cancelledSignatures[t.address];
      }

      const cachedSig = lastInspected.get(t.address);
      if (cachedSig === sig || cachedSig === usageScopedSig) continue;

      const startEpoch = getCancelEpoch(t.address);
      const startCancelToken = pendingCancelTokens.get(t.address) ?? 0;
      const probe = await detectRateLimitForTerminal(t, agent, nowMs, afterFn);
      if (closed) return;

      drainPendingSyncCommand();
      syncFromShared(now());
      if (closed) return;

      // Cancel arrived while inspection was in flight -> discard detection & tombstone this signature.
      const cancelledInFlight =
        (pendingCancelTokens.get(t.address) ?? 0) !== startCancelToken ||
        getCancelEpoch(t.address) !== startEpoch ||
        state.cancelledSignatures[t.address] === sig;
      if (cancelledInFlight) {
        setBoundedMap(state.cancelledSignatures, t.address, sig, MAX_CANCEL_EPOCHS);
        lastInspected.set(t.address, sig);
        if (probe.ok && probe.detected) {
          if (isScreenFingerprint(probe.detected.errorFingerprint)) {
            rememberHandledBanner(t.address, {
              bannerKey: probe.detected.errorFingerprint,
              turn: typeof t.turn === "number" ? t.turn : null,
              statusMs: typeof t.status_ms === "number" && Number.isFinite(t.status_ms) ? t.status_ms : null,
              resetsAtMs: probe.detected.resetsAtMs,
              handledAtMs: now(),
              cancelled: true,
            });
          } else {
            rememberFingerprint(probe.detected.errorFingerprint);
          }
        }
        publish(true);
        continue;
      }

      if (!probe.ok) {
        // Inspection failed (transient read/exec error) -> do NOT cache signature so next tick retries.
        continue;
      }
      if (probe.needsUsageEvidence) {
        // Timeless banner awaiting 100% usage-limits evidence: re-scan automatically when usage-limits changes.
        lastInspected.set(t.address, usageScopedSig);
        continue;
      }
      lastInspected.set(t.address, sig);

      const detected = probe.detected;
      if (!detected) continue;

      if (!state.enabled || !state.settings.agents[agent]) continue;
      if (queuedAddrs.has(t.address) || state.queue.some((q) => q.address === t.address)) continue;

      // Reject stale errors whose reset time has already passed (avoid infinite retry loops).
      if (!Number.isFinite(detected.resetsAtMs) || detected.resetsAtMs <= nowMs) {
        log(`ignoring past resetsAt for ${t.address} (${detected.resetsAtMs})`);
        continue;
      }

      // Require an authoritative detection-time turn so turn checks can never be silently disabled.
      let turn = typeof t.turn === "number" && Number.isFinite(t.turn) ? t.turn : null;
      let statusMs =
        typeof t.status_ms === "number" && Number.isFinite(t.status_ms)
          ? t.status_ms
          : typeof t.report?.at === "number" && Number.isFinite(t.report.at)
            ? t.report.at
            : null;
      if (turn === null) {
        const freshTurnRes = await fetchFreshTerminal(t.address, afterFn);
        if (closed) return;
        if (!freshTurnRes.ok) {
          lastInspected.delete(t.address);
          continue;
        }
        if (typeof freshTurnRes.terminal?.turn === "number" && Number.isFinite(freshTurnRes.terminal.turn)) {
          turn = freshTurnRes.terminal.turn;
        }
        if (
          statusMs === null &&
          typeof freshTurnRes.terminal?.status_ms === "number" &&
          Number.isFinite(freshTurnRes.terminal.status_ms)
        ) {
          statusMs = freshTurnRes.terminal.status_ms;
        }
      }
      if (turn === null) {
        // Fail closed: never queue an entry with errorTurn: null.
        continue;
      }

      if (isScreenFingerprint(detected.errorFingerprint)) {
        if (isBannerSuppressed(t.address, detected, turn, statusMs, nowMs)) {
          continue;
        }
      } else if (hasHandledFingerprint(detected.errorFingerprint)) {
        continue;
      }

      const { title, where } = buildTitleAndWhere(t, paneList, spaceList);
      const entry = {
        address: t.address,
        machine: machineOf(t.address),
        agent,
        provider: detected.provider ?? agent,
        sessionId: detected.sessionId ?? null,
        transcriptUuid: detected.transcriptUuid ?? null,
        title,
        where,
        detectedAtMs: nowMs,
        resetsAtMs: detected.resetsAtMs,
        resumeAtMs: detected.resetsAtMs + state.settings.delaySec * 1000,
        resetSource: detected.resetSource,
        reason: detected.reason,
        errorTurn: turn,
        errorStatusMs: statusMs,
        isAbsoluteTimeOfDay: Boolean(detected.isAbsoluteTimeOfDay),
        errorFingerprint: detected.errorFingerprint,
        episodeKey: null,
        matchedLine: detected.matchedLine ?? null,
        matchedSnippet: detected.matchedSnippet ?? null,
        status: "waiting",
        attempts: 0,
        getFailures: 0,
        transcriptFailures: 0,
        screenFailures: 0,
        sawExhausted: false,
        exhaustedObservedAtMs: null,
        earlyPromoted: false,
        lastCheckMs: nowMs,
      };
      entry.episodeKey = buildEpisodeKey(entry);
      if (getEpisodeAttempts(entry.episodeKey) >= MAX_EPISODE_ATTEMPTS) {
        continue;
      }

      state.queue.push(entry);
      queuedAddrs.add(t.address);
    }
  }

  function releaseOwnClaim(claimKey) {
    if (state.claims[claimKey]?.owner === instanceId) {
      delete state.claims[claimKey];
    }
    if (storeClaimsMap && storeClaimsMap.get(claimKey)?.owner === instanceId) {
      storeClaimsMap.delete(claimKey);
    }
  }

  function acquireExclusiveClaim(entry, episodeKey, atMs) {
    if (closed) return false;
    drainPendingSyncCommand();
    syncFromShared(atMs);
    if (closed) return false;

    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return false;
    }
    if (entry.attempts >= MAX_EPISODE_ATTEMPTS || getEpisodeAttempts(episodeKey) >= MAX_EPISODE_ATTEMPTS) {
      return false;
    }
    if (isTerminalInCooldown(entry.address, atMs)) {
      return false;
    }

    // Key exclusive claims by address (not minute-bucketed episodeKey) so two engines reading
    // the same relative banner across a minute boundary contend on the exact same lock.
    const claimKey = entry.address;
    const existingStateClaim = state.claims[claimKey];
    if (
      existingStateClaim &&
      existingStateClaim.owner !== instanceId &&
      atMs - existingStateClaim.atMs <= CLAIM_TTL_MS
    ) {
      return false;
    }

    if (storeClaimsMap) {
      const existingMemClaim = storeClaimsMap.get(claimKey);
      if (
        existingMemClaim &&
        existingMemClaim.owner !== instanceId &&
        atMs - existingMemClaim.atMs <= CLAIM_TTL_MS
      ) {
        return false;
      }
      storeClaimsMap.set(claimKey, { owner: instanceId, atMs });
    }

    const prevStatus = entry.status;
    setBoundedMap(state.claims, claimKey, { owner: instanceId, atMs }, MAX_CLAIMS);
    entry.status = "resuming";
    entry.lastCheckMs = atMs;
    publish(true);

    // Immediate re-read verification to ensure our instance won the shared-state claim.
    // Roll back local status and claim if the write was dropped or another instance won.
    const reRead = env.shared(STATE_KEY);
    const wonClaim =
      reRead &&
      typeof reRead === "object" &&
      reRead.claims &&
      typeof reRead.claims === "object" &&
      reRead.claims[claimKey]?.owner === instanceId;
    if (!wonClaim) {
      entry.status = prevStatus;
      releaseOwnClaim(claimKey);
      const extClaim =
        reRead && typeof reRead === "object" && reRead.claims && typeof reRead.claims === "object"
          ? reRead.claims[claimKey]
          : null;
      if (
        extClaim &&
        typeof extClaim.owner === "string" &&
        extClaim.owner &&
        extClaim.owner !== instanceId &&
        typeof extClaim.atMs === "number" &&
        Number.isFinite(extClaim.atMs) &&
        atMs - extClaim.atMs <= CLAIM_TTL_MS
      ) {
        setBoundedMap(state.claims, claimKey, { owner: extClaim.owner, atMs: extClaim.atMs }, MAX_CLAIMS);
      }
      return false;
    }

    return true;
  }

  async function fireEntry(entry, afterFn = defaultAfter, { manual = false } = {}) {
    if (closed) return { sent: false, outcome: "cancelled" };
    drainPendingSyncCommand();
    syncFromShared(now());
    if (closed) return { sent: false, outcome: "cancelled" };
    const atMs = now();

    // 0. Fast synchronous eligibility, expiry, reset-time, attempt-cap, and cooldown guards.
    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }
    if (isEntryExpired(entry, atMs)) {
      recordOutcome(entry, "cancelled", "Expired after reset window passed", atMs);
      return { sent: false, outcome: "cancelled" };
    }
    if (!manual && !entry.earlyPromoted && atMs < entry.resetsAtMs) {
      entry.resumeAtMs = Math.max(entry.resumeAtMs, entry.resetsAtMs + state.settings.delaySec * 1000);
      entry.lastCheckMs = atMs;
      return { sent: false, outcome: "deferred" };
    }
    const episodeKey = entry.episodeKey || buildEpisodeKey(entry);
    entry.episodeKey = episodeKey;
    if (entry.attempts >= MAX_EPISODE_ATTEMPTS || getEpisodeAttempts(episodeKey) >= MAX_EPISODE_ATTEMPTS) {
      recordOutcome(entry, "skipped-replied", "Episode already attempted", atMs);
      return { sent: false, outcome: "skipped-replied" };
    }
    if (isTerminalInCooldown(entry.address, atMs)) {
      recordOutcome(entry, "skipped-busy", "Per-terminal cooldown active", atMs);
      return { sent: false, outcome: "skipped-busy" };
    }
    const claimKey = entry.address;
    const existingClaim = state.claims[claimKey];
    if (existingClaim && existingClaim.owner !== instanceId && atMs - existingClaim.atMs <= CLAIM_TTL_MS) {
      const idx = state.queue.indexOf(entry);
      if (idx !== -1) state.queue.splice(idx, 1);
      return { sent: false, outcome: "skipped-busy" };
    }

    entry.lastCheckMs = atMs;

    // 1. Fast pre-check via `hc get <addr> --json` (avoids slow remote I/O on dead/wrong-foreground terminals).
    //    Do NOT reset `entry.getFailures` on preGet success — only reset after `finalGet` succeeds!
    const preGet = await fetchFreshTerminal(entry.address, afterFn);
    if (closed) return { sent: false, outcome: "cancelled" };
    if (!preGet.ok) {
      return handleTransientGetFailure(entry, now());
    }
    const preValid = validateFreshTerminal(preGet.terminal, entry, now());
    if (!preValid.ok) {
      return { sent: false, outcome: preValid.outcome };
    }

    // 2. Slow I/O BEFORE final `hc get` (fail-closed on errors!).
    const isTranscriptVerified = entry.agent === "claude" && Boolean(entry.transcriptUuid);

    // 2a. Claude transcript re-check.
    if (isTranscriptVerified) {
      if (!entry.sessionId || !isUuid(entry.sessionId)) {
        recordOutcome(entry, "skipped-replied", "Invalid Claude session for transcript verification", now());
        return { sent: false, outcome: "skipped-replied" };
      }
      const tRes = await readTranscriptTail(entry.sessionId, entry.machine, entry.address, afterFn);
      if (closed) return { sent: false, outcome: "cancelled" };
      if (!tRes.ok || !Array.isArray(tRes.entries) || tRes.entries.length === 0) {
        entry.transcriptFailures = (entry.transcriptFailures ?? 0) + 1;
        entry.lastCheckMs = now();
        if (entry.transcriptFailures >= MAX_IO_FAILURES) {
          recordOutcome(entry, "failed", "Unable to re-read Claude transcript", now());
          return { sent: false, outcome: "failed" };
        }
        entry.resumeAtMs = now() + RETRY_BACKOFF_MS;
        return { sent: false, outcome: "deferred" };
      }
      entry.transcriptFailures = 0;
      const verify = verifyActiveTranscriptError(tRes.entries, entry.transcriptUuid);
      if (!verify.ok) {
        recordOutcome(entry, "skipped-replied", "Claude already replied or transcript error missing", now());
        return { sent: false, outcome: "skipped-replied" };
      }
      const verifyNowMs = now();
      if (
        !manual &&
        verify.newerError &&
        verify.newerError.uuid !== entry.transcriptUuid &&
        verify.newerError.resetsAtMs > entry.resetsAtMs
      ) {
        entry.transcriptUuid = verify.newerError.transcriptUuid;
        entry.errorFingerprint = verify.newerError.uuid;
        entry.resetsAtMs = verify.newerError.resetsAtMs;
        entry.resumeAtMs = verify.newerError.resetsAtMs + state.settings.delaySec * 1000;
        entry.reason = verify.newerError.reason;
        entry.resetSource = "transcript";
        entry.sawExhausted = false;
        entry.exhaustedObservedAtMs = null;
        entry.earlyPromoted = false;
        entry.episodeKey = buildEpisodeKey(entry);
        entry.lastCheckMs = verifyNowMs;
        return { sent: false, outcome: "deferred" };
      }
      if (!manual && verify.resetsAtMs > entry.resetsAtMs) {
        entry.resetsAtMs = verify.resetsAtMs;
        entry.resumeAtMs = verify.resetsAtMs + state.settings.delaySec * 1000;
        entry.earlyPromoted = false;
        entry.episodeKey = buildEpisodeKey(entry);
        entry.lastCheckMs = verifyNowMs;
        return { sent: false, outcome: "deferred" };
      }
      if (!manual && !entry.earlyPromoted && verify.resetsAtMs + state.settings.delaySec * 1000 > verifyNowMs) {
        entry.resetsAtMs = verify.resetsAtMs;
        entry.resumeAtMs = verify.resetsAtMs + state.settings.delaySec * 1000;
        entry.lastCheckMs = verifyNowMs;
        return { sent: false, outcome: "deferred" };
      }
    } else if (entry.agent === "claude" && entry.sessionId && isUuid(entry.sessionId)) {
      // Claude screen-fallback entry: missing transcript (code 3) is allowed to proceed to screen re-check,
      // while exec errors fail closed and readable transcripts still guard against replies.
      const tRes = await readTranscriptTail(entry.sessionId, entry.machine, entry.address, afterFn);
      if (closed) return { sent: false, outcome: "cancelled" };
      if (!tRes.ok) {
        entry.transcriptFailures = (entry.transcriptFailures ?? 0) + 1;
        entry.lastCheckMs = now();
        if (entry.transcriptFailures >= MAX_IO_FAILURES) {
          recordOutcome(entry, "failed", "Unable to re-read Claude transcript", now());
          return { sent: false, outcome: "failed" };
        }
        entry.resumeAtMs = now() + RETRY_BACKOFF_MS;
        return { sent: false, outcome: "deferred" };
      }
      entry.transcriptFailures = 0;
      if (Array.isArray(tRes.entries) && tRes.entries.length > 0) {
        if (hasAssistantReplyAfterTime(tRes.entries, entry.detectedAtMs)) {
          recordOutcome(entry, "skipped-replied", "Claude already replied since the error", now());
          return { sent: false, outcome: "skipped-replied" };
        }
      }
    }

    drainPendingSyncCommand();
    syncFromShared(now());
    if (closed || !state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }

    // 2b. Visible screen re-check (`hc read <addr> --lines 0`): unsent draft check (all agents)
    //     and active banner confirmation (ALL non-transcript-verified entries, including Codex/OpenCode/restored).
    const sRes = await readTerminalScreen(entry.address, afterFn);
    if (closed) return { sent: false, outcome: "cancelled" };
    if (!sRes.ok) {
      entry.screenFailures = (entry.screenFailures ?? 0) + 1;
      entry.lastCheckMs = now();
      if (entry.screenFailures >= MAX_IO_FAILURES) {
        recordOutcome(entry, "failed", "Unable to read terminal screen", now());
        return { sent: false, outcome: "failed" };
      }
      entry.resumeAtMs = now() + RETRY_BACKOFF_MS;
      return { sent: false, outcome: "deferred" };
    }
    entry.screenFailures = 0;

    if (hasUnsentDraft(sRes.text)) {
      recordOutcome(entry, "skipped-replied", "Unsent draft detected in terminal input", now());
      return { sent: false, outcome: "skipped-replied" };
    }

    let matchedViaReportMsg = false;
    if (!isTranscriptVerified) {
      const screenNowMs = now();
      const stillActive = detectScreenRateLimit({
        agent: entry.agent,
        address: entry.address,
        text: sRes.text,
        reportMsg: preGet.terminal?.report?.msg ?? null,
        nowMs: screenNowMs,
      });
      if (!stillActive) {
        recordOutcome(entry, "skipped-replied", "Rate-limit banner no longer active on screen", screenNowMs);
        return { sent: false, outcome: "skipped-replied" };
      }
      matchedViaReportMsg = stillActive.fingerprint.startsWith("report:");

      const bannerChanged =
        stillActive.fingerprint !== entry.errorFingerprint ||
        (entry.matchedSnippet && stillActive.normalizedSnippet && stillActive.normalizedSnippet !== entry.matchedSnippet);

      // Even if a restored entry lacked `matchedSnippet`, parse relative to original detection time
      // so unchanged relative banners (`Try again in 1m.`) do not falsely defer while replaced banners (`Try again in 5h.`) do!
      const resetRelativeToDetection =
        stillActive.normalizedSnippet ? parseResetTime(stillActive.normalizedSnippet, entry.detectedAtMs) : null;
      const resetShiftedLater =
        bannerChanged
          ? stillActive.resetsAtMs != null && stillActive.resetsAtMs > entry.resetsAtMs
          : resetRelativeToDetection != null && resetRelativeToDetection > entry.resetsAtMs + 60_000;

      if (!manual && resetShiftedLater && stillActive.resetsAtMs != null) {
        entry.resetsAtMs = stillActive.resetsAtMs;
        entry.resumeAtMs = stillActive.resetsAtMs + state.settings.delaySec * 1000;
        entry.matchedLine = stillActive.matchedLine;
        entry.matchedSnippet = stillActive.normalizedSnippet ?? null;
        entry.errorFingerprint = stillActive.fingerprint;
        entry.reason = stillActive.reason;
        entry.resetSource = "screen";
        entry.isAbsoluteTimeOfDay = Boolean(stillActive.isAbsoluteTimeOfDay);
        entry.earlyPromoted = false;
        entry.episodeKey = buildEpisodeKey(entry);
        entry.lastCheckMs = screenNowMs;
        return { sent: false, outcome: "deferred" };
      }

      if (!manual && bannerChanged && stillActive.resetsAtMs == null) {
        const usageState = entry.machine === null ? env.shared(USAGE_LIMITS_STATE_KEY) : null;
        const fromQuota =
          entry.machine === null
            ? resolveQuotaResetFromUsage(usageState, entry.agent, {
                bannerText: stillActive.matchedLine,
                nowMs: screenNowMs,
              })
            : null;
        if (!fromQuota) {
          recordOutcome(entry, "skipped-replied", "Rate-limit banner changed without reset time", screenNowMs);
          return { sent: false, outcome: "skipped-replied" };
        }
        if (fromQuota.resetsAtMs > entry.resetsAtMs + 60_000) {
          entry.resetsAtMs = fromQuota.resetsAtMs;
          entry.resumeAtMs = fromQuota.resetsAtMs + state.settings.delaySec * 1000;
          entry.matchedLine = stillActive.matchedLine;
          entry.matchedSnippet = stillActive.normalizedSnippet ?? null;
          entry.errorFingerprint = stillActive.fingerprint;
          entry.reason = stillActive.reason;
          entry.resetSource = "quota";
          entry.provider = fromQuota.provider;
          entry.earlyPromoted = false;
          entry.episodeKey = buildEpisodeKey(entry);
          entry.lastCheckMs = screenNowMs;
          return { sent: false, outcome: "deferred" };
        }
      }
    }

    drainPendingSyncCommand();
    syncFromShared(now());
    if (closed || !state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }

    // 3. Final `hc get <addr> --json` LAST right before sending (catches state changes during slow I/O).
    const finalGet = await fetchFreshTerminal(entry.address, afterFn);
    if (closed) return { sent: false, outcome: "cancelled" };
    if (!finalGet.ok) {
      return handleTransientGetFailure(entry, now());
    }
    entry.getFailures = 0;
    const finalValid = validateFreshTerminal(finalGet.terminal, entry, now());
    if (!finalValid.ok) {
      return { sent: false, outcome: finalValid.outcome };
    }

    // If the banner was matched only via preliminary `report.msg`, confirm it is still active in `finalGet.terminal.report.msg`.
    if (!isTranscriptVerified && matchedViaReportMsg) {
      const finalNowMs = now();
      const finalStillActive = detectScreenRateLimit({
        agent: entry.agent,
        address: entry.address,
        text: sRes.text,
        reportMsg: finalGet.terminal?.report?.msg ?? null,
        nowMs: finalNowMs,
      });
      if (!finalStillActive) {
        recordOutcome(entry, "skipped-replied", "Rate-limit banner no longer active on screen", finalNowMs);
        return { sent: false, outcome: "skipped-replied" };
      }
    }

    // 4. Synchronous atomic exclusive claim across instances + publish "resuming" BEFORE `hc send`!
    if (!acquireExclusiveClaim(entry, episodeKey, now())) {
      const idx = state.queue.indexOf(entry);
      if (idx !== -1 && state.claims[claimKey]?.owner && state.claims[claimKey].owner !== instanceId) {
        state.queue.splice(idx, 1);
      }
      return { sent: false, outcome: "cancelled" };
    }

    // Use atomic `--if idle` when terminal reports `idle`. For `done`/`error` terminals
    // (`hc send --if` only accepts `idle|working`), fire immediately after `finalGet` without `--force`
    // so `blocked` terminals are still atomically refused by herdr-core.
    const sendArgs =
      finalValid.status === "idle"
        ? ["send", "--if", "idle", entry.address, DEFAULT_PROMPT]
        : ["send", entry.address, DEFAULT_PROMPT];

    let sendRes;
    let sendTimedOut = false;
    try {
      // Record attempt only once `hc send` actually starts running so pre-send crashes recover after claim TTL.
      entry.attempts += 1;
      recordEpisodeAttempt(episodeKey);
      sendRes = await runHc(sendArgs, {
        opKey: `${entry.address}:send`,
        timeoutMs: hcSendTimeoutMs,
        after: afterFn,
        address: entry.address,
      });
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/timed out/i.test(msg)) {
        sendTimedOut = true;
      }
      sendRes = { code: 1, stdout: "", stderr: msg };
    }

    if (closed) return { sent: false, outcome: "cancelled" };

    const doneAtMs = now();
    const label = AGENT_LABELS[entry.agent] ?? entry.agent;
    releaseOwnClaim(claimKey);

    if (sendRes && sendRes.code === 0) {
      recordTerminalCooldown(entry.address, doneAtMs);
      recordOutcome(entry, "resumed", entry.reason, doneAtMs);
      notify({
        title: `Resumed ${label}`,
        body: entry.title || entry.address,
        level: "info",
      });
      publish(true);
      return { sent: true, outcome: "resumed" };
    }

    if (sendTimedOut) {
      const timeoutDetail = "hc send timed out (delivery uncertain; not retrying)";
      recordTerminalCooldown(entry.address, doneAtMs);
      recordOutcome(entry, "failed", timeoutDetail, doneAtMs);
      notify({
        title: `Resume timed out for ${label}`,
        body: `${entry.title || entry.address}: ${timeoutDetail}`,
        level: "warning",
      });
      publish(true);
      return { sent: false, outcome: "failed" };
    }

    const errDetail = (sendRes?.stderr || sendRes?.stdout || "hc send failed").trim();
    if (/status_mismatch/i.test(errDetail)) {
      recordOutcome(entry, "skipped-busy", errDetail, doneAtMs);
      publish(true);
      return { sent: false, outcome: "skipped-busy" };
    }

    recordOutcome(entry, "failed", errDetail, doneAtMs);
    notify({
      title: `Couldn't resume ${label}`,
      body: `${entry.title || entry.address}: ${errDetail}`,
      level: "error",
    });
    publish(true);
    return { sent: false, outcome: "failed" };
  }

  async function fireReadyEntries(nowMs, sleepFn, afterFn = defaultAfter) {
    if (closed) return;
    drainPendingSyncCommand();
    syncFromShared(nowMs);
    if (closed || !state.enabled) return;

    const ready = state.queue
      .filter((e) => e.status === "waiting" && state.settings.agents[e.agent] && e.resumeAtMs <= nowMs)
      .sort((a, b) => a.resumeAtMs - b.resumeAtMs);

    let sentInBatch = 0;
    for (const entry of ready) {
      if (closed) return;
      drainPendingSyncCommand();
      syncFromShared(now());
      if (closed || !state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
        continue;
      }
      if (sentInBatch > 0) {
        await sleepFn(STAGGER_MS);
        if (closed) return;
        drainPendingSyncCommand();
        syncFromShared(now());
        if (closed || !state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
          continue;
        }
      } else if (lastResumeSentAtMs > 0) {
        const elapsed = now() - lastResumeSentAtMs;
        if (elapsed >= 0 && elapsed < STAGGER_MS) {
          await sleepFn(STAGGER_MS - elapsed);
          if (closed) return;
          drainPendingSyncCommand();
          syncFromShared(now());
          if (closed || !state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
            continue;
          }
        }
      }
      const res = await fireEntry(entry, afterFn);
      if (closed) return;
      if (res.sent) {
        sentInBatch += 1;
        lastResumeSentAtMs = now();
      }
    }
  }

  async function processCommand(rawCmd, { after: cmdAfter } = {}) {
    if (closed) return false;
    const afterFn = typeof cmdAfter === "function" ? cmdAfter : defaultAfter;
    const cmd = parseCommand(rawCmd);
    if (!cmd) return false;
    if (cmd.id === state.lastHandledCommandId) return false;

    if (isSyncCommand(cmd)) {
      return applySyncCommand(cmd);
    }

    state.lastHandledCommandId = cmd.id;
    const atMs = now();

    if (cmd.action === "resume-now") {
      const entry = state.queue.find((e) => e.address === cmd.address);
      if (!state.enabled) {
        publish(true);
        return true;
      }
      if (entry && isEntryExpired(entry, atMs)) {
        recordOutcome(entry, "cancelled", "Expired after reset window passed", atMs);
        publish(true);
        return true;
      }
      publish(true);
      if (entry && entry.status !== "resuming") {
        await fireEntry(entry, afterFn, { manual: true });
        if (closed) return false;
        publish(true);
      }
      return true;
    }

    publish(true);
    return true;
  }

  async function tick({ sleep: tickSleep, after: tickAfter } = {}) {
    if (closed) return cloneState(state);
    const sleepFn = tickSleep ?? defaultSleep;
    const afterFn = typeof tickAfter === "function" ? tickAfter : defaultAfter;

    // 0. Sync any cross-instance shared state first.
    syncFromShared(now());

    // 1. Handle any pending UI command first.
    const pendingCmd = env.shared(COMMAND_KEY);
    if (pendingCmd) {
      await processCommand(pendingCmd, { after: afterFn });
      if (closed) return cloneState(state);
    }

    const nowMs = now();
    const liveTerminals = env.terminals() ?? [];
    const paneList = getPanes() ?? [];
    const spaceList = getSpaces() ?? [];

    // 2. Drop expired entries so re-enabling after hours/days never fires stale resumes.
    expireStaleQueueEntries(nowMs);

    // 3. Reconcile existing queue against live terminals (closed, shell, switched, replied).
    reconcileQueueWithTerminals(liveTerminals, paneList, spaceList, nowMs);

    // 4. Scan eligible idle/done/error agent terminals for new rate-limit hits.
    await scanCandidates(liveTerminals, paneList, spaceList, nowMs, afterFn);
    if (closed) return cloneState(state);

    // 5. Reconcile local queued entries against live `usage-limits.state` (deferral & early recovery).
    reconcileQueueWithUsageLimits(nowMs);

    // 6. Fire ready entries with strict guardrails and 2000ms staggering.
    await fireReadyEntries(now(), sleepFn, afterFn);
    if (closed) return cloneState(state);

    // 7. Publish updated shared state if changed.
    publish(false);
    return cloneState(state);
  }

  return {
    tick,
    processCommand,
    applySyncCommand,
    publish,
    close,
    isClosed,
    getState: () => cloneState(state),
  };
}
