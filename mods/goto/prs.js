// The GitHub PR of each pane's branch, fetched by goto itself so the search can find a pane by "#123" or a PR title.
// Pure on purpose: refreshPrs gets the host functions from main.js, so node can run it (test/prs.test.mjs) without herdr.
const FIELDS = "number,title,state,isDraft,headRefName,isCrossRepository,url";
const MIN = 60_000;
const TTL = { open: 2 * MIN, done: 60 * MIN, none: 10 * MIN, failed: MIN / 2 };

// The PR a branch belongs to, from `gh pr list --json` items: same-repo heads only, an open one first, else the newest.
export function pickPr(items, branch) {
  const mine = (Array.isArray(items) ? items : []).filter((i) => i.headRefName === branch && !i.isCrossRepository);
  const open = mine.filter((i) => i.state === "OPEN");
  const pool = open.length ? open : mine;
  if (!pool.length) return null;
  const { number, title, state, isDraft, url } = pool.reduce((a, b) => (b.number > a.number ? b : a));
  return { number, title, state, isDraft: !!isDraft, url };
}

export function prText(pr) {
  if (!pr) return "";
  const tag = pr.state === "MERGED" ? " · merged" : pr.state === "CLOSED" ? " · closed" : pr.isDraft ? " · draft" : "";
  return `#${pr.number} ${pr.title}${tag}`;
}

// How long a cache entry { at, pr, failed } stays good.
export function ttlOf(entry) {
  if (entry.failed) return TTL.failed;
  if (!entry.pr) return TTL.none;
  return entry.pr.state === "OPEN" ? TTL.open : TTL.done;
}

const fresh = (entry, now) => !!entry && now - entry.at < ttlOf(entry);

// Reads `gh pr list` in `cwd`; null when it fails.
async function ghList(exec, cwd, args) {
  try {
    const r = await exec("gh", ["pr", "list", ...args, "--state", "all", "--json", FIELDS], { cwd, timeout: 15000 });
    if (r.code !== 0) return null;
    const items = JSON.parse(r.stdout);
    return Array.isArray(items) ? items : null;
  } catch { return null; }
}

async function git(exec, cwd, args) {
  try {
    const r = await exec("git", ["-C", cwd, ...args], { timeout: 15000 });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch { return ""; }
}

// Distinct { cwd, branch } of this computer's panes on a branch of their own.
function localPanes(panes, spaces) {
  const tabs = new Set();
  for (const s of spaces) if (!s.machine) for (const c of s.tabs) tabs.add(c.id);
  const seen = new Map();
  for (const p of panes) {
    if (!p.cwd || !p.branch || p.branch === "HEAD" || !tabs.has(p.tab)) continue;
    seen.set(`${p.cwd}::${p.branch}`, { cwd: p.cwd, branch: p.branch });
  }
  return [...seen.values()];
}

// Refreshes what is stale and publishes shared("goto.prs") = { "<cwd>::<branch>": pr | null }. Never throws.
export async function refreshPrs({ exec, panes, spaces, shared, setShared }) {
  try {
    const cache = JSON.parse(JSON.stringify(shared("goto.prcache") ?? {}));
    cache.lists ??= {};
    cache.heads ??= {};
    const published = {};
    const flush = () => {
      const before = JSON.stringify(shared("goto.prcache") ?? null);
      if (JSON.stringify(cache) !== before) setShared("goto.prcache", cache);
      if (JSON.stringify(published) !== JSON.stringify(shared("goto.prs") ?? null)) setShared("goto.prs", { ...published });
    };

    const repos = new Map();
    const repoOf = new Map();
    for (const { cwd, branch } of localPanes(panes(), spaces())) {
      if (!repoOf.has(cwd)) repoOf.set(cwd, await git(exec, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      const key = repoOf.get(cwd);
      if (!key) continue;
      if (!repos.has(key)) {
        const head = await git(exec, cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
        const dflt = head.startsWith("origin/") ? [head.slice(7)] : ["main", "master"];
        repos.set(key, { cwd, dflt, branches: new Map() });
      }
      const repo = repos.get(key);
      if (!repo.dflt.includes(branch)) repo.branches.set(`${cwd}::${branch}`, { cwd, branch });
    }

    const now = Date.now();
    for (const [key, repo] of repos) {
      let list = cache.lists[key];
      const stale = [...repo.branches.values()].filter((b) => !fresh(cache.heads[`${key}::${b.branch}`], now));
      // The repo's list ages like an open PR: it is where state changes (merges) show up.
      const listFresh = !!list && now - list.at < (list.failed ? TTL.failed : TTL.open);
      if (stale.length && !listFresh) {
        const items = await ghList(exec, repo.cwd, ["--author", "@me", "--limit", "100"]);
        list = cache.lists[key] = items ? { at: now, items } : { at: now, failed: true, items: list?.items ?? [] };
      }
      for (const b of stale) {
        const id = `${key}::${b.branch}`;
        const old = cache.heads[id];
        let pr = list?.failed ? undefined : pickPr(list?.items, b.branch);
        if (pr === null) {
          const items = await ghList(exec, repo.cwd, ["--head", b.branch, "--limit", "5"]);
          pr = items ? pickPr(items, b.branch) : undefined;
        }
        cache.heads[id] = pr === undefined ? { at: now, failed: true, pr: old?.pr ?? null } : { at: now, pr };
      }
      for (const b of repo.branches.values()) published[`${b.cwd}::${b.branch}`] = cache.heads[`${key}::${b.branch}`]?.pr ?? null;
      flush();
    }
    flush();
  } catch { /* old data stays */ }
}
