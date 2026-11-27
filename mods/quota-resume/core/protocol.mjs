// Shared state & command contract between quota-resume (daemon) and insights (UI).
// Pure ESM — runs under both Herdr (gpui-shell) and Node.js tests.

export const STATE_KEY = "quota-resume.state";
export const COMMAND_KEY = "quota-resume.command";
export const USAGE_LIMITS_STATE_KEY = "usage-limits.state";

export const PROTOCOL_VERSION = 1;
export const HISTORY_LIMIT = 50;
export const DEFAULT_DELAY_SEC = 60;
export const MAX_DELAY_SEC = 3600;
export const DEFAULT_PROMPT = "The usage limit has reset. Continue from where you left off.";
export const MAX_HANDLED_FINGERPRINTS = 64;
export const MAX_HANDLED_BANNERS = 64;
export const MAX_PROMOTED_EPISODES = 64;
export const MAX_EPISODE_ATTEMPTS_KEYS = 64;
export const MAX_TERMINAL_COOLDOWNS = 64;
export const MAX_CANCEL_EPOCHS = 64;
export const MAX_CLAIMS = 32;
export const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_STALE_SEND_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours past resetsAtMs
export const MAX_QUEUE_HARD_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days sanity cap
export const MAX_RESTORED_ATTEMPTS = 10;

