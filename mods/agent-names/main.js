// Names panes and tabs after their agent's session, as the herdr TUI did.
// The Claude statusline labels each herdr-core terminal with claude.title (the
// session name) and claude.ctx (context used); an agent without labels yet
// falls back to the title it set on its terminal. Pane headers are drawn by
// better-changes from shared "pane-heads", so this fills entries there and
// marks them as its own. Tabs are named from what their panes are doing by
// the chain in namer.js, at most every 10 minutes per tab; a name a person
// typed is kept at least that long and becomes a hint for the next name.
// Empty shell tabs are handled by cleanup.js. Runs as a zero-size block in the
// layout.
import { View, div } from "gpui-kit";
import {
  panes, spaces, terminals, shared, setShared, run, home, appHome, exec, hc, focused,
  readTextFile, writeTextFile, checking,
} from "herdr";
import { buildPrompt, createNamer, extractScreenExcerpt, ruleName, typedName } from "./namer.js";
import { CLEANUP_EVERY_MS, isQuiet, runCleanup, STALE_KEY, STALE_SUFFIX } from "./cleanup.js";

const OWNED_TABS = "agent-names.tabs";
const TYPED_TABS = "agent-names.typed";
// { tabId: { fp, at } }: what each tab was last named from and when. Shared, so a
// reload, layout switch or restart does not re-name every tab at once.
const NAMED_TABS = "agent-names.named";
const BY = "agent-names";
const RENAME_WINDOW_MS = 10 * 60 * 1000;
const QUEUE_POLL_MS = 3000;

function machineOf(address) {
  if (!address) return null;
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

function bareId(address) {
  if (!address) return null;
  const slash = address.indexOf("/");
  return slash >= 0 ? address.slice(slash + 1) : address;
}

function shortFolder(cwd, userHome) {
  if (!cwd) return "";
  if (userHome && cwd === userHome) return "~";
  return userHome && cwd.startsWith(`${userHome}/`) ? `~${cwd.slice(userHome.length)}` : cwd;
}

function folderName(cwd, userHome) {
  if (!cwd) return null;
  if (userHome && cwd === userHome) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? null;
}

const CLI_COMMANDS = new Set([
  "agy", "antigravity", "claude", "codex", "opencode", "pi", "omp", "oh-my-pi",
  "gemini", "aider", "amp", "goose", "cursor", "droid", "copilot", "qwen",
]);

function isCliInvocation(title, program) {
  const s = String(title ?? "").trim().replace(/^[^\p{L}\p{N}~/.\\]+/u, "").trim();
  if (!s) return false;
  const tokens = s.split(/\s+/);
  if (tokens.length < 2) return false;
  const first = tokens[0].replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (!first) return false;
  const known = new Set(CLI_COMMANDS);
  if (program?.key) known.add(program.key.toLowerCase());
  if (program?.name) {
    known.add(program.name.toLowerCase());
    const firstWord = program.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (firstWord) known.add(firstWord);
  }
  if (!known.has(first)) return false;
  return tokens.slice(1).some((t) => /^--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=.*)?$/.test(t));
}

function turnBucket(turn) {
  const n = Number(turn) || 0;
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return Math.floor(Math.log2(n)) + 1;
}

function isAgyProgram(program) {
  const key = program?.key?.toLowerCase();
  const name = program?.name?.toLowerCase();
  return key === "antigravity" || key === "agy" || name === "antigravity";
}

function isPiProgram(program) {
  const key = program?.key?.toLowerCase();
  const name = program?.name?.toLowerCase();
  return key === "pi" || key === "oh-my-pi" || name === "pi" || name === "oh-my-pi";
}

// What the agent called its session: explicit session labels, else a terminal
// title that says more than the terminal's own address, program name, path,
// user@host, or raw CLI invocation.
function sessionName(p, labels) {
  if (!p.program?.agent) return null;
  const tlabels = labels.get(p.terminal);
  if (tlabels) {
    const keys = [
      "agent.title",
      "session.title",
      ...(isAgyProgram(p.program) ? ["agy.title"] : []),
      "claude.title",
      ...(isPiProgram(p.program) ? ["pi.session"] : []),
    ];
    for (const k of keys) {
      const val = tlabels[k]?.trim();
      if (val && !isCliInvocation(val, p.program)) return val;
    }
  }
  const raw = (p.title ?? "").trim();
  const bare = bareId(p.terminal);
  if (!raw || raw === p.terminal || (bare && raw === bare) || isCliInvocation(raw, p.program)) return null;
  const title = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (
    !title ||
    title === p.program.name ||
    title.toLowerCase() === p.program.key?.toLowerCase() ||
    title === p.terminal ||
    (bare && title === bare) ||
    /^[~/]|^[A-Za-z]:\\/.test(title) ||
    title.includes("@") ||
    isCliInvocation(title, p.program)
  ) return null;
  return title;
}

