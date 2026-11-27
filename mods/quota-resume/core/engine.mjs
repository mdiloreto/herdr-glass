// Core daemon engine for quota-resume.
// Pure dependency-injected ESM — runs under both Herdr (gpui-shell) and Node.js tests.

import {
  COMMAND_KEY,
  DEFAULT_PROMPT,
  MAX_EPISODE_ATTEMPTS_KEYS,
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
import { detectScreenRateLimit, extractScreenText, hasUnsentDraft } from "./screen.mjs";
import {
  buildTranscriptExecArgs,
  findActiveQuotaError,
  hasAssistantReplyAfterTime,
  hasAssistantReplySince,
  parseTranscriptTail,
  toEpochMs,
} from "./transcript.mjs";

export const DEFAULT_TICK_MS = 15_000;
export const STAGGER_MS = 2_000;
export const FALLBACK_WAIT_MS = 5 * 60 * 1000;
export const TRANSCRIPT_TIMEOUT_MS = 8_000;
export const HC_TIMEOUT_MS = 10_000;
export const SCREEN_READ_LINES = "0";
export const MAX_COMPLETED_FINGERPRINTS = MAX_HANDLED_FINGERPRINTS;
export const TERMINAL_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_EPISODE_ATTEMPTS = 1;
export const MAX_GET_FAILURES = 5;
export const MAX_IO_FAILURES = 5;
export const RETRY_BACKOFF_MS = 30_000;
export const EARLY_RECOVERY_PERCENT_THRESHOLD = 50;

const IDLE_STATES = new Set(["idle", "done", "error"]);
const SHELL_RE = /^-?(?:zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|nushell|pwsh|powershell|cmd)(?:\.exe)?$/i;
const RUNTIME_WRAPPERS = new Set(["node", "bun", "deno", "env", "mise", "npx"]);
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

export function isSyncCommand(cmd) {
  return Boolean(cmd && typeof cmd === "object" && SYNC_COMMAND_ACTIONS.has(cmd.action));
}

export function isShellName(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  const base = name.trim().replace(/\\/g, "/").split("/").pop();
  return SHELL_RE.test(base);
}

function mapTokenToAgent(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = trimmed.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "");
  if (!base) return null;
  if (base === "claude-code" || base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "opencode") return "opencode";
  return null;
}

function mapArgvTokenToAgent(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const direct = mapTokenToAgent(trimmed);
  if (direct) return direct;
  const normalized = trimmed.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)(?:@anthropic-ai\/)?claude-code(?:\/|$)/.test(normalized)) return "claude";
  if (/(?:^|\/)(?:@openai\/)?codex(?:\/|$)/.test(normalized)) return "codex";
  if (/(?:^|\/)(?:opencode-ai\/)?opencode(?:\.exe)?(?:\/|$)/.test(normalized)) return "opencode";
  return null;
}

/**
 * Positively identifies a supported coding agent from the foreground process ONLY
 * (`foreground.name` and `foreground.argv`), allowing known JS/env/mise wrappers
 * only when `foreground.argv` explicitly names the agent binary/package.
 * Never falls back to `report.app`, `status.app`, `program.key`, or outer shell `argv`.
 */
export function identifyForegroundAgent(foreground) {
  if (!foreground || typeof foreground !== "object") return null;
  const name = typeof foreground.name === "string" ? foreground.name.trim() : "";
  if (name) {
    if (isShellName(name)) return null;
    const direct = mapTokenToAgent(name);
    if (direct) return direct;
    const base = name.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "");
    if (!RUNTIME_WRAPPERS.has(base)) {
      return null;
    }
    if (Array.isArray(foreground.argv)) {
      for (const arg of foreground.argv.slice(1)) {
        const mapped = mapArgvTokenToAgent(arg);
        if (mapped) return mapped;
      }
    }
    return null;
  }

  if (Array.isArray(foreground.argv) && foreground.argv.length > 0) {
    const first = typeof foreground.argv[0] === "string" ? foreground.argv[0].trim() : "";
    if (!first || isShellName(first)) return null;
    const direct = mapTokenToAgent(first);
    if (direct) return direct;
    const base = first.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "");
    if (RUNTIME_WRAPPERS.has(base)) {
      for (const arg of foreground.argv.slice(1)) {
        const mapped = mapArgvTokenToAgent(arg);
        if (mapped) return mapped;
      }
    }
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
    const byReset = windows.filter(
      (w) => w.resetsAtMs != null && Math.abs(w.resetsAtMs - entryResetsAtMs) <= 120_000,
    );
    if (byReset.length) return byReset;
  }
  return [];
}