export const SUPPORTED_AGENTS = ["claude", "codex", "opencode"];
export const VALID_QUEUE_STATUSES = new Set(["waiting", "resuming", "paused"]);
export const VALID_RESET_SOURCES = new Set(["transcript", "screen", "quota"]);
export const VALID_OUTCOMES = new Set([
  "resumed",
  "skipped-replied",
  "skipped-closed",
  "skipped-busy",
  "skipped-session",
  "cancelled",
  "failed",
]);
export const VALID_ACTIONS = new Set([
  "toggle-enabled",
  "toggle-agent",
  "cancel",
  "resume-now",
  "clear-history",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function machineOf(address) {
  if (typeof address !== "string") return null;
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

export function stableHash(input) {
  const s = String(input ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function defaultSettings() {
  return {
    delaySec: DEFAULT_DELAY_SEC,
    agents: { claude: true, codex: true, opencode: true },
    prompt: DEFAULT_PROMPT,
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const delaySec =
    typeof raw.delaySec === "number" && Number.isFinite(raw.delaySec) && raw.delaySec >= 0
      ? Math.min(Math.floor(raw.delaySec), MAX_DELAY_SEC)
      : base.delaySec;
  const rawAgents = raw.agents && typeof raw.agents === "object" ? raw.agents : {};
  const agents = {
    claude: typeof rawAgents.claude === "boolean" ? rawAgents.claude : base.agents.claude,
    codex: typeof rawAgents.codex === "boolean" ? rawAgents.codex : base.agents.codex,
    opencode: typeof rawAgents.opencode === "boolean" ? rawAgents.opencode : base.agents.opencode,
  };
  // Never trust arbitrary persisted prompt overrides from shared state.
  return { delaySec, agents, prompt: DEFAULT_PROMPT };
}

export function isEntryExpired(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== "object") return true;
  if (!Number.isFinite(entry.resetsAtMs) || !Number.isFinite(entry.detectedAtMs)) return true;
  if (nowMs - entry.resetsAtMs > MAX_STALE_SEND_AGE_MS) return true;
  if (nowMs - entry.detectedAtMs > MAX_QUEUE_HARD_AGE_MS) return true;
  return false;
}

export function normalizeQueueEntry(
  raw,
  nowMs = Date.now(),
  { delaySec = DEFAULT_DELAY_SEC, promotedSet = null } = {},
) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.address !== "string" || !raw.address) return null;
  if (machineOf(raw.address) !== null) return null;
  if (!SUPPORTED_AGENTS.includes(raw.agent)) return null;
  if (raw.resetSource === "fallback") return null;
  if (typeof raw.resetsAtMs !== "number" || !Number.isFinite(raw.resetsAtMs)) return null;
  if (typeof raw.resumeAtMs !== "number" || !Number.isFinite(raw.resumeAtMs)) return null;
  if (typeof raw.errorFingerprint !== "string" || !raw.errorFingerprint) return null;
  const detectedAtMs =
    typeof raw.detectedAtMs === "number" && Number.isFinite(raw.detectedAtMs)
      ? raw.detectedAtMs
      : nowMs;
  if (nowMs - raw.resetsAtMs > MAX_STALE_SEND_AGE_MS) return null;
  if (nowMs - detectedAtMs > MAX_QUEUE_HARD_AGE_MS) return null;
  const status = VALID_QUEUE_STATUSES.has(raw.status) ? raw.status : "waiting";
  const attempts =
    typeof raw.attempts === "number" && Number.isFinite(raw.attempts) && raw.attempts >= 0
      ? Math.min(Math.floor(raw.attempts), MAX_RESTORED_ATTEMPTS)
      : 0;
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null;
  const transcriptUuid =
    raw.agent === "claude" && isUuid(sessionId) && isUuid(raw.transcriptUuid)
      ? raw.transcriptUuid
      : null;
  let resetSource = VALID_RESET_SOURCES.has(raw.resetSource) ? raw.resetSource : "screen";
  if (resetSource === "transcript" && !transcriptUuid) {
    resetSource = "screen";
  }
  const sawExhausted = Boolean(raw.sawExhausted);
  const exhaustedObservedAtMs =
    typeof raw.exhaustedObservedAtMs === "number" && Number.isFinite(raw.exhaustedObservedAtMs)
      ? raw.exhaustedObservedAtMs
      : null;
  const promoKey = `${raw.address}:${Math.floor(raw.resetsAtMs / 60_000)}`;
  const earlyPromoted = Boolean(
    raw.earlyPromoted &&
      sawExhausted &&
      exhaustedObservedAtMs != null &&
      (!promotedSet || promotedSet.has(promoKey)),
  );
  const minResumeAtMs = raw.resetsAtMs + delaySec * 1000;
  const resumeAtMs = earlyPromoted ? raw.resumeAtMs : Math.max(raw.resumeAtMs, minResumeAtMs);
  return {
    address: raw.address,
    machine: typeof raw.machine === "string" && raw.machine ? raw.machine : machineOf(raw.address),
    agent: raw.agent,
    provider: SUPPORTED_AGENTS.includes(raw.provider) ? raw.provider : raw.agent,
    sessionId,
    transcriptUuid,
    title: typeof raw.title === "string" && raw.title ? raw.title : raw.address,
    where: typeof raw.where === "string" && raw.where ? raw.where : null,
    detectedAtMs,
    resetsAtMs: raw.resetsAtMs,
    resumeAtMs,
    resetSource,
    reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "rate limit",
    errorTurn: typeof raw.errorTurn === "number" && Number.isFinite(raw.errorTurn) ? raw.errorTurn : null,
    errorStatusMs:
      typeof raw.errorStatusMs === "number" && Number.isFinite(raw.errorStatusMs)
        ? raw.errorStatusMs
        : null,
    isAbsoluteTimeOfDay: Boolean(raw.isAbsoluteTimeOfDay),
    errorFingerprint: raw.errorFingerprint,
    episodeKey: typeof raw.episodeKey === "string" && raw.episodeKey ? raw.episodeKey : null,
    matchedLine: typeof raw.matchedLine === "string" && raw.matchedLine ? raw.matchedLine : null,
    matchedSnippet:
      typeof raw.matchedSnippet === "string" && raw.matchedSnippet ? raw.matchedSnippet : null,
    // Reset any stale mid-flight "resuming" entry across restarts back to "waiting"
    status: status === "resuming" ? "waiting" : status,
    attempts,
    getFailures:
      typeof raw.getFailures === "number" && Number.isFinite(raw.getFailures) && raw.getFailures >= 0
        ? Math.min(Math.floor(raw.getFailures), 100)
        : 0,
    transcriptFailures:
      typeof raw.transcriptFailures === "number" &&
      Number.isFinite(raw.transcriptFailures) &&
      raw.transcriptFailures >= 0
        ? Math.min(Math.floor(raw.transcriptFailures), 100)
        : 0,
    screenFailures:
      typeof raw.screenFailures === "number" &&
      Number.isFinite(raw.screenFailures) &&
      raw.screenFailures >= 0
        ? Math.min(Math.floor(raw.screenFailures), 100)
        : 0,
    sawExhausted,
    exhaustedObservedAtMs,
    earlyPromoted,
    lastCheckMs:
      typeof raw.lastCheckMs === "number" && Number.isFinite(raw.lastCheckMs)
        ? raw.lastCheckMs
        : nowMs,
  };
}

export function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.address !== "string" || !raw.address) return null;
  if (!SUPPORTED_AGENTS.includes(raw.agent)) return null;
  if (!VALID_OUTCOMES.has(raw.outcome)) return null;
  const atMs = typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : 0;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `${atMs}-${raw.address}`,
    address: raw.address,
    machine: typeof raw.machine === "string" && raw.machine ? raw.machine : machineOf(raw.address),
    agent: raw.agent,
    title: typeof raw.title === "string" && raw.title ? raw.title : raw.address,
    outcome: raw.outcome,
    detail: typeof raw.detail === "string" ? raw.detail : "",
    atMs,
  };
}

function normalizeStringSetList(raw, limit) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

function normalizeNumberMap(raw, limit, { minValue = 0 } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!k || typeof v !== "number" || !Number.isFinite(v) || v < minValue) continue;
    entries.push([k, v]);
  }
  const trimmed = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return Object.fromEntries(trimmed);
}

function normalizeStringMap(raw, limit) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!k || typeof v !== "string" || !v) continue;
    entries.push([k, v]);
  }
  const trimmed = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return Object.fromEntries(trimmed);
}

