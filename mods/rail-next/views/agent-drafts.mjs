const DRAWN_RULE = /^\s*─{4,}\s*$/;
const CLAUDE_FOOTER = /(?:\(shift\+tab\s*$|shift\+tab to cycle|\? for shortcuts|← (?:for agents|\d+ agents))/i;
const CODEX_FOOTER =
  /(?:\? for shortcuts|← for agents|tab to queue message|context \d+% used|\d+% context left)/i;
const CODEX_MODEL_LINE = /^\s*(?:gpt-[\w.-]+|codex[\w.-]*|o[134](?:-[\w.-]+)?)\b.*\s·\s/i;
const CODEX_PLACEHOLDERS = new Set([
  "ask codex to do anything",
  "ask a follow-up question",
  "use /skills to list available skills",
  "summarize recent commits",
  "implement {feature}",
  "explain this codebase",
  "find and fix a bug in @filename",
  "write tests for @filename",
  "improve documentation in @filename",
  "run /review on my current changes",
]);

export function idleRingColor(theme, showDrafts, draft, fallback) {
  if (!showDrafts) return fallback;
  return draft ? theme.muted : theme.accent;
}

function kind(agent) {
  switch (agent.app ?? agent.program?.key) {
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

function token(agent) {
  const app = kind(agent);
  return agent.status === "idle" && app ? `${app}:${agent.pane}:${agent.seq}` : null;
}

function composer(lines, marker) {
  const prompt = lines.findLastIndex((line) => marker.test(line));
  if (prompt < 0 || lines.slice(prompt + 1).some((line) => !/^\s{2}/.test(line))) return "";
  return [lines[prompt].replace(marker, ""), ...lines.slice(prompt + 1)]
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export function hasDraft(app, result) {
  if (result?.code !== 0) return false;
  let screen;
  try {
    screen = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (screen?.how !== "screen" || screen.complete !== true || typeof screen.text !== "string") return false;
  const lines = screen.text.split(/\r?\n/).filter((line) => line.trim()).slice(-45);
  if (app === "claude") {
    const close = lines.findLastIndex((line) => DRAWN_RULE.test(line));
    if (close < 0 || close < lines.length - 7) return false;
    if (!lines.slice(close + 1).some((line) => CLAUDE_FOOTER.test(line))) return false;
    const open = lines.slice(0, close).findLastIndex((line) => DRAWN_RULE.test(line));
    if (open < 0 || !/^\s*❯(?:\s+|$)/.test(lines[open + 1] ?? "")) return false;
    const draft = composer(lines.slice(open + 1, close), /^\s*❯(?:\s+|$)/);
    return Boolean(draft) && !/^try "[^"]+"$/i.test(draft);
  }
  if (app !== "codex") return false;
  const model = lines.findLastIndex((line) => CODEX_MODEL_LINE.test(line));
  const footer = lines.findLastIndex((line) => /^\s{2}/.test(line) && CODEX_FOOTER.test(line));
  const end = model >= lines.length - 3 ? model : footer;
  if (end < 0 || end < lines.length - 3) return false;
  const draft = composer(lines.slice(0, end), /^\s*›(?:\s+|$)/);
  return Boolean(draft) && !CODEX_PLACEHOLDERS.has(draft.toLowerCase());
}

export function createDraftMonitor(list, read) {
  const drafts = new Map();
  const recent = new Set();
  let busy = false;
  let closed = false;

  const candidates = () => new Map(list().filter(token).map((agent) => [agent.address, agent]));

  return {
    has(agent) {
      const observed = drafts.get(agent.address);
      return observed !== undefined && observed === token(agent);
    },

    async refresh(notify) {
      if (closed) return;
      const current = candidates();
      let expired = false;
      for (const [address, observed] of drafts) {
        const agent = current.get(address);
        if (agent && token(agent) === observed) continue;
        drafts.delete(address);
        expired = true;
      }
      if (expired) notify();
      if (busy || current.size === 0) return;
      busy = true;
      for (const address of recent) if (!current.has(address)) recent.delete(address);
      const unread = [...current.keys()].filter((address) => !recent.has(address));
      const batch = [...unread, ...recent].slice(0, 4).map((address) => {
        recent.delete(address);
        recent.add(address);
        return current.get(address);
      });
      try {
        const results = await Promise.all(batch.map(async (agent) => {
          try {
            return hasDraft(kind(agent), await read(agent.address));
          } catch {
            return false;
          }
        }));
        if (closed) return;
        const latest = candidates();
        let changed = false;
        for (const [i, agent] of batch.entries()) {
          const address = agent.address;
          const live = latest.get(address);
          const observed = token(agent);
          if (results[i] && live && token(live) === observed) {
            changed ||= drafts.get(address) !== observed;
            drafts.set(address, observed);
          } else if (drafts.delete(address)) {
            changed = true;
          }
        }
        if (changed) notify();
      } finally {
        busy = false;
      }
    },

    close() {
      closed = true;
      drafts.clear();
      recent.clear();
    },
  };
}

// Move drafts into the first idle slots while keeping other agents in place.
export function promoteDrafts(list, draftAddresses) {
  if (draftAddresses.size === 0) return list;
  const idle = list.filter((agent) => agent.status === "idle");
  const ordered = [
    ...idle.filter((agent) => draftAddresses.has(agent.address)),
    ...idle.filter((agent) => !draftAddresses.has(agent.address)),
  ];
  let next = 0;
  return list.map((agent) => agent.status === "idle" ? ordered[next++] : agent);
}