function buildEpisodeKey(entry) {
  if (entry.resetSource !== "fallback" && Number.isFinite(entry.resetsAtMs)) {
    return `${entry.address}:${entry.agent}:${Math.floor(entry.resetsAtMs / 60_000)}`;
  }
  return `${entry.address}:${entry.agent}:${entry.errorFingerprint}`;
}

function promotionEpisodeKey(entry) {
  return `${entry.address}:${Math.floor(entry.resetsAtMs / 60_000)}`;
}

/**
 * Resolves a future reset timestamp from `shared("usage-limits.state")` when an agent
 * hits a limit without an explicit timestamp in its banner.
 */
export function resolveQuotaResetFromUsage(usageState, provider, { bannerText = "", nowMs = Date.now() } = {}) {
  const inferred = inferProvider(provider, bannerText);
  const providersToTry = [];
  if (inferred && !providersToTry.includes(inferred)) providersToTry.push(inferred);
  if (!providersToTry.includes(provider)) providersToTry.push(provider);
  if (provider === "opencode") {
    for (const fallback of ["claude", "codex"]) {
      if (!providersToTry.includes(fallback)) providersToTry.push(fallback);
    }
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
 * - Track whether the constrained window was observed at >=100%.
 * - Promote to ready at most once per `(address, resetsAtMs)` episode ONLY when a specific
 *   constrained window is positively identified, no window is at >=100%, and either:
 *   (a) that window was observed at >=100% earlier and later dropped below 100%, OR
 *   (b) that window's resetsAtMs rolled strictly past entry.resetsAtMs with percent < 100, OR
 *   (c) a fresh reading observed after detectedAtMs shows percent <= 50%.
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
      };
    }
  }

  // Record if the constrained window was positively observed at >=100%.
  if (
    !entry.sawExhausted &&
    constrained.length > 0 &&
    constrained.some((w) => Number.isFinite(w.percentNum) && w.percentNum >= 100)
  ) {
    return { action: "observe-exhausted" };
  }

  // 2. Strict early recovery: require positively identified constrained window, no exhausted windows,
  //    at most one early promotion per (address, resetsAtMs), and real recovery evidence.
  if (observedAtMs > entry.detectedAtMs && exhausted.length === 0 && constrained.length > 0) {
    const promoKey = promotionEpisodeKey(entry);
    const alreadyPromoted = Array.isArray(promotedEpisodes)
      ? promotedEpisodes.includes(promoKey)
      : promotedEpisodes instanceof Set
        ? promotedEpisodes.has(promoKey)
        : false;
    if (alreadyPromoted) return null;

    const allBelow100 = constrained.every((w) => Number.isFinite(w.percentNum) && w.percentNum < 100);
    if (!allBelow100) return null;

    const recoveredFromExhausted = Boolean(entry.sawExhausted);
    const windowRolledPastReset = constrained.every(
      (w) => w.resetsAtMs != null && w.resetsAtMs > entry.resetsAtMs,
    );
    const decisivelyLow = constrained.every((w) => w.percentNum <= EARLY_RECOVERY_PERCENT_THRESHOLD);

    if (recoveredFromExhausted || windowRolledPastReset || decisivelyLow) {
      return { action: "promote", promoKey };
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
    promotedEpisodes: [...state.promotedEpisodes],
    episodeAttempts: { ...state.episodeAttempts },
    terminalCooldowns: { ...state.terminalCooldowns },
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
    promotedEpisodes: state.promotedEpisodes,
    episodeAttempts: state.episodeAttempts,
    terminalCooldowns: state.terminalCooldowns,
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

  const state = normalizeState(env.shared(STATE_KEY), now());
  const lastInspected = new Map();
  let lastPublishedKey = null;
  let lastResumeSentAtMs = 0;

  function rememberFingerprint(fp) {
    addBoundedList(state.handledFingerprints, fp, MAX_HANDLED_FINGERPRINTS);
  }

  function hasHandledFingerprint(fp) {
    return Boolean(fp && state.handledFingerprints.includes(fp));
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

  function publish(force = false) {
    const key = stateComparableKey(state);
    if (!force && key === lastPublishedKey) return false;
    state.updatedAtMs = now();
    lastPublishedKey = key;
    env.setShared(STATE_KEY, cloneState(state));
    return true;
  }

  function recordOutcome(entry, outcome, detail, atMs, { remember = true } = {}) {
    const idx = state.queue.findIndex((q) => q.address === entry.address);
    if (idx !== -1) state.queue.splice(idx, 1);
    if (remember) {
      rememberFingerprint(entry.errorFingerprint);
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
    if (typeof afterFn === "function") {
      const cancel = afterFn(ms, fn);
      return typeof cancel === "function" ? cancel : () => {};
    }
    if (typeof globalThis.setTimeout === "function") {
      const handle = globalThis.setTimeout(fn, ms);
      if (handle && typeof handle.unref === "function") handle.unref();
      return () => {
        if (typeof globalThis.clearTimeout === "function") {
          globalThis.clearTimeout(handle);
        }
      };
    }
    return null;
  }

  async function runHc(args, { timeoutMs = hcTimeoutMs, after = defaultAfter } = {}) {
    let cancelTimeout = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        cancelTimeout = scheduleAfter(
          timeoutMs,
          () => reject(new Error(`hc ${args[0]} timed out`)),
          after,
        );
      });
      if (!cancelTimeout) {
        return await env.hc(args);
      }
      return await Promise.race([env.hc(args), timeoutPromise]);
    } finally {
      if (typeof cancelTimeout === "function") {
        try {
          cancelTimeout();
        } catch {
          // already fired or cancelled
        }
      }
    }
  }

  async function readTranscriptTail(sessionId, machine) {
    const args = buildTranscriptExecArgs(sessionId);
    if (!args) return { ok: true, entries: null, missing: true };
    try {
      const res = await env.exec("sh", args, { on: machine, timeout: TRANSCRIPT_TIMEOUT_MS });
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
      const res = await runHc(["read", address, "--lines", SCREEN_READ_LINES], { after: afterFn });
      if (!res || res.code !== 0) return { ok: false, text: "" };
      return { ok: true, text: extractScreenText(res) };
    } catch {
      return { ok: false, text: "" };
    }
  }

  async function fetchFreshTerminal(address, afterFn = defaultAfter) {
    try {
      const res = await runHc(["get", address, "--json"], { after: afterFn });
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

    // Fail closed on turn check: if we recorded an errorTurn, require fresh.turn to be present and equal.
    if (entry.errorTurn != null) {
      if (typeof fresh.turn !== "number" || !Number.isFinite(fresh.turn)) {
        recordOutcome(entry, "skipped-replied", "Terminal turn unavailable", atMs);
        return { ok: false, outcome: "skipped-replied" };
      }
      if (fresh.turn !== entry.errorTurn) {
        recordOutcome(entry, "skipped-replied", "Session turn advanced since error", atMs);
        return { ok: false, outcome: "skipped-replied" };
      }
    }

    return { ok: true, status: freshStatus };
  }

  function handleTransientGetFailure(entry, atMs) {
    entry.getFailures = (entry.getFailures ?? 0) + 1;
    entry.lastCheckMs = atMs;
    if (entry.getFailures >= MAX_GET_FAILURES) {
      recordOutcome(entry, "skipped-closed", "Terminal unreachable after retries", atMs, { remember: false });
      return { sent: false, outcome: "skipped-closed" };
    }
    entry.resumeAtMs = atMs + RETRY_BACKOFF_MS;
    return { sent: false, outcome: "deferred" };
  }

  function applySyncCommand(rawCmd) {
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
      const entry = state.queue.find((e) => e.address === cmd.address);
      if (entry) {
        recordOutcome(entry, "cancelled", "Cancelled by user", atMs);
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
      const tRes = await readTranscriptTail(sessionId, machine);
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
          },
        };
      }
    }

    // Screen banner detection (Claude fallback when transcript unavailable, Codex, OpenCode).
    const sRes = await readTerminalScreen(terminal.address, afterFn);
    if (!sRes.ok) {
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
      if (resetsAtMs == null) {
        resetsAtMs = nowMs + FALLBACK_WAIT_MS;
        resetSource = "fallback";
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
        entry.episodeKey = buildEpisodeKey(entry);
      } else if (decision.action === "observe-exhausted") {
        entry.sawExhausted = true;
      } else if (decision.action === "promote") {
        rememberPromotedEpisode(decision.promoKey);
        if (entry.resumeAtMs > nowMs) {
          entry.resumeAtMs = nowMs;
        }
      }
    }
  }

  async function scanCandidates(liveTerminals, paneList, spaceList, nowMs, afterFn = defaultAfter) {
    if (!state.enabled) return;

    const liveAddrs = new Set(liveTerminals.map((t) => t.address));
    for (const addr of [...lastInspected.keys()]) {
      if (!liveAddrs.has(addr)) lastInspected.delete(addr);
    }

    const queuedAddrs = new Set(state.queue.map((e) => e.address));

    for (const t of liveTerminals) {
      drainPendingSyncCommand();
      if (!state.enabled) return;

      if (!isCandidateTerminal(t)) {
        lastInspected.delete(t.address);
        continue;
      }
      const agent = identifyAgent(t);
      if (!agent || !state.settings.agents[agent]) continue;
      if (queuedAddrs.has(t.address)) continue;

      const sig = inspectionSignature(t);
      if (lastInspected.get(t.address) === sig) continue;

      const probe = await detectRateLimitForTerminal(t, agent, nowMs, afterFn);
      if (!probe.ok) {
        // Inspection failed (transient read/exec error) -> do NOT cache signature so next tick retries.
        continue;
      }
      lastInspected.set(t.address, sig);

      const detected = probe.detected;
      if (!detected) continue;

      drainPendingSyncCommand();
      if (!state.enabled || !state.settings.agents[agent]) continue;
      if (queuedAddrs.has(t.address)) continue;

      // Reject stale errors whose reset time has already passed (avoid infinite retry loops).
      if (!Number.isFinite(detected.resetsAtMs) || detected.resetsAtMs <= nowMs) {
        log(`ignoring past resetsAt for ${t.address} (${detected.resetsAtMs})`);
        continue;
      }
      if (hasHandledFingerprint(detected.errorFingerprint)) {
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
        errorTurn: typeof t.turn === "number" ? t.turn : null,
        errorFingerprint: detected.errorFingerprint,
        episodeKey: null,
        matchedLine: detected.matchedLine ?? null,
        status: "waiting",
        attempts: 0,
        getFailures: 0,
        transcriptFailures: 0,
        screenFailures: 0,
        sawExhausted: false,
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

  async function fireEntry(entry, afterFn = defaultAfter) {
    drainPendingSyncCommand();
    const atMs = now();

    // 0. Fast synchronous eligibility, expiry, attempt-cap, and cooldown guards.
    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }
    if (isEntryExpired(entry, atMs)) {
      recordOutcome(entry, "cancelled", "Expired after reset window passed", atMs);
      return { sent: false, outcome: "cancelled" };
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

    entry.lastCheckMs = atMs;

    // 1. Fast pre-check via `hc get <addr> --json` (avoids slow remote I/O on dead/wrong-foreground terminals).
    const preGet = await fetchFreshTerminal(entry.address, afterFn);
    if (!preGet.ok) {
      return handleTransientGetFailure(entry, now());
    }
    entry.getFailures = 0;
    const preValid = validateFreshTerminal(preGet.terminal, entry, now());
    if (!preValid.ok) {
      return { sent: false, outcome: preValid.outcome };
    }

    // 2. Slow I/O BEFORE final `hc get` (fail-closed on errors!).
    // 2a. Claude transcript re-check: verify no non-error assistant reply occurred since the error.
    if (entry.agent === "claude" && entry.sessionId && isUuid(entry.sessionId)) {
      const tRes = await readTranscriptTail(entry.sessionId, entry.machine);
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
      const replied = entry.transcriptUuid
        ? hasAssistantReplySince(tRes.entries, entry.transcriptUuid)
        : hasAssistantReplyAfterTime(tRes.entries, entry.detectedAtMs);
      if (replied) {
        recordOutcome(entry, "skipped-replied", "Claude already replied since the error", now());
        return { sent: false, outcome: "skipped-replied" };
      }
    }

    drainPendingSyncCommand();
    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }

    // 2b. Visible screen re-check (`hc read <addr> --lines 0`): unsent draft check (all agents)
    //     and active banner confirmation (screen-detected entries).
    const sRes = await readTerminalScreen(entry.address, afterFn);
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

    if (!entry.transcriptUuid) {
      const stillActive = detectScreenRateLimit({
        agent: entry.agent,
        address: entry.address,
        text: sRes.text,
        reportMsg: preGet.terminal?.report?.msg ?? null,
        nowMs: now(),
      });
      if (!stillActive) {
        recordOutcome(entry, "skipped-replied", "Rate-limit banner no longer active on screen", now());
        return { sent: false, outcome: "skipped-replied" };
      }
    }

    drainPendingSyncCommand();
    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }

    // 3. Final `hc get <addr> --json` LAST right before sending (catches state changes during slow I/O).
    const finalGet = await fetchFreshTerminal(entry.address, afterFn);
    if (!finalGet.ok) {
      return handleTransientGetFailure(entry, now());
    }
    entry.getFailures = 0;
    const finalValid = validateFreshTerminal(finalGet.terminal, entry, now());
    if (!finalValid.ok) {
      return { sent: false, outcome: finalValid.outcome };
    }

    // 4. Final cancel/disable re-check, publish "resuming" BEFORE `hc send`, then send!
    drainPendingSyncCommand();
    if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
      return { sent: false, outcome: "cancelled" };
    }

    entry.status = "resuming";
    entry.attempts += 1;
    entry.lastCheckMs = now();
    recordEpisodeAttempt(episodeKey);
    publish(true);

    const sendArgs =
      finalValid.status === "idle"
        ? ["send", "--if", "idle", entry.address, DEFAULT_PROMPT]
        : ["send", entry.address, DEFAULT_PROMPT];

    let sendRes;
    try {
      sendRes = await runHc(sendArgs, { after: afterFn });
    } catch (e) {
      sendRes = { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    }

    const doneAtMs = now();
    const label = AGENT_LABELS[entry.agent] ?? entry.agent;
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

    const errDetail = (sendRes?.stderr || sendRes?.stdout || "hc send failed").trim();
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
    drainPendingSyncCommand();
    if (!state.enabled) return;

    const ready = state.queue
      .filter((e) => e.status === "waiting" && state.settings.agents[e.agent] && e.resumeAtMs <= nowMs)
      .sort((a, b) => a.resumeAtMs - b.resumeAtMs);

    let sentInBatch = 0;
    for (const entry of ready) {
      drainPendingSyncCommand();
      if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
        continue;
      }
      if (sentInBatch > 0) {
        await sleepFn(STAGGER_MS);
        drainPendingSyncCommand();
        if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
          continue;
        }
      } else if (lastResumeSentAtMs > 0) {
        const elapsed = now() - lastResumeSentAtMs;
        if (elapsed >= 0 && elapsed < STAGGER_MS) {
          await sleepFn(STAGGER_MS - elapsed);
          drainPendingSyncCommand();
          if (!state.enabled || !state.settings.agents[entry.agent] || !state.queue.includes(entry)) {
            continue;
          }
        }
      }
      const res = await fireEntry(entry, afterFn);
      if (res.sent) {
        sentInBatch += 1;
        lastResumeSentAtMs = now();
      }
    }
  }

  async function processCommand(rawCmd, { after: cmdAfter } = {}) {
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
        await fireEntry(entry, afterFn);
        publish(true);
      }
      return true;
    }

    publish(true);
    return true;
  }

  async function tick({ sleep: tickSleep, after: tickAfter } = {}) {
    const sleepFn = tickSleep ?? defaultSleep;
    const afterFn = typeof tickAfter === "function" ? tickAfter : defaultAfter;

    // 1. Handle any pending UI command first.
    const pendingCmd = env.shared(COMMAND_KEY);
    if (pendingCmd) {
      await processCommand(pendingCmd, { after: afterFn });
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

    // 5. Reconcile local queued entries against live `usage-limits.state` (deferral & early recovery).
    reconcileQueueWithUsageLimits(nowMs);

    // 6. Fire ready entries with strict guardrails and 2000ms staggering.
    await fireReadyEntries(now(), sleepFn, afterFn);

    // 7. Publish updated shared state if changed.
    publish(false);
    return cloneState(state);
  }

  return {
    tick,
    processCommand,
    applySyncCommand,
    publish,
    getState: () => cloneState(state),
  };
}