function normalizeHandledBanners(raw, limit) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [addr, v] of Object.entries(raw)) {
    if (!addr || !v || typeof v !== "object") continue;
    if (typeof v.bannerKey !== "string" || !v.bannerKey) continue;
    if (typeof v.handledAtMs !== "number" || !Number.isFinite(v.handledAtMs)) continue;
    entries.push([
      addr,
      {
        bannerKey: v.bannerKey,
        turn: typeof v.turn === "number" && Number.isFinite(v.turn) ? v.turn : null,
        statusMs: typeof v.statusMs === "number" && Number.isFinite(v.statusMs) ? v.statusMs : null,
        resetsAtMs:
          typeof v.resetsAtMs === "number" && Number.isFinite(v.resetsAtMs) ? v.resetsAtMs : null,
        handledAtMs: v.handledAtMs,
        cancelled: Boolean(v.cancelled),
      },
    ]);
  }
  const trimmed = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return Object.fromEntries(trimmed);
}

function normalizeClaims(raw, limit, nowMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [key, v] of Object.entries(raw)) {
    if (!key || !v || typeof v !== "object") continue;
    if (typeof v.owner !== "string" || !v.owner) continue;
    if (typeof v.atMs !== "number" || !Number.isFinite(v.atMs)) continue;
    if (nowMs - v.atMs > CLAIM_TTL_MS) continue;
    entries.push([key, { owner: v.owner, atMs: v.atMs }]);
  }
  const trimmed = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return Object.fromEntries(trimmed);
}

export function defaultState(nowMs = Date.now()) {
  return {
    version: PROTOCOL_VERSION,
    enabled: false,
    updatedAtMs: nowMs,
    lastHandledCommandId: null,
    settings: defaultSettings(),
    queue: [],
    history: [],
    handledFingerprints: [],
    handledBanners: {},
    promotedEpisodes: [],
    episodeAttempts: {},
    terminalCooldowns: {},
    cancelEpochs: {},
    cancelledSignatures: {},
    claims: {},
  };
}

export function normalizeState(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object") return defaultState(nowMs);
  const settings = normalizeSettings(raw.settings);
  const promotedEpisodes = normalizeStringSetList(raw.promotedEpisodes, MAX_PROMOTED_EPISODES);
  const promotedSet = new Set(promotedEpisodes);
  const queue = Array.isArray(raw.queue)
    ? raw.queue
        .map((e) => normalizeQueueEntry(e, nowMs, { delaySec: settings.delaySec, promotedSet }))
        .filter(Boolean)
    : [];
  const history = Array.isArray(raw.history)
    ? raw.history.map(normalizeHistoryEntry).filter(Boolean).slice(0, HISTORY_LIMIT)
    : [];
  return {
    version: PROTOCOL_VERSION,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    updatedAtMs:
      typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
        ? raw.updatedAtMs
        : nowMs,
    lastHandledCommandId:
      typeof raw.lastHandledCommandId === "string" && raw.lastHandledCommandId
        ? raw.lastHandledCommandId
        : null,
    settings,
    queue,
    history,
    handledFingerprints: normalizeStringSetList(raw.handledFingerprints, MAX_HANDLED_FINGERPRINTS),
    handledBanners: normalizeHandledBanners(raw.handledBanners, MAX_HANDLED_BANNERS),
    promotedEpisodes,
    episodeAttempts: normalizeNumberMap(raw.episodeAttempts, MAX_EPISODE_ATTEMPTS_KEYS),
    terminalCooldowns: normalizeNumberMap(raw.terminalCooldowns, MAX_TERMINAL_COOLDOWNS, {
      minValue: Math.max(0, nowMs - 10 * 60 * 1000),
    }),
    cancelEpochs: normalizeNumberMap(raw.cancelEpochs, MAX_CANCEL_EPOCHS),
    cancelledSignatures: normalizeStringMap(raw.cancelledSignatures, MAX_CANCEL_EPOCHS),
    claims: normalizeClaims(raw.claims, MAX_CLAIMS, nowMs),
  };
}

export function appendHistory(history, entry, limit = HISTORY_LIMIT) {
  const next = [entry, ...(Array.isArray(history) ? history : [])];
  return next.slice(0, limit);
}

export function parseCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== PROTOCOL_VERSION) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action)) return null;

  if (raw.action === "cancel" || raw.action === "resume-now") {
    if (typeof raw.address !== "string" || !raw.address.trim()) return null;
    return {
      version: PROTOCOL_VERSION,
      id: raw.id,
      action: raw.action,
      address: raw.address,
      atMs: typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : Date.now(),
    };
  }

  if (raw.action === "toggle-agent") {
    if (!SUPPORTED_AGENTS.includes(raw.agent)) return null;
    return {
      version: PROTOCOL_VERSION,
      id: raw.id,
      action: raw.action,
      agent: raw.agent,
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      atMs: typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : Date.now(),
    };
  }

  if (raw.action === "toggle-enabled") {
    return {
      version: PROTOCOL_VERSION,
      id: raw.id,
      action: raw.action,
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      atMs: typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : Date.now(),
    };
  }

  // clear-history
  return {
    version: PROTOCOL_VERSION,
    id: raw.id,
    action: raw.action,
    atMs: typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : Date.now(),
  };
}
