// Strict bottom-of-screen rate-limit banner detection and reset-time parsing
// for Claude Code, Codex, and OpenCode.
// Pure ESM — no Node or Herdr host imports.

import { stableHash } from "./protocol.mjs";

const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1B(?:[()][0-9A-Za-z]|[@-Z\\-_])/g;
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const BOX_EDGE = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯]+|[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯]+$/g;
const DIVIDER_ONLY = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯\-_=~·•*]+$/;

const PROMPT_LINE_RE = /^[>❯›»]\s*(.*)$/;
const HORIZONTAL_DIVIDER_RE = /^[\s─━═\-_=~·•*]+$/;
const BOX_BOTTOM_RE = /^\s*[╰└][─━═]*[╯┘]\s*$/;
const BOX_TOP_RE = /^\s*[╭┌][─━═]*[╮┐]\s*$/;
const BOX_SIDE_RE = /^\s*[│║](.*?)[│║]?\s*$/;
const OPENCODE_BAR_RE = /^\s*┃(.*)$/;
const OPENCODE_COMPOSER_FOOTER_RE = /^(?:(?:build|plan|ask|agent)\s+\S|tab\s+agents?\b|ctrl\+[a-z]\b|esc\s+to\b)/i;

// Exact known composer placeholder strings (normalized lowercase) that are NOT unsent user drafts.
const EXACT_PLACEHOLDERS = new Set([
  "ask codex to do anything",
  "use /skills to list available skills",
  "summarize recent commits",
  "implement {feature}",
  "ask anything...",
]);
const CLAUDE_TRY_PLACEHOLDER_RE = /^Try\s+"[^"]+"$/i;
const OPENCODE_ASK_PLACEHOLDER_RE = /^Ask anything\.\.\.\s+"[^"]+"$/i;

export function isKnownPlaceholder(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (EXACT_PLACEHOLDERS.has(normalized.toLowerCase())) return true;
  if (CLAUDE_TRY_PLACEHOLDER_RE.test(normalized)) return true;
  if (OPENCODE_ASK_PLACEHOLDER_RE.test(normalized)) return true;
  return false;
}

