// Shared state & command contract between quota-resume (daemon) and insights (UI).
// Pure ESM — runs under both Herdr (gpui-shell) and Node.js tests.

export const STATE_KEY = "quota-resume.state";
export const COMMAND_KEY = "quota-resume.command";
export const USAGE_LIMITS_STATE_KEY = "usage-limits.state";

export const PROTOCOL_VERSION = 1;
export const HISTORY_LIMIT = 50;
export const DEFAULT_DELAY_SEC = 60;
export const DEFAULT_PROMPT = "The usage limit has reset. Continue from where you left off.";

export const SUPPORTED_AGENTS = ["claude", "codex", "opencode"];
export const VALID_QUEUE_STATUSES = new Set(["waiting", "resuming", "paused"]);
export const VALID_RESET_SOURCES = new Set(["transcript", "screen", "quota", "fallback"]);
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
      ? Math.floor(raw.delaySec)
      : base.delaySec;
  const rawAgents = raw.agents && typeof raw.agents === "object" ? raw.agents : {};
  const agents = {
    claude: typeof rawAgents.claude === "boolean" ? rawAgents.claude : base.agents.claude,
    codex: typeof rawAgents.codex === "boolean" ? rawAgents.codex : base.agents.codex,
    opencode: typeof rawAgents.opencode === "boolean" ? rawAgents.opencode : base.agents.opencode,
  };
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim().length > 0 ? raw.prompt : base.prompt;
  return { delaySec, agents, prompt };
}

export function normalizeQueueEntry(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.address !== "string" || !raw.address) return null;
  if (!SUPPORTED_AGENTS.includes(raw.agent)) return null;
  if (typeof raw.resetsAtMs !== "number" || !Number.isFinite(raw.resetsAtMs)) return null;
  if (typeof raw.resumeAtMs !== "number" || !Number.isFinite(raw.resumeAtMs)) return null;
  if (typeof raw.errorFingerprint !== "string" || !raw.errorFingerprint) return null;
  const status = VALID_QUEUE_STATUSES.has(raw.status) ? raw.status : "waiting";
  return {
    address: raw.address,
    machine: typeof raw.machine === "string" && raw.machine ? raw.machine : machineOf(raw.address),
    agent: raw.agent,
    provider: SUPPORTED_AGENTS.includes(raw.provider) ? raw.provider : raw.agent,
    sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
    title: typeof raw.title === "string" && raw.title ? raw.title : raw.address,
    where: typeof raw.where === "string" && raw.where ? raw.where : null,
    detectedAtMs:
      typeof raw.detectedAtMs === "number" && Number.isFinite(raw.detectedAtMs)
        ? raw.detectedAtMs
        : nowMs,
    resetsAtMs: raw.resetsAtMs,
    resumeAtMs: raw.resumeAtMs,
    resetSource: VALID_RESET_SOURCES.has(raw.resetSource) ? raw.resetSource : "fallback",
    reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "rate limit",
    errorTurn: typeof raw.errorTurn === "number" && Number.isFinite(raw.errorTurn) ? raw.errorTurn : null,
    errorFingerprint: raw.errorFingerprint,
    // Recover any entry left mid-flight as "resuming" across restarts back to "waiting"
    status: status === "resuming" ? "waiting" : status,
    attempts: typeof raw.attempts === "number" && Number.isFinite(raw.attempts) && raw.attempts >= 0 ? Math.floor(raw.attempts) : 0,
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

export function defaultState(nowMs = Date.now()) {
  return {
    version: PROTOCOL_VERSION,
    enabled: true,
    updatedAtMs: nowMs,
    lastHandledCommandId: null,
    settings: defaultSettings(),
    queue: [],
    history: [],
  };
}

export function normalizeState(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object") return defaultState(nowMs);
  const queue = Array.isArray(raw.queue)
    ? raw.queue.map((e) => normalizeQueueEntry(e, nowMs)).filter(Boolean)
    : [];
  const history = Array.isArray(raw.history)
    ? raw.history.map(normalizeHistoryEntry).filter(Boolean).slice(0, HISTORY_LIMIT)
    : [];
  return {
    version: PROTOCOL_VERSION,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    updatedAtMs:
      typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
        ? raw.updatedAtMs
        : nowMs,
    lastHandledCommandId:
      typeof raw.lastHandledCommandId === "string" && raw.lastHandledCommandId
        ? raw.lastHandledCommandId
        : null,
    settings: normalizeSettings(raw.settings),
    queue,
    history,
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
