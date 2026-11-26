// Strict bottom-of-screen rate-limit banner detection and reset-time parsing
// for Claude Code, Codex, and OpenCode.
// Pure ESM — no Node or Herdr host imports.

import { stableHash } from "./protocol.mjs";

const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1B(?:[()][0-9A-Za-z]|[@-Z\\-_])/g;
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const BOX_EDGE = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•▪▸▹►]+|[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•▪▸▹►]+$/g;
const DIVIDER_ONLY = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯\-_=~·•*]+$/;

// Footer / prompt chrome lines that appear below an error banner at the bottom of TUI screens.
const CHROME_PATTERNS = [
  /^[>❯›$%#]\s*$/,
  /^[>❯›]\s*(?:Try\s+"|Ask\s+|Type\s+|Send\s+|Message\s+)/i,
  /\?\s*for\s+shortcuts/i,
  /shift\+tab\s+to\s+cycle/i,
  /bypass\s+permissions/i,
  /\bctrl\+[a-z]\b.*\b(?:cancel|quit|exit|help|clear|commands|palette)\b/i,
  /^\s*(?:auto-accept|plan mode|accept edits|normal mode|insert mode)\b/i,
  /^\s*(?:claude|sonnet|opus|haiku|gpt-[0-9]|o[134]|codex|opencode)[\w.\-\s]*\s*[|·•]\s*(?:\d+%|\$[\d.]+|\d+[kKmM]?\s*tokens?)/i,
  /^\s*\d+%\s+(?:context|left|used)\b/i,
  /^\s*esc\s+to\s+(?:interrupt|cancel|close)/i,
  /^\s*enter\s+to\s+(?:send|submit|confirm)/i,
];

// Prose / conversational markers that disqualify a line from being a genuine error banner.
const PROSE_DISQUALIFIERS = [
  /`[^`]*(?:rate[_ ]limit|usage[_ ]limit|429|quota)[^`]*`/i,
  /["'][^"']*(?:rate[_ ]limit|usage[_ ]limit|429|quota exceeded)[^"']*["']/i,
  /\b(?:for example|e\.g\.|such as|when the user|if you see|handles?\s+the|detects?\s+(?:a|the)|test(?:s|ing)?\s+(?:a|the|for)|regex|pattern|matcher|banner)\b/i,
  /^(?:user|you|me|assistant|claude|codex|opencode)\s*:/i,
  /^\s*(?:\/\/|#|\/\*|\*|- \[.\])/,
];

// Bottom-region window size (above prompt chrome) inspected for error banners.
const BOTTOM_REGION_LINES = 15;

// Per-agent strict banner patterns. Each entry: { re, reason, key }
const CLAUDE_PATTERNS = [
  { re: /^(?:error:\s*)?you['’]ve\s+hit\s+your\s+(?:usage\s+)?limit\b/i, reason: "usage limit reached", key: "claude-hit-limit" },
  { re: /^(?:error:\s*)?you['’]ve\s+reached\s+your\s+(?:claude\s+)?usage\s+limit\b/i, reason: "usage limit reached", key: "claude-reached-limit" },
  { re: /^(?:error:\s*)?(?:claude\s+)?(?:5-hour|five[- ]hour|weekly|session|usage)\s+limit\s+reached\b/i, reason: "usage limit reached", key: "claude-window-limit" },
  { re: /^(?:api\s+error(?:\s*:\s*429)?|error)\s*[:\-–]\s*(?:rate[_ ]limit(?:_error|_exceeded)?|too\s+many\s+requests|usage\s+limit)\b/i, reason: "API rate limit", key: "claude-api-429" },
  { re: /\brate_limit_error\b/i, reason: "rate_limit_error", key: "claude-rate-limit-error" },
  { re: /^(?:error:\s*)?rate\s+limit\s+(?:reached|exceeded)\b/i, reason: "rate limit reached", key: "claude-rate-limit" },
];

const CODEX_PATTERNS = [
  { re: /^(?:error:\s*)?you['’]ve\s+hit\s+your\s+usage\s+limit\b/i, reason: "usage limit reached", key: "codex-hit-limit" },
  { re: /\busage_limit_reached\b/i, reason: "usage_limit_reached", key: "codex-usage-limit-reached" },
  { re: /\brate_limit_exceeded\b/i, reason: "rate_limit_exceeded", key: "codex-rate-limit-exceeded" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?rate\s+limit\s+(?:reached|exceeded)\b/i, reason: "rate limit reached", key: "codex-rate-limit" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?(?:usage\s+limit\s+reached|quota\s+exceeded|insufficient_quota)\b/i, reason: "quota exceeded", key: "codex-quota" },
  { re: /\b(?:http\s*429|429\s+too\s+many\s+requests)\b/i, reason: "429 Too Many Requests", key: "codex-429" },
];

const OPENCODE_PATTERNS = [
  { re: /^(?:error:\s*|⚠\s*|!\s*)?rate\s+limit\s+(?:exceeded|reached)\b/i, reason: "rate limit exceeded", key: "opencode-rate-limit" },
  { re: /\b(?:rate_limit_exceeded|usage_limit_reached|insufficient_quota)\b/i, reason: "usage limit reached", key: "opencode-limit-code" },
  { re: /\b(?:http\s*429|429\s+too\s+many\s+requests|status(?:\s+code)?\s*429)\b/i, reason: "429 Too Many Requests", key: "opencode-429" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?too\s+many\s+requests\b/i, reason: "Too Many Requests", key: "opencode-tmr" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?(?:you['’]ve\s+hit\s+your\s+)?usage\s+limit(?:\s+(?:reached|exceeded))?\b/i, reason: "usage limit reached", key: "opencode-usage-limit" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?quota\s+exceeded\b/i, reason: "quota exceeded", key: "opencode-quota" },
  { re: /^(?:error:\s*|⚠\s*|!\s*)?retry-after\s*[:=]\s*\d+/i, reason: "Retry-After rate limit", key: "opencode-retry-after" },
];

const AGENT_PATTERNS = {
  claude: CLAUDE_PATTERNS,
  codex: CODEX_PATTERNS,
  opencode: OPENCODE_PATTERNS,
};

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_ESC, "")
    .replace(INVISIBLE, "");
}

export function extractScreenText(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.stdout === "string") {
    const trimmed = raw.stdout.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.text === "string") return parsed.text;
      } catch {
        // Plain text starting with '{'
      }
    }
    return raw.stdout;
  }
  return "";
}

function cleanLine(rawLine) {
  return rawLine
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(BOX_EDGE, "")
    .trim();
}

function isChromeLine(line) {
  if (!line || DIVIDER_ONLY.test(line)) return true;
  return CHROME_PATTERNS.some((re) => re.test(line));
}

function isProseLine(line) {
  return PROSE_DISQUALIFIERS.some((re) => re.test(line));
}

/**
 * Extracts the bottom non-empty error/banner region of a terminal screen,
 * peeling off trailing prompt/status-bar chrome lines first.
 */
export function extractBottomRegion(text, maxLines = BOTTOM_REGION_LINES) {
  const stripped = stripAnsi(text);
  const nonEmpty = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    if (!line || DIVIDER_ONLY.test(line)) continue;
    nonEmpty.push(line);
  }
  // Peel trailing prompt / footer chrome (up to 8 lines) from the bottom.
  let end = nonEmpty.length;
  let peeled = 0;
  while (end > 0 && peeled < 8 && isChromeLine(nonEmpty[end - 1])) {
    end -= 1;
    peeled += 1;
  }
  const start = Math.max(0, end - maxLines);
  return nonEmpty.slice(start, end);
}

function to24Hour(hour, meridiem) {
  let h = Number(hour);
  if (!Number.isFinite(h)) return null;
  if (meridiem) {
    const m = meridiem.toLowerCase();
    if (h < 1 || h > 12) return null;
    if (m === "am") h = h === 12 ? 0 : h;
    else if (m === "pm") h = h === 12 ? 12 : h + 12;
  } else if (h < 0 || h > 23) {
    return null;
  }
  return h;
}

function parseUtcOffsetMinutes(tzRaw) {
  if (!tzRaw) return null;
  const tz = tzRaw.trim().toUpperCase();
  if (tz === "UTC" || tz === "GMT" || tz === "Z") return 0;
  const m = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const mins = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || mins > 59) return null;
  return sign * (hours * 60 + mins);
}

function zonedDateToUtcMs(year, month, day, hour, minute, second, timeZone) {
  // Compute UTC timestamp corresponding to wall clock time in an IANA timeZone using Intl.
  try {
    const guess = Date.UTC(year, month, day, hour, minute, second);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = asUtc - guess;
    return guess - offset;
  } catch {
    return null;
  }
}

function resolveCalendarTime({ year, month, day, hour, minute, second = 0, tzRaw, nowMs, hasExplicitDate }) {
  const offsetMin = parseUtcOffsetMinutes(tzRaw);
  const nowDate = new Date(nowMs);

  const buildMs = (y, mo, d) => {
    if (offsetMin !== null) {
      return Date.UTC(y, mo, d, hour, minute, second) - offsetMin * 60_000;
    }
    if (tzRaw && tzRaw.includes("/")) {
      const zoned = zonedDateToUtcMs(y, mo, d, hour, minute, second, tzRaw.trim());
      if (zoned !== null) return zoned;
    }
    return new Date(y, mo, d, hour, minute, second, 0).getTime();
  };

  if (hasExplicitDate) {
    const y = year ?? (offsetMin !== null ? nowDate.getUTCFullYear() : nowDate.getFullYear());
    let candidate = buildMs(y, month, day);
    // If year was omitted and the date is more than 180 days in the past (e.g. Dec -> Jan), roll next year.
    if (year == null && candidate < nowMs - 180 * 86_400_000) {
      candidate = buildMs(y + 1, month, day);
    }
    return candidate;
  }

  // Time-of-day only: construct in target timezone's "today", rolling +1 day if already passed.
  let y;
  let mo;
  let d;
  if (offsetMin !== null) {
    const shifted = new Date(nowMs + offsetMin * 60_000);
    y = shifted.getUTCFullYear();
    mo = shifted.getUTCMonth();
    d = shifted.getUTCDate();
  } else {
    y = nowDate.getFullYear();
    mo = nowDate.getMonth();
    d = nowDate.getDate();
  }
  let candidate = buildMs(y, mo, d);
  while (candidate - nowMs > 86_400_000) candidate -= 86_400_000;
  while (candidate <= nowMs) candidate += 86_400_000;
  return candidate;
}

/**
 * Parses a reset time or relative retry duration from rate-limit banner text.
 * Returns epoch ms or null if none found.
 */
export function parseResetTime(text, nowMs = Date.now()) {
  const s = stripAnsi(text);
  if (!s) return null;

  // 1. ISO 8601 timestamp (e.g. 2026-11-26T19:00:00Z or 2026-11-26T19:00:00+00:00)
  const isoMatch = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/i.exec(s);
  if (isoMatch) {
    const ms = Date.parse(isoMatch[1]);
    if (Number.isFinite(ms)) return ms;
  }

  // 2. Relative durations: "in 4m 30s", "in 2h 15m", "in 45 seconds", "after 30s", "retry-after: 120"
  const relContext = /\b(?:in|after|retry[- ]?after\s*[:=]?\s*)\s*((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?:\s*(?:,|and)?\s*)?)+)\b/i.exec(s);
  if (relContext) {
    const totalMs = parseDurationMs(relContext[1]);
    if (totalMs > 0) return nowMs + totalMs;
  }
  const bareRetryAfter = /\bretry[- ]?after\s*[:=]\s*(\d+)\b/i.exec(s);
  if (bareRetryAfter) {
    const secs = Number(bareRetryAfter[1]);
    if (Number.isFinite(secs) && secs > 0) return nowMs + secs * 1000;
  }

  // 3. Explicit date + time: "Oct 15, 3pm (UTC)", "Nov 26, 2026 7:00 PM", "Nov 26 at 19:00 UTC"
  const monthDateRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s*(?:,|at)?\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?(?:\s*\(([^)]+)\)|\s+(UTC|GMT|[+-]\d{2}:?\d{2}))?/i;
  const dateMatch = monthDateRe.exec(s);
  if (dateMatch && dateMatch[4] != null) {
    const month = MONTHS[dateMatch[1].toLowerCase()];
    const day = Number(dateMatch[2]);
    const year = dateMatch[3] ? Number(dateMatch[3]) : null;
    const hour = to24Hour(dateMatch[4], dateMatch[7]);
    const minute = dateMatch[5] ? Number(dateMatch[5]) : 0;
    const second = dateMatch[6] ? Number(dateMatch[6]) : 0;
    const tzRaw = dateMatch[8] || dateMatch[9] || null;
    if (month !== undefined && day >= 1 && day <= 31 && hour !== null && minute <= 59 && second <= 59) {
      return resolveCalendarTime({
        year,
        month,
        day,
        hour,
        minute,
        second,
        tzRaw,
        nowMs,
        hasExplicitDate: true,
      });
    }
  }

  // 4. Time-of-day with reset/try-again context: "resets 7pm (UTC)", "resets at 7:30pm", "Try again at 19:00"
  const timeOfDayRe = /\b(?:resets?(?:\s+at)?|try\s+again\s+at|available\s+at|until|at)\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\)|\s+(UTC|GMT|UTC[+-]\d{1,2}(?::\d{2})?))?/i;
  const todMatch = timeOfDayRe.exec(s);
  if (todMatch) {
    // Require either ":MM" or "am/pm" so plain numbers like "at 429" are not parsed as times.
    if (todMatch[2] != null || todMatch[4] != null) {
      const hour = to24Hour(todMatch[1], todMatch[4]);
      const minute = todMatch[2] ? Number(todMatch[2]) : 0;
      const second = todMatch[3] ? Number(todMatch[3]) : 0;
      const tzRaw = todMatch[5] || todMatch[6] || null;
      if (hour !== null && minute <= 59 && second <= 59) {
        return resolveCalendarTime({
          year: null,
          month: null,
          day: null,
          hour,
          minute,
          second,
          tzRaw,
          nowMs,
          hasExplicitDate: false,
        });
      }
    }
  }

  return null;
}

export function parseDurationMs(expr) {
  let total = 0;
  const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
  let m;
  while ((m = re.exec(expr)) !== null) {
    const val = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(val)) continue;
    if (unit.startsWith("d")) total += val * 86_400_000;
    else if (unit.startsWith("h")) total += val * 3_600_000;
    else if (unit.startsWith("m")) total += val * 60_000;
    else if (unit.startsWith("s")) total += val * 1000;
  }
  return total;
}

