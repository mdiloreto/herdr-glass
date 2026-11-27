// Claude Code JSONL transcript inspection (local & fleet via POSIX sh).
// Pure ESM — no Node or Herdr host imports.

import { isUuid, stableHash } from "./protocol.mjs";

export const TAIL_BYTES = 1024 * 1024; // 1 MiB
export const MAX_ERROR_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Safe POSIX sh snippet that takes the validated session UUID as positional arg "$1".
// Never interpolates machine names or session IDs into the script string.
export const TRANSCRIPT_TAIL_SCRIPT = [
  'sid="$1"',
  '[ -n "$sid" ] || exit 1',
  'case "$sid" in */*|*..*) exit 2 ;; esac',
  'found=""',
  'for f in "$HOME"/.claude/projects/*/"$sid.jsonl"; do',
  '  [ -f "$f" ] || continue',
  '  if [ -z "$found" ] || [ "$f" -nt "$found" ]; then found="$f"; fi',
  'done',
  '[ -n "$found" ] || exit 3',
  `tail -c ${TAIL_BYTES} "$found"`,
].join("\n");

/**
 * Builds args for `exec("sh", args, { on: machine, timeout: 8000 })`.
 * Returns null if sessionId is not a valid UUID.
 */
export function buildTranscriptExecArgs(sessionId) {
  if (!isUuid(sessionId)) return null;
  return ["-c", TRANSCRIPT_TAIL_SCRIPT, "quota-resume", sessionId];
}

/**
 * Parses JSONL lines from a transcript tail.
 * Silently skips partial first lines (from `tail -c`) or malformed lines.
 */
export function parseTranscriptTail(text) {
  const out = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Partial or malformed line
    }
  }
  return out;
}

export function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return toEpochMs(n);
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function extractResetMs(entry) {
  if (!entry || typeof entry !== "object") return null;
  const q = entry.quotaLimits ?? null;
  const info = entry.apiErrorParams?.rate_limit_info ?? null;
  const raw = q?.resetsAt ?? info?.resetsAt ?? null;
  return toEpochMs(raw);
}

export function extractTranscriptReason(entry) {
  const q = entry?.quotaLimits ?? null;
  const info = entry?.apiErrorParams?.rate_limit_info ?? null;
  const limitType =
    q?.rateLimitType ||
    q?.rate_limit_type ||
    info?.rateLimitType ||
    info?.rate_limit_type ||
    q?.type ||
    q?.window ||
    null;
  if (typeof limitType === "string" && limitType.trim()) {
    return `${limitType.trim()} rate limit`;
  }
  return "rate limit";
}

/**
 * Scans transcript entries backwards for the most recent active quota error.
 * Returns null if:
 * - A non-error assistant reply occurred after the error
 * - No `isApiErrorMessage` with a `resetsAt` exists
 * - The error is older than `maxAgeMs` and its reset time is already in the past
 */
export function findActiveQuotaError(entries, nowMs = Date.now(), { maxAgeMs = MAX_ERROR_AGE_MS } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;

    // A genuine assistant turn after any earlier API error means the session has moved on.
    if (e.type === "assistant" && !e.isApiErrorMessage) {
      return null;
    }

    if (!e.isApiErrorMessage) continue;
    const resetsAtMs = extractResetMs(e);
    if (resetsAtMs == null) continue;

    const timestampMs = toEpochMs(e.timestamp);
    if (timestampMs != null && nowMs - timestampMs > maxAgeMs && resetsAtMs <= nowMs) {
      return null;
    }

    const rawUuid = typeof e.uuid === "string" && e.uuid.trim() ? e.uuid.trim() : null;
    const uuid = rawUuid ?? `transcript:${stableHash(`${timestampMs ?? ""}:${resetsAtMs}`)}`;

    return {
      uuid,
      transcriptUuid: rawUuid,
      resetsAtMs,
      timestampMs,
      reason: extractTranscriptReason(e),
    };
  }

  return null;
}

/**
 * Verifies that `errorUuid` exists in the transcript tail as a genuine quota API error
 * (`isApiErrorMessage === true` and `extractResetMs(e) != null`) with no subsequent
 * non-error assistant reply.
 */
export function verifyActiveTranscriptError(entries, errorUuid) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  if (typeof errorUuid !== "string" || !errorUuid.trim()) return false;
  const idx = entries.findIndex((e) => e && e.uuid === errorUuid);
  if (idx === -1) return false;
  const errEntry = entries[idx];
  if (!errEntry.isApiErrorMessage || extractResetMs(errEntry) == null) return false;
  for (let i = idx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.type === "assistant" && !e.isApiErrorMessage) return false;
  }
  return true;
}

/**
 * Checks whether the Claude session has produced any non-error assistant reply
 * since the error identified by `errorUuid` (or if `errorUuid` fell off the 1 MiB tail).
 */
export function hasAssistantReplySince(entries, errorUuid) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const idx = entries.findIndex((e) => e && e.uuid === errorUuid);
  if (idx === -1) return true;
  for (let i = idx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.type === "assistant" && !e.isApiErrorMessage) return true;
  }
  return false;
}

/**
 * Checks whether the Claude session has produced any non-error assistant reply
 * with a timestamp strictly after `sinceMs` (used when the error was detected via screen fallback).
 */
export function hasAssistantReplyAfterTime(entries, sinceMs) {
  if (!Array.isArray(entries) || entries.length === 0 || !Number.isFinite(sinceMs)) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "assistant" || e.isApiErrorMessage) continue;
    const ts = toEpochMs(e.timestamp);
    if (ts != null && ts > sinceMs) return true;
  }
  return false;
}
