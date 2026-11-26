// Opens a page in terminal-browser: in a browser already in the tab if one is there, else in a
// new pane split beside the agent.
import { exec, run, notify, panes, terminals } from "herdr";

const INSTALL = "curl -fsSL https://terminal-browser.sh/install | bash";
const TIMEOUT = 5000;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

// A port, a loopback URL, or a bare host: the page's URL. Anything else is null.
export function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    return port >= 1 && port <= 65535 ? `http://localhost:${port}/` : null;
  }
  if (LOOPBACK.test(raw)) return `http://${raw}`;
  if (HOST.test(raw)) return `https://${raw}`;
  return null;
}

async function hasTerminalBrowser(machine) {
  const r = await exec("sh", ["-c", "command -v terminal-browser"], { on: machine, timeout: TIMEOUT });
  return r.code === 0 && Boolean(r.stdout.trim());
}

// A browser already running in the tab, told apart by the tty of its pane's foreground process.
// Herdr sets TERM_PROGRAM=ghostty everywhere, so terminal-browser is run without it.
async function reuse({ machine, tab, url }) {
  for (const p of panes()) {
    if (p.tab !== tab || !p.terminal) continue;
    const term = terminals().find((t) => t.address === p.terminal);
    if (term?.foreground?.name !== "terminal-browser" || !term.foreground.pid) continue;
    const ps = await exec("ps", ["-o", "tty=", "-p", String(term.foreground.pid)], { on: machine, timeout: TIMEOUT });
    if (ps.code !== 0) continue;
    const tty = ps.stdout.trim();
    if (!tty) continue;
    const ttyPath = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    const ls = await exec("env", ["-u", "TERM_PROGRAM", "terminal-browser", "ls", "--all", "--json"], { on: machine, timeout: TIMEOUT });
    if (ls.code !== 0) continue;
    let browsers = null;
    try { browsers = JSON.parse(ls.stdout).browsers; } catch { continue; }
    const key = Array.isArray(browsers) ? browsers.find((b) => b.tty === ttyPath)?.key : null;
    if (!key) continue;
    const action = await exec("env", ["-u", "TERM_PROGRAM", "terminal-browser", "action", "--browser", key, "--", "tab", "new", url], { on: machine, timeout: TIMEOUT });
    if (action.code !== 0) continue;
    try { run("pane.focus", { pane: p.pane }); } catch { /* the page is open; don't split again */ }
    return true;
  }
  return false;
}

export async function openUrl({ url, machine = null, pane = null, tab = null }) {
  const target = normalizeUrl(url);
  if (!target) return notify({ title: "Web", body: `Not a URL or port: ${url}`, level: "warning" });

  if (machine) {
    let installed = false;
    try { installed = await hasTerminalBrowser(machine); } catch { installed = false; }
    if (!installed) return notify({
      title: `Web on ${machine}`,
      body: `terminal-browser is not installed there. Install it with: ${INSTALL}`,
      level: "warning",
    });
  }

  try { if (await reuse({ machine, tab, url: target })) return; } catch { /* split instead */ }

  try {
    run("pane.split", {
      direction: "right",
      pane: pane ?? undefined,
      argv: ["env", "-u", "TERM_PROGRAM", "terminal-browser", "open", "--no-merge", target],
    });
  } catch (e) {
    notify({ title: "Can't open the web pane", body: String(e?.message ?? e), level: "error" });
  }
}