function matchPatterns(agent, line) {
  const patterns = AGENT_PATTERNS[agent];
  if (!patterns) return null;
  if (isProseLine(line)) return null;
  for (const p of patterns) {
    if (p.re.test(line)) return p;
  }
  return null;
}

/**
 * Detects an active rate-limit banner in the bottom screen region (or status report msg).
 * Returns null if no genuine banner is found.
 */
export function detectScreenRateLimit({ agent, text, reportMsg = null, nowMs = Date.now() }) {
  if (!AGENT_PATTERNS[agent]) return null;

  const region = extractBottomRegion(text, BOTTOM_REGION_LINES);
  // Search from bottom upwards so the most recent banner wins.
  for (let i = region.length - 1; i >= 0; i--) {
    const line = region[i];
    const match = matchPatterns(agent, line);
    if (!match) continue;
    // Also inspect the matched line plus immediate neighbor lines (multi-line error boxes)
    // for a reset timestamp, e.g. line 1: "You've hit your usage limit", line 2: "Try again at 7:00 PM".
    const snippet = region.slice(Math.max(0, i - 1), Math.min(region.length, i + 3)).join(" ");
    const resetsAtMs = parseResetTime(snippet, nowMs);
    const bucket = resetsAtMs != null ? Math.floor(resetsAtMs / 60_000) : line.toLowerCase();
    return {
      reason: match.reason,
      resetsAtMs,
      matchedLine: line,
      fingerprint: `screen:${agent}:${match.key}:${stableHash(String(bucket))}`,
    };
  }

  // Fallback to agent status report message (OSC 7501 `msg`) if present.
  if (typeof reportMsg === "string" && reportMsg.trim()) {
    const cleanMsg = cleanLine(stripAnsi(reportMsg));
    const match = matchPatterns(agent, cleanMsg);
    if (match) {
      const resetsAtMs = parseResetTime(cleanMsg, nowMs);
      const bucket = resetsAtMs != null ? Math.floor(resetsAtMs / 60_000) : cleanMsg.toLowerCase();
      return {
        reason: match.reason,
        resetsAtMs,
        matchedLine: cleanMsg,
        fingerprint: `report:${agent}:${match.key}:${stableHash(String(bucket))}`,
      };
    }
  }

  return null;
}
