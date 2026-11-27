// fuzzy() comes from herdrdev/herdr-app@034f8b85f7e6bb71f8ff55cb4a80c548b2578c0f, defaults/frame/palette/main.js.
// Licensed under Apache-2.0; modified (only that function is taken, unchanged). Line ranges: PROVENANCE.md.
// Pure search core of goto: no herdr imports, so it runs under plain node (test/score.test.mjs).
// The fuzzy scorer is the command palette's (frame/palette/main.js): the query's letters in order,
// word starts and runs rank higher. Each item offers several fields; a field's score is scaled by its
// weight and the best field wins.

// How much a field counts: the label is what a row is called, the rest is where it lives.
export const WEIGHTS = { label: 1, tab: 0.8, space: 0.65, folder: 0.65, member: 0.5, branch: 0.45, cwd: 0.45, program: 0.45, machine: 0.45, pr: 0.45 };

// A leading character narrows what is searched; the rest of the query is the search.
export const SCOPES = { "@": "pane", "#": "tab", "/": "space", "!": "blocked", ">": "palette" };

export const normalize = (s) => s.toLowerCase().replace(/\s+/g, "");

// Fuzzy score of `q` (already lowercase) in `text`, with the matched positions; null: no match.
export function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(t[i - 1]);
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

// "@fix up" -> { scope: "pane", q: "fixup" }; no leading character: scope "all".
export function parseQuery(raw) {
  const s = raw.trimStart();
  const scope = SCOPES[s[0]];
  return scope ? { scope, q: normalize(s.slice(1)) } : { scope: "all", q: normalize(raw) };
}

// Items are { id, kind: "pane" | "tab" | "space", status, ... }; blocked is a pane's own status.
export function inScope(item, scope) {
  if (scope === "all" || scope === "palette") return true;
  if (scope === "blocked") return item.kind === "pane" && item.status === "blocked";
  return item.kind === scope;
}

// The best field of `item` for `q`: { score, field, hits }, hits being the label's, or null: no match.
// A weighted score never goes below a sliver, so a long text's length penalty cannot turn a match into a loss.
export function scoreItem(q, item) {
  let best = null;
  for (const f of item.fields) {
    if (!f.text) continue;
    const m = fuzzy(q, f.text);
    if (!m) continue;
    const score = Math.max(m.score, 0.1) * (WEIGHTS[f.name] ?? 0.4);
    if (!best || score > best.score) best = { score, field: f.name };
  }
  if (!best) return null;
  const label = item.fields.find((f) => f.name === "label");
  return { ...best, hits: label?.text ? (fuzzy(q, label.text)?.hits ?? []) : [] };
}

// Matching items, best first; equal scores go to the one visited last (`recent`: ids, newest first),
// then to the order they came in.
export function rank(items, q, recent = []) {
  const seen = (it) => { const i = recent.indexOf(it.id); return i < 0 ? Infinity : i; };
  return items
    .map((item, n) => ({ item, n, ...scoreItem(q, item) }))
    .filter((r) => r.score !== undefined)
    .sort((a, b) => (Math.abs(b.score - a.score) > 1e-9 ? b.score - a.score : seen(a.item) - seen(b.item) || a.n - b.n))
    .map(({ item, score, field, hits }) => ({ item, score, field, hits }));
}

// With nothing typed: the pane you came from, then those needing you, then the ones you visited, newest first,
// then the rest as ctrl-1..9 number them (`order`: terminal ids), then as they came.
export function orderEmpty(items, { recent = [], order = [], back = null } = {}) {
  const at = (list, x) => { const i = list.indexOf(x); return i < 0 ? Infinity : i; };
  const tier = (it) => (it.id === back ? 0 : it.status === "blocked" ? 1 : recent.includes(it.id) ? 2 : 3);
  return items
    .map((item, n) => ({ item, n, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier
      || (a.tier === 2 ? at(recent, a.item.id) - at(recent, b.item.id) : 0)
      || at(order, a.item.terminal) - at(order, b.item.terminal)
      || a.n - b.n)
    .map((r) => r.item);
}
