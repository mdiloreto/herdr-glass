// Core daemon engine for quota-resume.
// Pure dependency-injected ESM — runs under both Herdr (gpui-shell) and Node.js tests.

import {
  COMMAND_KEY,
  DEFAULT_PROMPT,
  STATE_KEY,
  SUPPORTED_AGENTS,
  USAGE_LIMITS_STATE_KEY,
  appendHistory,
  isUuid,
  machineOf,
  normalizeState,
  parseCommand,
} from "./protocol.mjs";
import { detectScreenRateLimit, extractScreenText } from "./screen.mjs";
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
export const MAX_COMPLETED_FINGERPRINTS = 500;

const IDLE_STATES = new Set(["idle", "done", "error"]);
const SHELL_RE = /^-?(?:zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|nushell|pwsh|powershell|cmd)(?:\.exe)?$/i;

const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function isShellName(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  const base = name.trim().replace(/\\/g, "/").split("/").pop();
  return SHELL_RE.test(base);
}

function mapTokenToAgent(raw) {
  if (typeof raw !== "string") return null;
  const base = raw.trim().replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "");
  if (!base) return null;
  if (base === "claude-code" || base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "opencode") return "opencode";
  return null;
}

export function identifyAgent(terminal) {
  if (!terminal || typeof terminal !== "object") return null;

  const candidates = [
    terminal.report?.app,
    typeof terminal.status === "object" ? terminal.status?.app : null,
    terminal.program?.key,
    terminal.foreground?.name,
  ];
  for (const c of candidates) {
    const mapped = mapTokenToAgent(c);
    if (mapped) return mapped;
  }

  if (Array.isArray(terminal.argv)) {
    for (const arg of terminal.argv) {
      if (typeof arg !== "string" || arg.startsWith("-")) continue;
      const mapped = mapTokenToAgent(arg);
      if (mapped) return mapped;
    }
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

function selectConstrainedWindows(windows, reason) {
  const r = String(reason ?? "").toLowerCase();
  if (/five[_ -]?hour|5h\b|session/.test(r)) {
    const matched = windows.filter((w) => /session|5h|5-hour|primary/i.test(`${w.id} ${w.short} ${w.long}`));
    if (matched.length) return matched;
  }
  if (/seven[_ -]?day|weekly|7d\b/.test(r)) {
    const matched = windows.filter((w) => /week|wk|7d|secondary/i.test(`${w.id} ${w.short} ${w.long}`));
    if (matched.length) return matched;
  }
  return windows;
}

/**
 * Resolves a future reset timestamp from `shared("usage-limits.state")` when an agent
 * hits a limit without an explicit timestamp in its banner.
 */
export function resolveQuotaResetFromUsage(usageState, provider, { bannerText = "", nowMs = Date.now() } = {}) {
  const providersToTry = [provider];
  if (provider === "opencode") {
    if (/anthropic|claude/i.test(bannerText)) providersToTry.push("claude");
    else if (/openai|codex|chatgpt/i.test(bannerText)) providersToTry.push("codex");
    else providersToTry.push("claude", "codex");
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
 * - Promote to ready now if a fresh reading observed after `detectedAtMs` dropped to <100%
 *   for the constrained window (with no other window exhausted).
 */
export function evaluateQuotaForEntry(entry, usageState, nowMs, delaySec) {
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

  // 2. Early recovery: fresh reading observed strictly after detectedAtMs shows constrained window < 100%
  //    and no window at >= 100%.
  if (observedAtMs > entry.detectedAtMs && exhausted.length === 0) {
    const constrained = selectConstrainedWindows(windows, entry.reason);
    const allRecovered =
      constrained.length > 0 && constrained.every((w) => Number.isFinite(w.percentNum) && w.percentNum < 100);
    if (allRecovered) {
      return { action: "promote" };
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
    pane?.name?.trim() ||
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
      prompt: state.settings.prompt,
    },
    queue: state.queue.map((e) => ({ ...e })),
    history: state.history.map((h) => ({ ...h })),
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
  });
}

export function createEngine(env) {
  const now = env.now ?? (() => Date.now());
  const defaultSleep = env.sleep ?? (() => Promise.resolve());
  const log = env.log ?? (() => {});
  const notify = env.notify ?? (() => {});
  const getPanes = env.panes ?? (() => []);
  const getSpaces = env.spaces ?? (() => []);

  const state = normalizeState(env.shared(STATE_KEY), now());
  const lastInspected = new Map();
  const completedFingerprints = new Set();
  let lastPublishedKey = null;
  let lastResumeSentAtMs = 0;

  function rememberFingerprint(fp) {
    if (!fp) return;
    if (completedFingerprints.has(fp)) {
      completedFingerprints.delete(fp);
    }
    completedFingerprints.add(fp);
    while (completedFingerprints.size > MAX_COMPLETED_FINGERPRINTS) {
      const oldest = completedFingerprints.values().next().value;
      completedFingerprints.delete(oldest);
    }
  }

  function publish(force = false) {
    const key = stateComparableKey(state);
    if (!force && key === lastPublishedKey) return false;
    state.updatedAtMs = now();
    lastPublishedKey = key;
    env.setShared(STATE_KEY, cloneState(state));
    return true;
  }

  function recordOutcome(entry, outcome, detail, atMs) {
    const idx = state.queue.findIndex((q) => q.address === entry.address);
    if (idx !== -1) state.queue.splice(idx, 1);
    rememberFingerprint(entry.errorFingerprint);
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

  async function readTranscriptTail(sessionId, machine) {
    const args = buildTranscriptExecArgs(sessionId);
    if (!args) return null;
    try {
      const res = await env.exec("sh", args, { on: machine, timeout: TRANSCRIPT_TIMEOUT_MS });
      if (res && res.code === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
        return parseTranscriptTail(res.stdout);
      }
      return null;
    } catch {
      return null;
    }
  }

  async function readTerminalScreen(address) {
    try {
      const res = await env.hc(["read", address, "--lines", "40"]);
      if (!res || res.code !== 0) return "";
      return extractScreenText(res);
    } catch {
      return "";
    }
  }

  async function detectRateLimitForTerminal(terminal, agent, nowMs) {
    const machine = machineOf(terminal.address);
    const sessionId = agent === "claude" ? (terminal.labels?.["claude.session"] ?? null) : null;
    const usageState = machine === null ? env.shared(USAGE_LIMITS_STATE_KEY) : null;

    if (agent === "claude" && sessionId && isUuid(sessionId)) {
      const entries = await readTranscriptTail(sessionId, machine);
      if (entries !== null && entries.length > 0) {
        const found = findActiveQuotaError(entries, nowMs);
        if (!found) {
          // Definitive transcript read with no active quota error -> do not scrape chat prose.
          return null;
        }
        return {
          resetsAtMs: found.resetsAtMs,
          resetSource: "transcript",
          reason: found.reason,
          errorFingerprint: found.uuid,
          sessionId,
        };
      }
    }

    // Screen banner detection (Claude fallback when transcript unavailable, Codex, OpenCode).
    const screenText = await readTerminalScreen(terminal.address);
    const detected = detectScreenRateLimit({
      agent,
      text: screenText,
      reportMsg: terminal.report?.msg ?? null,
      nowMs,
    });
    if (!detected) return null;

    let resetsAtMs = detected.resetsAtMs;
    let resetSource = "screen";

    if (resetsAtMs == null) {
      if (machine === null) {
        const fromQuota = resolveQuotaResetFromUsage(usageState, agent, {
          bannerText: detected.matchedLine,
          nowMs,
        });
        if (fromQuota) {
          resetsAtMs = fromQuota.resetsAtMs;
          resetSource = "quota";
        }
      }
      if (resetsAtMs == null) {
        resetsAtMs = nowMs + FALLBACK_WAIT_MS;
        resetSource = "fallback";
      }
    }

    return {
      resetsAtMs,
      resetSource,
      reason: detected.reason,
      errorFingerprint: detected.fingerprint,
      sessionId,
    };
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
      const decision = evaluateQuotaForEntry(entry, usageState, nowMs, state.settings.delaySec);
      if (!decision) continue;
      if (decision.action === "defer") {
        entry.resetsAtMs = decision.resetsAtMs;
        entry.resumeAtMs = decision.resumeAtMs;
        entry.resetSource = "quota";
      } else if (decision.action === "promote") {
        if (entry.resumeAtMs > nowMs) {
          entry.resumeAtMs = nowMs;
        }
      }
    }
  }

  async function scanCandidates(liveTerminals, paneList, spaceList, nowMs) {
    if (!state.enabled) return;

    const liveAddrs = new Set(liveTerminals.map((t) => t.address));
    for (const addr of [...lastInspected.keys()]) {
      if (!liveAddrs.has(addr)) lastInspected.delete(addr);
    }

    const queuedAddrs = new Set(state.queue.map((e) => e.address));

    for (const t of liveTerminals) {
      if (!isCandidateTerminal(t)) {
        lastInspected.delete(t.address);
        continue;
      }
      const agent = identifyAgent(t);
      if (!agent || !state.settings.agents[agent]) continue;
      if (queuedAddrs.has(t.address)) continue;

      const sig = inspectionSignature(t);
      if (lastInspected.get(t.address) === sig) continue;
      lastInspected.set(t.address, sig);

      const detected = await detectRateLimitForTerminal(t, agent, nowMs);
      if (!detected) continue;
      if (!state.enabled || !state.settings.agents[agent]) continue;

      // Reject stale errors whose reset time has already passed (avoid infinite retry loops).
      if (!Number.isFinite(detected.resetsAtMs) || detected.resetsAtMs <= nowMs) {
        log(`ignoring past resetsAt for ${t.address} (${detected.resetsAtMs})`);
        continue;
      }
      if (completedFingerprints.has(detected.errorFingerprint)) {
        continue;
      }

      const { title, where } = buildTitleAndWhere(t, paneList, spaceList);
      const entry = {
        address: t.address,
        machine: machineOf(t.address),
        agent,
        provider: agent,
        sessionId: detected.sessionId ?? null,
        title,
        where,
        detectedAtMs: nowMs,
        resetsAtMs: detected.resetsAtMs,
        resumeAtMs: detected.resetsAtMs + state.settings.delaySec * 1000,
        resetSource: detected.resetSource,
        reason: detected.reason,
        errorTurn: typeof t.turn === "number" ? t.turn : null,
        errorFingerprint: detected.errorFingerprint,
        status: "waiting",
        attempts: 0,
        lastCheckMs: nowMs,
      };
      state.queue.push(entry);
      queuedAddrs.add(t.address);
    }
  }

  async function fireEntry(entry) {
    const atMs = now();
    entry.status = "resuming";
    entry.attempts += 1;
    entry.lastCheckMs = atMs;

    // 1. Fresh terminal inspection via `hc get <addr> --json`.
    let fresh = null;
    try {
      const res = await env.hc(["get", entry.address, "--json"]);
      if (res && res.code === 0 && typeof res.stdout === "string") {
        fresh = JSON.parse(res.stdout);
      }
    } catch {
      fresh = null;
    }

    if (!fresh || fresh.state !== "live") {
      recordOutcome(entry, "skipped-closed", "Terminal is no longer live", atMs);
      return { sent: false, outcome: "skipped-closed" };
    }

    // 2. Foreground must still be the expected agent (never a bare shell or different agent).
    if (fresh.program?.shell || isShellName(fresh.foreground?.name)) {
      recordOutcome(entry, "skipped-session", "Terminal foreground is a shell", atMs);
      return { sent: false, outcome: "skipped-session" };
    }
    const freshAgent = identifyAgent(fresh);
    if (freshAgent !== entry.agent) {
      recordOutcome(
        entry,
        "skipped-session",
        `Expected ${entry.agent} in foreground, found ${freshAgent ?? fresh.foreground?.name ?? "unknown"}`,
        atMs,
      );
      return { sent: false, outcome: "skipped-session" };
    }

    // 3. Claude session label must match.
    if (entry.agent === "claude" && entry.sessionId) {
      const liveSession = fresh.labels?.["claude.session"] ?? null;
      if (liveSession !== entry.sessionId) {
        recordOutcome(entry, "skipped-session", "Claude session label changed", atMs);
        return { sent: false, outcome: "skipped-session" };
      }
    }

    // 4. Status state must be idle, done, or error (never working or blocked).
    const freshStatus = terminalStatusWord(fresh);
    if (!IDLE_STATES.has(freshStatus)) {
      recordOutcome(entry, "skipped-busy", `Terminal is ${freshStatus ?? "busy"}`, atMs);
      return { sent: false, outcome: "skipped-busy" };
    }

    // 5. Turn must not have advanced since error detection.
    if (entry.errorTurn != null && typeof fresh.turn === "number" && fresh.turn !== entry.errorTurn) {
      recordOutcome(entry, "skipped-replied", "Session turn advanced since error", atMs);
      return { sent: false, outcome: "skipped-replied" };
    }

    // 6. Claude transcript re-check: verify no non-error assistant reply occurred after the error.
    if (entry.agent === "claude" && entry.sessionId && isUuid(entry.sessionId)) {
      const entries = await readTranscriptTail(entry.sessionId, entry.machine);
      if (entries !== null && entries.length > 0) {
        const replied = isUuid(entry.errorFingerprint)
          ? hasAssistantReplySince(entries, entry.errorFingerprint)
          : hasAssistantReplyAfterTime(entries, entry.detectedAtMs);
        if (replied) {
          recordOutcome(entry, "skipped-replied", "Claude already replied since the error", atMs);
          return { sent: false, outcome: "skipped-replied" };
        }
      }
    }

    // 7. All guardrails passed — send the resume prompt!
    const prompt = state.settings.prompt || DEFAULT_PROMPT;
    let sendRes;
    try {
      sendRes = await env.hc(["send", entry.address, prompt]);
    } catch (e) {
      sendRes = { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    }

    const doneAtMs = now();
    const label = AGENT_LABELS[entry.agent] ?? entry.agent;
    if (sendRes && sendRes.code === 0) {
      recordOutcome(entry, "resumed", entry.reason, doneAtMs);
      notify({
        title: `Resumed ${label}`,
        body: entry.title || entry.address,
        level: "info",
      });
      return { sent: true, outcome: "resumed" };
    }

    const errDetail = (sendRes?.stderr || sendRes?.stdout || "hc send failed").trim();
    recordOutcome(entry, "failed", errDetail, doneAtMs);
    notify({
      title: `Couldn't resume ${label}`,
      body: `${entry.title || entry.address}: ${errDetail}`,
      level: "error",
    });
    return { sent: false, outcome: "failed" };
  }

  async function fireReadyEntries(nowMs, sleepFn) {
    if (!state.enabled) return;

    const ready = state.queue
      .filter((e) => e.status === "waiting" && state.settings.agents[e.agent] && e.resumeAtMs <= nowMs)
      .sort((a, b) => a.resumeAtMs - b.resumeAtMs);

    let sentInBatch = 0;
    for (const entry of ready) {
      // Confirm entry is still in queue (in case a command cancelled it during an await).
      if (!state.queue.includes(entry)) continue;
      if (sentInBatch > 0) {
        await sleepFn(STAGGER_MS);
        if (!state.queue.includes(entry)) continue;
      } else if (lastResumeSentAtMs > 0) {
        const elapsed = now() - lastResumeSentAtMs;
        if (elapsed >= 0 && elapsed < STAGGER_MS) {
          await sleepFn(STAGGER_MS - elapsed);
          if (!state.queue.includes(entry)) continue;
        }
      }
      const res = await fireEntry(entry);
      if (res.sent) {
        sentInBatch += 1;
        lastResumeSentAtMs = now();
      }
    }
  }

  async function processCommand(rawCmd) {
    const cmd = parseCommand(rawCmd);
    if (!cmd) return false;
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

    if (cmd.action === "resume-now") {
      const entry = state.queue.find((e) => e.address === cmd.address);
      publish(true);
      if (entry && entry.status !== "resuming") {
        await fireEntry(entry);
        publish(true);
      }
      return true;
    }

    publish(true);
    return true;
  }

  async function tick({ sleep: tickSleep } = {}) {
    const sleepFn = tickSleep ?? defaultSleep;

    // 1. Handle any pending UI command first.
    const pendingCmd = env.shared(COMMAND_KEY);
    if (pendingCmd) {
      await processCommand(pendingCmd);
    }

    const nowMs = now();
    const liveTerminals = env.terminals() ?? [];
    const paneList = getPanes() ?? [];
    const spaceList = getSpaces() ?? [];

    // 2. Reconcile existing queue against live terminals (closed, shell, switched, replied).
    reconcileQueueWithTerminals(liveTerminals, paneList, spaceList, nowMs);

    // 3. Scan eligible idle/done/error agent terminals for new rate-limit hits.
    await scanCandidates(liveTerminals, paneList, spaceList, nowMs);

    // 4. Reconcile local queued entries against live `usage-limits.state` (deferral & early recovery).
    reconcileQueueWithUsageLimits(nowMs);

    // 5. Fire ready entries with strict guardrails and 2000ms staggering.
    await fireReadyEntries(now(), sleepFn);

    // 6. Publish updated shared state if changed.
    publish(false);
    return cloneState(state);
  }

  return {
    tick,
    processCommand,
    publish,
    getState: () => cloneState(state),
  };
}