// Non-prompt footer chrome lines that appear below the composer at the bottom of TUI screens.
const FOOTER_CHROME_PATTERNS = [
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
  /^[•·▪▸▹►\-*]\s/,
  /\?\s*$/,
  /`[^`]*(?:rate[_ ]limit|usage[_ ]limit|429|quota)[^`]*`/i,
  /["'][^"']*(?:rate[_ ]limit|usage[_ ]limit|429|quota exceeded)[^"']*["']/i,
  /\b(?:for example|e\.g\.|such as|when the user|if you see|handles?\s+the|detects?\s+(?:a|the)|test(?:s|ing)?\s+(?:a|the|for)|regex|pattern|matcher|banner)\b/i,
  /^(?:user|you|me|assistant|claude|codex|opencode)\s*:/i,
  /^\s*(?:\/\/|#|\/\*|\*|- \[.\])/,
];

// Valid continuation phrasing immediately following a matched banner prefix on the same line.
const VALID_BANNER_TAIL_NO_SEP_RE = /^(?:(?:please\s+)?(?:try\s+again|retry|wait)|resets?(?:\s|$)|available\b|until\b|in\s+\d+|after\s+\d+|retry[- ]?after\b|at\s+\d)/i;
const VALID_BANNER_TAIL_WITH_SEP_RE = /^(?:(?:please\s+)?(?:try\s+again|retry|wait)|resets?(?:\s|$)|available\b|until\b|in\s+\d+|after\s+\d+|retry[- ]?after\b|at\s+\d|your\s+(?:usage\s+)?limit\b|rate\s+limit\b|quota\b|too\s+many\s+requests\b|429\b|upgrade\b|learn\s+more\b|https?:\/\/)/i;

// Valid continuation lines immediately below a matched banner (multi-line error boxes).
const BANNER_CONTINUATION_RE = /^(?:(?:please\s+)?(?:try\s+again|retry(?:\s+after|\s+in|\s+at)?|wait\b)|retry[- ]?after\b|resets?\b|your\s+(?:usage\s+)?limit\b|available\s+(?:again\s+)?(?:in|at)\b|until\s+\d|upgrade\b|learn\s+more\b|https?:\/\/|error\s*[:\-–]|status\s*[:=]\s*429)/i;

// Bottom-region window size (above prompt chrome) inspected for error banners.
export const BOTTOM_REGION_LINES = 15;
export const MAX_CHROME_LINES = 8;

// Per-agent strictly ^-anchored CLI error banner patterns (with optional CLI prefixes).
const CLAUDE_PATTERNS = [
  { re: /^(?:⎿\s+)?(?:(?:api\s+)?error\s*[:\-–]\s*|⚠\s*|!\s*)?you['’]ve\s+hit\s+your\s+(?:(?:5-hour|five[- ]hour|weekly|session|usage|opus|sonnet|haiku)\s+)?limit\b/i, reason: "usage limit reached", key: "claude-hit-limit" },
  { re: /^(?:⎿\s+)?(?:(?:api\s+)?error\s*[:\-–]\s*|⚠\s*|!\s*)?you['’]ve\s+reached\s+your\s+(?:claude\s+)?(?:(?:5-hour|five[- ]hour|weekly|session|usage|opus|sonnet|haiku)\s+)?limit\b/i, reason: "usage limit reached", key: "claude-reached-limit" },
  { re: /^(?:⎿\s+)?(?:(?:api\s+)?error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:claude\s+)?(?:5-hour|five[- ]hour|weekly|session|usage|opus|sonnet|haiku)\s+limit\s+reached\b/i, reason: "usage limit reached", key: "claude-window-limit" },
  { re: /^(?:⎿\s+)?(?:api\s+error(?:\s*:\s*429)?|error)\s*[:\-–]\s*(?:rate[_ ]limit(?:_error|_exceeded)?|too\s+many\s+requests|usage\s+limit)\b/i, reason: "API rate limit", key: "claude-api-429" },
  { re: /^(?:⎿\s+)?(?:(?:api\s+)?error\s*[:\-–]\s*|⚠\s*|!\s*)?rate_limit_error\b/i, reason: "rate_limit_error", key: "claude-rate-limit-error" },
  { re: /^(?:⎿\s+)?(?:(?:api\s+)?error\s*[:\-–]\s*|⚠\s*|!\s*)?rate\s+limit\s+(?:reached|exceeded)\b/i, reason: "rate limit reached", key: "claude-rate-limit" },
];

const CODEX_PATTERNS = [
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?you['’]ve\s+hit\s+your\s+(?:usage\s+)?limit\b/i, reason: "usage limit reached", key: "codex-hit-limit" },
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?usage_limit_reached\b/i, reason: "usage_limit_reached", key: "codex-usage-limit-reached" },
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?rate_limit_exceeded\b/i, reason: "rate_limit_exceeded", key: "codex-rate-limit-exceeded" },
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?rate\s+limit\s+(?:reached|exceeded)\b/i, reason: "rate limit reached", key: "codex-rate-limit" },
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:usage\s+limit\s+reached|quota\s+exceeded|insufficient_quota)\b/i, reason: "quota exceeded", key: "codex-quota" },
  { re: /^(?:■\s+)?(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:http\s*429(?:\s+too\s+many\s+requests)?|429\s+too\s+many\s+requests)\b/i, reason: "429 Too Many Requests", key: "codex-429" },
];

const OPENCODE_PATTERNS = [
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?rate\s+limit\s+(?:exceeded|reached)\b/i, reason: "rate limit exceeded", key: "opencode-rate-limit" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:rate_limit_exceeded|usage_limit_reached|insufficient_quota)\b/i, reason: "usage limit reached", key: "opencode-limit-code" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:http\s*429(?:\s+too\s+many\s+requests)?|429\s+too\s+many\s+requests|status(?:\s+code)?\s*429)\b/i, reason: "429 Too Many Requests", key: "opencode-429" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?too\s+many\s+requests\b/i, reason: "Too Many Requests", key: "opencode-tmr" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?(?:you['’]ve\s+hit\s+your\s+)?usage\s+limit(?:\s+(?:reached|exceeded))?\b/i, reason: "usage limit reached", key: "opencode-usage-limit" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?quota\s+exceeded\b/i, reason: "quota exceeded", key: "opencode-quota" },
  { re: /^(?:error\s*[:\-–]\s*|⚠\s*|!\s*)?retry-after\s*[:=]\s*\d+(?:\s*(?:s|sec|secs|seconds|m|min|mins|minutes))?/i, reason: "Retry-After rate limit", key: "opencode-retry-after" },
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

function isFooterChromeLine(line) {
  if (!line || DIVIDER_ONLY.test(line)) return true;
  return FOOTER_CHROME_PATTERNS.some((re) => re.test(line));
}

function isChromeLine(line) {
  if (!line || DIVIDER_ONLY.test(line)) return true;
  if (/^[>❯›»$%#]\s*$/.test(line)) return true;
  const promptMatch = PROMPT_LINE_RE.exec(line);
  if (promptMatch) {
    const inner = promptMatch[1].trim();
    return !inner || isKnownPlaceholder(inner);
  }
  if (isKnownPlaceholder(line)) return true;
  if (OPENCODE_COMPOSER_FOOTER_RE.test(line)) return true;
  return FOOTER_CHROME_PATTERNS.some((re) => re.test(line));
}

function isProseLine(line) {
  return PROSE_DISQUALIFIERS.some((re) => re.test(line));
}

function normalizeBannerLine(line) {
  return String(line ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isRawTrailingFooter(rawLine) {
  if (BOX_BOTTOM_RE.test(rawLine) || BOX_TOP_RE.test(rawLine) || BOX_SIDE_RE.test(rawLine)) {
    return false;
  }
  if (OPENCODE_BAR_RE.test(rawLine)) {
    return false;
  }
  if (HORIZONTAL_DIVIDER_RE.test(rawLine)) return true;
  const cleaned = cleanLine(rawLine);
  if (!cleaned) return true;
  return FOOTER_CHROME_PATTERNS.some((re) => re.test(cleaned));
}

function hasDraftInLines(lines) {
  const nonEmpty = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  if (nonEmpty.length === 1 && isKnownPlaceholder(nonEmpty[0])) return false;
  return true;
}

/**
 * Returns true if the visible screen shows an unsent user draft typed into the
 * bottom prompt/composer (supporting single-line prompts, multi-line boxed composers,
 * and OpenCode `┃` left-bar composers; ignoring empty prompts and exact known placeholders).
 */
export function hasUnsentDraft(screenText) {
  const stripped = stripAnsi(screenText);
  if (!stripped) return false;
  const rawLines = stripped.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return false;

  // Peel trailing non-box footer chrome and pure horizontal dividers from the bottom.
  let idx = rawLines.length - 1;
  let peeled = 0;
  while (idx >= 0 && peeled < MAX_CHROME_LINES && isRawTrailingFooter(rawLines[idx])) {
    idx -= 1;
    peeled += 1;
  }
  if (idx < 0) return false;

  // 1. Multi-line boxed composer: ╭────╮ / │ > line1 │ / │   line2 │ / ╰────╯
  if (BOX_BOTTOM_RE.test(rawLines[idx])) {
    const interior = [];
    let j = idx - 1;
    let foundTop = false;
    while (j >= 0 && idx - j <= 25) {
      if (BOX_TOP_RE.test(rawLines[j])) {
        foundTop = true;
        break;
      }
      const sideMatch = BOX_SIDE_RE.exec(rawLines[j]);
      if (!sideMatch) break;
      interior.unshift(sideMatch[1].trim());
      j -= 1;
    }
    if (foundTop && interior.length > 0) {
      const firstNonEmptyIdx = interior.findIndex((l) => l.length > 0);
      if (firstNonEmptyIdx === -1) return false;
      const firstMatch = PROMPT_LINE_RE.exec(interior[firstNonEmptyIdx]);
      if (firstMatch) {
        const composerLines = [firstMatch[1].trim(), ...interior.slice(firstNonEmptyIdx + 1)];
        return hasDraftInLines(composerLines);
      }
    }
    return false;
  }

  // 2. OpenCode left-bar composer: contiguous bottom `┃ ...` block (skipping mode/model footer lines).
  if (OPENCODE_BAR_RE.test(rawLines[idx])) {
    const barLines = [];
    let j = idx;
    while (j >= 0 && idx - j < 25) {
      const m = OPENCODE_BAR_RE.exec(rawLines[j]);
      if (!m) break;
      barLines.unshift(m[1].trim());
      j -= 1;
    }
    // Peel trailing OpenCode mode/model/shortcut footer lines inside the `┃` block.
    while (barLines.length > 0) {
      const last = barLines[barLines.length - 1];
      if (!last || OPENCODE_COMPOSER_FOOTER_RE.test(last) || FOOTER_CHROME_PATTERNS.some((re) => re.test(last))) {
        barLines.pop();
      } else {
        break;
      }
    }
    return hasDraftInLines(barLines);
  }

  // 3. Standard unboxed prompt line (single-line or indented multi-line continuation).
  const bottomClean = cleanLine(rawLines[idx]);
  const promptMatch = PROMPT_LINE_RE.exec(bottomClean);
  if (promptMatch) {
    const draft = promptMatch[1].trim();
    if (!draft) return false;
    if (isKnownPlaceholder(draft)) return false;
    return true;
  }

  // Check if bottom lines are indented continuation lines of a prompt just above them.
  let k = idx;
  const contLines = [];
  while (k >= 0 && idx - k < 5) {
    const raw = rawLines[k];
    const cleaned = cleanLine(raw);
    const pm = PROMPT_LINE_RE.exec(cleaned);
    if (pm) {
      return hasDraftInLines([pm[1].trim(), ...contLines]);
    }
    if (!/^\s{2,}\S/.test(raw) || /^[•·▪▸▹►]/.test(cleaned)) {
      break;
    }
    contLines.unshift(cleaned);
    k -= 1;
  }

  return false;
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
  // Peel trailing prompt / footer chrome (up to MAX_CHROME_LINES) from the bottom.
  let end = nonEmpty.length;
  let peeled = 0;
  while (end > 0 && peeled < MAX_CHROME_LINES && isChromeLine(nonEmpty[end - 1])) {
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
  const monthDateRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s*(?:,|at)?\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\s*(am|pm))?)?(?:\s*\(([^)]+)\)|\s+((?:UTC|GMT)[+-]\d{1,2}(?::\d{2})?|UTC|GMT|[+-]\d{2}:?\d{2}))?/i;
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

  // 4. Time-of-day with reset/try-again context: "resets 7pm (UTC)", "resets at 7:30pm", "Try again at 19:00 UTC"
  const timeOfDayRe = /\b(?:resets?(?:\s+at)?|try\s+again\s+at|available\s+at|until|at)\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\s*(am|pm))?(?:\s*\(([^)]+)\)|\s+((?:UTC|GMT)[+-]\d{1,2}(?::\d{2})?|UTC|GMT))?/i;
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

function hasValidBannerTail(restRaw) {
  let rest = String(restRaw ?? "").trim();
  if (!rest) return true;

  let hadSeparator = false;
  // Peel optional leading parenthesized provider/code notes like "(anthropic)" or "(usage_limit_reached)".
  while (/^\([^)]{1,60}\)/.test(rest)) {
    rest = rest.replace(/^\([^)]{1,60}\)\s*/, "").trim();
    hadSeparator = true;
    if (!rest) return true;
  }

  // Peel leading banner punctuation separators (".", "!", "·", "—", "–", "-", ":", ";").
  const punctMatch = /^[.!·•—–\-:;]+\s*/.exec(rest);
  if (punctMatch) {
    rest = rest.slice(punctMatch[0].length).trim();
    hadSeparator = true;
    if (!rest) return true;
  }

  return hadSeparator
    ? VALID_BANNER_TAIL_WITH_SEP_RE.test(rest)
    : VALID_BANNER_TAIL_NO_SEP_RE.test(rest);
}

function matchPatterns(agent, line) {
  const patterns = AGENT_PATTERNS[agent];
  if (!patterns) return null;
  if (isProseLine(line)) return null;
  for (const p of patterns) {
    const m = p.re.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    if (!hasValidBannerTail(rest)) continue;
    return p;
  }
  return null;
}

function isBannerSuperseded(region, matchIndex, agent, nowMs) {
  const below = region.slice(matchIndex + 1);
  if (below.length === 0) return false;
  for (let j = 0; j < below.length; j++) {
    const line = below[j];
    // An assistant bullet response below the banner means conversation moved on.
    if (/^[•·▪▸▹►]\s+\S/.test(line)) return true;
    // A submitted user prompt followed by any output line below it means conversation moved on.
    const promptMatch = PROMPT_LINE_RE.exec(line);
    if (promptMatch && promptMatch[1].trim() && j < below.length - 1) return true;
    // Reject unrelated prose/question lines immediately below a banner (not a reset/retry continuation).
    if (
      !BANNER_CONTINUATION_RE.test(line) &&
      parseResetTime(line, nowMs) === null &&
      matchPatterns(agent, line) === null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detects an active rate-limit banner in the bottom screen region (or status report msg).
 * Returns null if no genuine active banner is found.
 */
export function detectScreenRateLimit({ agent, address = "", text, reportMsg = null, nowMs = Date.now() }) {
  if (!AGENT_PATTERNS[agent]) return null;

  const scope = typeof address === "string" ? address : "";
  const region = extractBottomRegion(text, BOTTOM_REGION_LINES);
  // Search from bottom upwards so the most recent banner wins.
  for (let i = region.length - 1; i >= 0; i--) {
    const line = region[i];
    const match = matchPatterns(agent, line);
    if (!match) continue;
    // If conversation turns or unrelated prose appear below the banner, it is not an active banner.
    if (isBannerSuperseded(region, i, agent, nowMs)) {
      break;
    }
    // Also inspect the matched line plus immediate neighbor lines (multi-line error boxes)
    // for a reset timestamp, e.g. line 1: "You've hit your usage limit", line 2: "Try again at 7:00 PM".
    const snippet = region.slice(Math.max(0, i - 1), Math.min(region.length, i + 3)).join(" ");
    const resetsAtMs = parseResetTime(snippet, nowMs);
    const normalized = normalizeBannerLine(line);
    const normalizedSnippet = normalizeBannerLine(region.slice(i, Math.min(region.length, i + 3)).join(" "));
    return {
      reason: match.reason,
      resetsAtMs,
      matchedLine: line,
      normalizedSnippet,
      // Terminal-scoped and timestamp-independent so stale banners never mint new fingerprints.
      fingerprint: `screen:${scope}:${agent}:${match.key}:${stableHash(normalized)}`,
    };
  }

  // Fallback to agent status report message (OSC 7501 `msg`) if present.
  if (typeof reportMsg === "string" && reportMsg.trim()) {
    const cleanMsg = cleanLine(stripAnsi(reportMsg));
    const match = matchPatterns(agent, cleanMsg);
    if (match) {
      const resetsAtMs = parseResetTime(cleanMsg, nowMs);
      const normalized = normalizeBannerLine(cleanMsg);
      return {
        reason: match.reason,
        resetsAtMs,
        matchedLine: cleanMsg,
        normalizedSnippet: normalized,
        fingerprint: `report:${scope}:${agent}:${match.key}:${stableHash(normalized)}`,
      };
    }
  }

  return null;
}