function sessionCwd(p, labels) {
  if (!p.program?.agent) return p.cwd;
  const tlabels = labels.get(p.terminal);
  if (isAgyProgram(p.program)) return tlabels?.["agy.cwd"]?.trim() || p.cwd;
  return tlabels?.["claude.cwd"]?.trim() || p.cwd;
}

function same(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export default class AgentNames extends View {
  init(_props, cx) {
    // Renames sent but not yet seen in spaces(): until one lands, the tab still
    // shows its old name and must not look like a person renamed it.
    this.pending = new Map();
    this.queue = new Map(); // tab id -> { info, prompt, fp, fallback, gen, screenPanes, machine }
    this.seen = new Map(); // tab id -> name on the previous render, to tell a live rename from first sight
    this.gen = new Map(); // tab id -> bumped on each person's rename, so older namer results are dropped
    this.busyShells = new Set(); // quiet tabs cleanup found in use; only those are named
    // Per-machine $HOME: undefined = lookup in flight, string = resolved, null = unavailable.
    this.homes = new Map();
    this.busy = false;
    this.cleaning = false;
    if (checking()) return;
    this.inferName = createNamer({
      exec, home, appHome, readTextFile, now: () => Date.now(), log: (m) => console.log(`agent-names: ${m}`),
    });
    cx.timer.every(QUEUE_POLL_MS, (cx) => this.drainQueue(cx));
    cx.timer.every(CLEANUP_EVERY_MS, (cx) => this.cleanup(cx));
    this.cleanup(cx);
  }

  homeFor(address, cx) {
    const machine = machineOf(address);
    if (!machine) return home();
    if (this.homes.has(machine)) return this.homes.get(machine);
    if (checking()) {
      this.homes.set(machine, null);
      return null;
    }
    this.homes.set(machine, undefined);
    cx.spawn(async (cx) => {
      let dir = null;
      try {
        const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine, timeout: 5000 });
        const out = result.code === 0 ? result.stdout.trim().replace(/\\/g, "/") : "";
        if (out) dir = out;
      } catch {
        // Offline or non-POSIX shell; fall back to raw path / basename.
      }
      this.homes.set(machine, dir);
      cx.notify();
    });
    return undefined;
  }

  render(cx) {
    const labels = new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
    const every = panes();
    this.syncPaneHeads(every.filter((p) => p.terminal), labels, cx);
    this.syncTabNames(every, labels, cx);
    return div().id("agent-names").size(0);
  }

  syncPaneHeads(all, labels, cx) {
    const heads = shared("pane-heads") ?? {};
    const next = Object.fromEntries(Object.entries(heads).filter(([, head]) => head?.by !== BY));
    for (const p of all) {
      const name = sessionName(p, labels);
      if (!name || next[p.pane]) continue;
      const ctx = labels.get(p.terminal)?.["claude.ctx"];
      const cwd = sessionCwd(p, labels);
      const userHome = this.homeFor(p.terminal, cx);
      next[p.pane] = { by: BY, title: name, detail: [ctx, shortFolder(cwd, userHome)].filter(Boolean).join(" · ") };
    }
    if (!same(heads, next)) setShared("pane-heads", next);
  }

  rename(id, name) {
    if (name) this.pending.set(id, name);
    else this.pending.delete(id);
    run("tab.rename", { id, name });
  }

  tabInfo(space, mine, typed, labels, reports, cx) {
    return {
      space: space.name,
      typed: typed ?? null,
      panes: mine.map((p) => {
        const session = sessionName(p, labels);
        const cwd = sessionCwd(p, labels);
        const userHome = this.homeFor(p.terminal, cx);
        const rawTitle = (p.title ?? "").trim();
        const cleanTitle = rawTitle.replace(/^[^\p{L}\p{N}]+/u, "").trim();
        const bare = bareId(p.terminal);
        const dropTitle =
          session ||
          p.program?.agent ||
          !rawTitle ||
          !cleanTitle ||
          rawTitle === p.terminal ||
          (bare && rawTitle === bare) ||
          cleanTitle === p.terminal ||
          (bare && cleanTitle === bare) ||
          cleanTitle === p.program?.name ||
          (p.program?.key && cleanTitle.toLowerCase() === p.program.key.toLowerCase()) ||
          isCliInvocation(rawTitle, p.program);
        return {
          program: p.program?.name ?? "",
          shell: !!p.program?.shell,
          status: p.status ?? null,
          session,
          step: reports.get(p.terminal) ?? null,
          folder: shortFolder(cwd, userHome),
          folderName: folderName(cwd, userHome),
          branch: p.branch ?? null,
          // A terminal's fallback title is its own address, program name, or raw CLI invocation.
          title: dropTitle ? null : rawTitle,
        };
      }),
    };
  }

  syncTabNames(every, labels, cx) {
    const spaceList = spaces();
    const tlist = terminals();
    // Before terminals load a prompt would lack session and step, and name the tab from that.
    if (!spaceList.some((s) => s.tabs.length) || !every.some((p) => p.terminal) || !tlist.length) return;
    const now = Date.now();
    const owned = shared(OWNED_TABS) ?? {};
    const typed = shared(TYPED_TABS) ?? {};
    const stale = shared(STALE_KEY) ?? {};
    const named = shared(NAMED_TABS) ?? {};
    const tmap = new Map(tlist.map((t) => [t.address, t]));
    const reports = new Map(tlist.map((t) => [t.address, t.report?.msg ?? null]));
    const live = new Set(spaceList.flatMap((s) => s.tabs.map((t) => t.id)));
    const keep = (m) => Object.fromEntries(Object.entries(m).filter(([id]) => live.has(id)));
    const nextOwned = keep(owned);
    const nextTyped = keep(typed);
    const nextNamed = keep(named);

    for (const space of spaceList) {
      for (const tab of space.tabs) {
        const pending = this.pending.get(tab.id);
        if (pending && tab.name === pending) {
          nextOwned[tab.id] = pending;
          this.pending.delete(tab.id);
        }
        const inTab = every.filter((p) => p.tab === tab.id);
        const mine = inTab.filter((p) => p.terminal);
        if (!mine.length) continue;
        const found = typedName(tab, {
          owned: nextOwned[tab.id], pending: this.pending.get(tab.id), typed: typed[tab.id], seen: this.seen.get(tab.id),
        });
        this.seen.set(tab.id, tab.name);
        if (found) {
          nextTyped[tab.id] = tab.name;
          if (found.restart) {
            nextNamed[tab.id] = { fp: nextNamed[tab.id]?.fp ?? null, at: now };
            this.queue.delete(tab.id);
            this.gen.set(tab.id, (this.gen.get(tab.id) ?? 0) + 1);
          }
        }
        // A person who clears a tab's name drops their hint with it.
        if (!tab.named) delete nextTyped[tab.id];
        // Empty shell tabs belong to cleanup.js (local only); quiet remote shells wait for activity.
        if (stale[tab.id] || (isQuiet(inTab, tmap) && !this.busyShells.has(tab.id))) {
          this.queue.delete(tab.id);
          continue;
        }
        // Wait for remote $HOME lookup before fingerprinting folders for the namer.
        if (mine.some((p) => this.homeFor(p.terminal, cx) === undefined)) continue;
        const info = this.tabInfo(space, mine, nextTyped[tab.id], labels, reports, cx);
        // Idle shells tell a namer nothing: a name a person typed stands as it is.
        if (info.typed && !info.typed.endsWith(STALE_SUFFIX) && info.panes.every((p) => p.shell && !p.session && !p.step)) {
          this.queue.delete(tab.id);
          if (tab.name !== info.typed && this.pending.get(tab.id) !== info.typed) this.rename(tab.id, info.typed);
          continue;
        }
        // Non-shell agent panes with no session, title, or step fall back to reading their screen.
        const screenPanes = [];
        for (let i = 0; i < mine.length && screenPanes.length < 2; i++) {
          const p = mine[i];
          const pi = info.panes[i];
          if (!pi.shell && (p.program?.agent || p.status != null) && !pi.session && !pi.title && !pi.step) {
            screenPanes.push({ index: i, terminal: p.terminal });
          }
        }
        // The prompt is the fingerprint: flattened and capped, so shared state stays small.
        // For screen-fallback panes, include a turn bucket so agent activity triggers naming.
        const prompt = buildPrompt(info);
        const fp = screenPanes.length
          ? `${prompt}\n#screen:${screenPanes.map((sp) => `${sp.terminal}:${turnBucket(tmap.get(sp.terminal)?.turn)}`).join(",")}`
          : prompt;
        const last = nextNamed[tab.id];
        const genericName = !nextTyped[tab.id] && mine.some((p) => p.program?.name === tab.name);
        if (last && (fp === last.fp || (!genericName && now - last.at < RENAME_WINDOW_MS))) {
          this.queue.delete(tab.id);
          continue;
        }
        if (this.queue.get(tab.id)?.fp === fp) continue;
        const machine = space.machine ?? mine.map((p) => machineOf(p.terminal)).find(Boolean) ?? null;
        this.queue.set(tab.id, {
          info,
          prompt,
          fp,
          fallback: ruleName(info),
          gen: this.gen.get(tab.id) ?? 0,
          screenPanes,
          machine,
        });
      }
    }
    for (const map of [this.queue, this.seen, this.gen, this.pending]) {
      for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    }
    for (const id of [...this.busyShells]) if (!live.has(id)) this.busyShells.delete(id);
    if (!same(owned, nextOwned)) setShared(OWNED_TABS, nextOwned);
    if (!same(typed, nextTyped)) setShared(TYPED_TABS, nextTyped);
    if (!same(named, nextNamed)) setShared(NAMED_TABS, nextNamed);
  }

  // One namer call at a time; render() only queues.
  drainQueue(cx) {
    if (this.busy || !this.queue.size) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.queue.size) {
          const [id, job] = this.queue.entries().next().value;
          this.queue.delete(id);
          // Recorded before the call, so a render meanwhile (or a new build) does not queue it again.
          setShared(NAMED_TABS, { ...(shared(NAMED_TABS) ?? {}), [id]: { fp: job.fp, at: Date.now() } });
          let prompt = job.prompt;
          if (job.screenPanes.length > 0) {
            const enrichedPanes = job.info.panes.map((p) => ({ ...p }));
            let anyScreen = false;
            for (const sp of job.screenPanes) {
              const res = await hc(["read", sp.terminal, "--json", "--lines", "40"]).catch(() => null);
              await cx.sleep(0); // throws once this build was replaced, ending the loop
              const excerpt = extractScreenExcerpt(res);
              if (excerpt) {
                enrichedPanes[sp.index].screen = excerpt;
                anyScreen = true;
              }
            }
            if ((this.gen.get(id) ?? 0) !== job.gen) continue;
            if (anyScreen) prompt = buildPrompt({ ...job.info, panes: enrichedPanes });
          }
          const { name, by } = await this.inferName(prompt, job.fallback, { on: job.machine });
          await cx.sleep(0); // throws once this build was replaced, ending the loop
          this.apply(id, job, name, by);
        }
      } catch (e) {
        console.log(`agent-names: naming failed: ${e?.message ?? e}`);
      } finally {
        this.busy = false;
      }
    });
  }

  apply(id, job, name, by) {
    // A person renamed the tab while the namer ran: their name stands.
    if ((this.gen.get(id) ?? 0) !== job.gen) return;
    const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === id);
    const stale = shared(STALE_KEY) ?? {};
    setShared(NAMED_TABS, { ...(shared(NAMED_TABS) ?? {}), [id]: { fp: job.fp, at: Date.now() } });
    if (!tab || !name || stale[id] || tab.name.endsWith(STALE_SUFFIX)) return;
    const owned = shared(OWNED_TABS) ?? {};
    if (tab.name === name) {
      if (owned[id] !== name) setShared(OWNED_TABS, { ...owned, [id]: name });
      return;
    }
    console.log(`agent-names: tab ${id} -> "${name}" by ${by}`);
    this.rename(id, name);
  }

  cleanup(cx) {
    if (this.cleaning) return;
    this.cleaning = true;
    cx.spawn(async (cx) => {
      try {
        const { notEmpty } = await runCleanup({
          spaces, panes, terminals, focused, shared, setShared, run, hc, home, readTextFile, writeTextFile,
          rename: (id, name) => this.rename(id, name),
          now: () => Date.now(),
          log: (m) => console.log(`agent-names: ${m}`),
          touch: () => cx.sleep(0),
        });
        this.busyShells = notEmpty;
      } catch (e) {
        console.log(`agent-names: cleanup failed: ${e?.message ?? e}`);
      } finally {
        this.cleaning = false;
      }
    });
  }
}
