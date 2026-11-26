#!/usr/bin/env node
// herdr-glass self-installer: checks and installs everything the pack needs.
// Default is report-only; --apply writes into the Herdr App home; --yes also
// installs missing programs. Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const USAGE = `Usage: scripts/install.sh [--check | --apply | --yes] [--link] [--no-keys] [--app-home DIR]
  --check     Default. Report only, write nothing. Exit 0 when nothing is missing or out of date, 1 otherwise.
  --apply     Install/update pack mods, layouts, themes; merge keys add-only; build helpers;
              write the Insights runtime.json; run herdr-app check on each mod installed or
              updated. Never installs programs.
  --yes       --apply, then install missing programs, then report again.
  --link      Mods become symlinks to the checkout's mods/<name> instead of copies.
  --no-keys   Leave keys.json alone.
  --app-home  Herdr App home. Default: $HERDR_APP_HOME or ~/.config/herdr-app.
  -h, --help  Usage.
`;

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAC_APP = "/Applications/Herdr.app/Contents/MacOS/Herdr";
let stats = { problems: 0, pending: 0 };
let apply = false;

function usage(msg) {
  process.stderr.write(`${msg}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = {
    mode: "check",
    link: false,
    keys: true,
    appHome: process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check" || a === "--apply" || a === "--yes") o.mode = a.slice(2);
    else if (a === "--link") o.link = true;
    else if (a === "--no-keys") o.keys = false;
    else if (a === "--app-home" && i + 1 < argv.length) o.appHome = path.resolve(argv[++i]);
    else if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else usage(`Unknown option: ${a}`);
  }
  return o;
}

// ---- output ----------------------------------------------------------------

const head = (title) => console.log(`\n${title}`);
const line = (status, msg) => console.log(`  ${status.padEnd(8)} ${msg}`);
function say(status, msg) {
  line(status, msg);
  if (["missing", "failed", "skip"].includes(status)) stats.problems++;
  else if (!apply && ["install", "update"].includes(status)) stats.pending++;
}

// ---- filesystem helpers ----------------------------------------------------

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const realOr = (p, fallback = null) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return fallback;
  }
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const byName = (a, b) => (a.name < b.name ? -1 : 1);
const listDir = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).sort(byName);
  } catch {
    return [];
  }
};

// A failed write must not leave its temp file behind: inside a mod dir it
// would later read as a user-added file.
function viaTemp(dst, fill) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    fill(tmp);
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function atomicWrite(file, data, mode) {
  viaTemp(file, (tmp) => {
    fs.writeFileSync(tmp, data);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
  });
}

function atomicCopy(src, dst) {
  viaTemp(dst, (tmp) => {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, fs.statSync(src).mode & 0o777);
  });
}

// ---- programs and versions -------------------------------------------------

const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const allOnPath = (name) =>
  (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, name))
    .filter(isExec);
const onPath = (name) => allOnPath(name)[0] || null;

const parseVer = (s) => {
  const m = /\d+\.\d+(\.\d+)?/.exec(s || "");
  return m ? m[0].split(".").map(Number) : null;
};
function older(have, min) {
  const a = parseVer(have);
  const b = parseVer(min);
  if (!a || !b) return !a;
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0;
  }
  return false;
}
function versionOf(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return `${r.stdout || ""}${r.stderr || ""}`;
}

function findProgram(name, spec) {
  let p = onPath(name);
  if (!p && name === "node" && isExec(process.execPath)) p = process.execPath;
  if (!p) return { ok: false, detail: "not found" };
  const min = spec.version?.min;
  if (min) {
    const have = versionOf(p);
    if (older(have, min)) return { ok: false, detail: `${parseVer(have)?.join(".") ?? "unknown version"} is older than ${min}` };
  }
  return { ok: true, detail: p };
}

function pickInstaller(spec) {
  const i = spec.install || {};
  const sudo = process.getuid?.() === 0 ? [] : ["sudo"];
  if (process.platform === "darwin" && onPath("brew")) {
    if (i.brewCask) return { cmd: ["brew", "install", "--cask", i.brewCask] };
    if (i.brew) return { cmd: ["brew", "install", i.brew] };
  }
  if (process.platform === "linux") {
    const managers = [
      ["pacman", "pacman", ["-S", "--needed", "--noconfirm"]],
      ["apt", "apt-get", ["install", "-y"]],
      ["dnf", "dnf", ["install", "-y"]],
    ];
    for (const [key, bin, args] of managers) {
      if (i[key] && onPath(bin)) return { cmd: [...sudo, bin, ...args, i[key]] };
    }
  }
  if (i.script) return { cmd: ["sh", "-c", 'f=$(mktemp) || exit 1; curl -fsSL "$1" -o "$f" && bash "$f"; s=$?; rm -f "$f"; exit $s', "sh", i.script], env: i.env, label: `curl -fsSL ${i.script} | bash` };
  return null;
}

// ---- 1-2. Herdr App and programs -------------------------------------------

function checkHerdrApp(req) {
  head("Herdr App");
  const bin = onPath("herdr-app") || (process.platform === "darwin" && isExec(MAC_APP) ? MAC_APP : null);
  if (!bin) {
    say("missing", "herdr-app not found on PATH");
    return null;
  }
  const have = versionOf(bin);
  const min = req.herdrApp?.minVersion;
  if (min && older(have, min)) say("missing", `${bin}: ${have.trim() || "unknown version"} is older than ${min}`);
  else say("ok", `${bin} ${parseVer(have)?.join(".") ?? ""}`.trim());
  return bin;
}

function checkPrograms(req) {
  head("Programs");
  const missing = [];
  for (const [name, spec] of Object.entries(req.programs || {})) {
    if (spec.os && !spec.os.includes(process.platform)) continue;
    const r = findProgram(name, spec);
    if (r.ok) {
      say("ok", `${name}`);
      continue;
    }
    missing.push({ name, spec });
    const pick = pickInstaller(spec);
    const how = pick ? `run: ${pick.label || pick.cmd.join(" ")}` : spec.install?.hint || "no installer for this system";
    const mods = spec.mods?.length ? ` (mods: ${spec.mods.join(", ")})` : "";
    say(spec.required ? "missing" : "warn", `${name}: ${r.detail}. ${spec.why || ""}${mods} ${how}`);
  }
  return missing;
}

// ---- 3. pack items ---------------------------------------------------------

const machine = (rel) => {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  return parts[0] === "bin" || parts.includes("node_modules") || ["runtime.json", "jsconfig.json"].includes(base) || base.endsWith(".d.ts");
};

// Hashes of an item's files; a plain file is {"": sha}.
function snap(p, type) {
  if (type === "file") return { "": sha(p) };
  const out = {};
  const walk = (rel) => {
    for (const e of listDir(path.join(p, rel))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (machine(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(path.join(p, r))}`;
      else out[r] = sha(path.join(p, r));
    }
  };
  walk("");
  return out;
}

function packItems() {
  const items = [];
  const add = (section, dir, type, pick) => {
    for (const e of listDir(path.join(packRoot, dir))) {
      if (type === "dir" ? e.isDirectory() : e.isFile() && pick.test(e.name)) {
        items.push({ section, key: `${dir}/${e.name}`, name: type === "dir" ? e.name : e.name.replace(/\.[^.]+$/, ""), type });
      }
    }
  };
  add("Mods", "mods", "dir");
  add("Layouts", "layouts", "file", /\.(json|svg)$/);
  add("Themes", "themes", "file", /\.json$/);
  return items;
}

const ownedRecord = (it, s) => (it.type === "dir" ? { type: "dir", files: s } : { type: "file", sha256: s[""] });

// Decide what to do with one item; `act` performs it (apply only).
function syncItem(it, o, items) {
  const S = path.join(packRoot, it.key);
  const T = path.join(o.appHome, it.key);
  const s = snap(S, it.type);
  const asLink = o.link && it.type === "dir";
  const put = (have = {}) => {
    if (asLink) {
      fs.rmSync(T, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(T), { recursive: true });
      fs.symlinkSync(S, T);
      items[it.key] = { type: "link" };
      return;
    }
    for (const rel of Object.keys(s)) if (have[rel] !== s[rel]) atomicCopy(rel ? path.join(S, rel) : S, rel ? path.join(T, rel) : T);
    for (const rel of Object.keys(have)) {
      if (rel in s) continue;
      fs.rmSync(path.join(T, rel), { force: true });
      for (let d = path.dirname(path.join(T, rel)); d !== T; d = path.dirname(d)) {
        try {
          fs.rmdirSync(d);
        } catch {
          break;
        }
      }
    }
    items[it.key] = ownedRecord(it, s);
  };

  const l = lstat(T);
  if (!l) return { status: "install", msg: asLink ? `${it.key} (symlink)` : it.key, act: put };
  if (l.isSymbolicLink()) {
    if (realOr(T) === realOr(S)) return { status: "ok", msg: `${it.key} (linked)`, act: () => (items[it.key] = { type: "link" }) };
    return { status: "skip", msg: `${it.key}: links elsewhere` };
  }
  if (l.isDirectory() !== (it.type === "dir")) return { status: "skip", msg: `${it.key}: not installed by herdr-glass` };

  const t = snap(T, it.type);
  if (isDeepStrictEqual(t, s)) {
    if (asLink) return { status: "update", msg: `${it.key}: replace identical copy by symlink`, act: put };
    return { status: "ok", msg: it.key, act: () => (items[it.key] = ownedRecord(it, s)) };
  }
  const own = items[it.key];
  const base = own?.type === it.type ? (it.type === "dir" ? own.files : { "": own.sha256 }) : null;
  if (!base) return { status: "skip", msg: `${it.key}: not installed by herdr-glass` };
  const edited = Object.keys({ ...t, ...base }).filter((k) => t[k] !== base[k]);
  if (edited.length) return { status: "skip", msg: `${it.key}: edited locally: ${edited.map((k) => k || path.basename(T)).join(", ")}` };
  return { status: "update", msg: it.key, act: () => put(t) };
}

function syncItems(o, shipped, manifest) {
  const usable = new Set();
  const touched = new Set();
  let section = "";
  for (const it of packItems()) {
    if (it.section !== section) head((section = it.section));
    const isShipped = it.section === "Mods" ? shipped.has(it.name) : it.section === "Layouts" && shipped.has(`layout:${it.name}`);
    if (isShipped) {
      line("ok", `${it.key}: shipped by Herdr, left alone`);
      continue;
    }
    const r = syncItem(it, o, manifest.items);
    say(r.status, r.msg);
    if (apply && r.status !== "skip") {
      try {
        r.act?.();
      } catch (e) {
        say("failed", `${it.key}: ${e.message}`);
        continue;
      }
    }
    if (it.section === "Mods" && r.status !== "skip") usable.add(it.name);
    if (it.section === "Mods" && (r.status === "install" || r.status === "update")) touched.add(it.name);
  }
  return { usable, touched };
}

// ---- 4. keys ---------------------------------------------------------------

function syncKeys(o) {
  head("Keys");
  const file = path.join(o.appHome, "keys.json");
  const frag = readJson(path.join(packRoot, "keys.fragment.json"));
  delete frag.$comment;
  const had = !!lstat(file);
  let keys = {};
  if (had) {
    try {
      keys = readJson(file);
      if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("not an object");
    } catch {
      say("failed", "keys.json does not parse; left alone");
      return;
    }
  }
  let added = 0;
  const conflicts = [];
  for (const [sec, binds] of Object.entries(frag)) {
    if (!Object.hasOwn(keys, sec)) keys[sec] = {};
    if (!keys[sec] || typeof keys[sec] !== "object") {
      conflicts.push(`[${sec}] is not a table`);
      continue;
    }
    for (const [k, v] of Object.entries(binds)) {
      if (!Object.hasOwn(keys[sec], k)) {
        keys[sec][k] = v;
        added++;
      } else if (!isDeepStrictEqual(keys[sec][k], v)) {
        conflicts.push(`[${sec}] ${k}: yours ${JSON.stringify(keys[sec][k])}, pack ${JSON.stringify(v)}`);
      }
    }
  }
  for (const c of conflicts) say("conflict", `keys.json ${c} (kept yours)`);
  if (!added) {
    say("ok", `keys.json: nothing to add, ${conflicts.length} conflict(s) kept`);
    return;
  }
  say("install", `keys.json: ${added} binding(s) added, ${conflicts.length} conflict(s) kept`);
  if (!apply) return;
  if (had) fs.copyFileSync(file, `${file}.bak-herdr-glass-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
  // Write through a symlink and keep the mode: keys.json may be managed elsewhere and private.
  const target = realOr(file, file);
  try {
    atomicWrite(target, `${JSON.stringify(keys, null, 2)}\n`, had ? fs.statSync(target).mode & 0o777 : undefined);
  } catch (e) {
    say("failed", `keys.json: ${e.message}`);
  }
}

// ---- 5. helpers ------------------------------------------------------------

function buildHelper(h, bin, stamp) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-glass-"));
  const run = (cmd, args, cwd, env = {}) => {
    // An inherited GIT_DIR would make git act on that repo instead of the temp dir.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const r = spawnSync(cmd, args, { cwd, env: { ...base, ...env }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  };
  try {
    run("git", ["init", "-q"], tmp);
    run("git", ["fetch", "-q", "--depth", "1", `https://github.com/${h.repo}.git`, h.commit], tmp, { GIT_TERMINAL_PROMPT: "0" });
    run("git", ["checkout", "-q", "FETCH_HEAD"], tmp);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    run("go", ["build", "-o", `${bin}.new`, "."], path.join(tmp, h.package), { GOWORK: "off" });
    fs.renameSync(`${bin}.new`, bin);
    atomicWrite(stamp, `${h.commit}\n`);
    return null;
  } catch (e) {
    fs.rmSync(`${bin}.new`, { force: true });
    return e.message;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function syncHelpers(req, o, usable) {
  head("Helpers");
  for (const [name, h] of Object.entries(req.helpers || {})) {
    if (!usable.has(h.mod)) continue;
    const modDir = path.join(o.appHome, "mods", h.mod);
    const dir = realOr(modDir, modDir);
    const bin = path.join(dir, h.binary);
    const stamp = path.join(dir, h.stamp);
    const what = `${name}: ${h.repo}@${h.commit.slice(0, 7)}`;
    if (isExec(bin) && readText(stamp)?.trim() === h.commit) {
      say("ok", what);
      continue;
    }
    const lacking = (h.needs || []).filter((n) => !onPath(n));
    if (lacking.length) {
      say("missing", `${name}: needs ${lacking.join(", ")} to build`);
      continue;
    }
    if (!apply) {
      say("install", `${what} would be built`);
      continue;
    }
    const err = buildHelper(h, bin, stamp);
    say(err ? "failed" : "install", err ? `${what}: ${err}` : `${what} built`);
  }
}

// ---- 6. Insights runtime ---------------------------------------------------

function syncRuntime(req, o, usable) {
  if (!usable.has("insights")) return;
  head("Insights runtime");
  const min = req.programs?.node?.version?.min;
  if (min && older(process.version, min)) {
    say("missing", `node ${process.version} is older than ${min}; runtime.json not written`);
    return;
  }
  const real = realOr(process.execPath);
  const node = allOnPath("node").find((p) => realOr(p) === real) || process.execPath;
  const file = path.join(o.appHome, "mods", "insights", "runtime.json");
  const want = `${JSON.stringify({ node })}\n`;
  const have = readText(file);
  if (have === want) {
    say("ok", `runtime.json: ${node}`);
    return;
  }
  say(have === null ? "install" : "update", `runtime.json: ${node}`);
  if (apply) atomicWrite(file, want);
}

// ---- 7. herdr-app check ----------------------------------------------------

function checkMods(app, o, touched) {
  if (!apply || !app || !touched.size) return;
  head("herdr-app check");
  for (const name of touched) {
    const r = spawnSync(app, ["check", path.join(o.appHome, "mods", name)], { encoding: "utf8" });
    if (r.status === 0) say("ok", name);
    else say("failed", `${name}: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  }
}

// ---- 8. layout references --------------------------------------------------

function layoutRefs(o, shipped) {
  head("Layout references");
  if (!shipped.size) {
    say("warn", "installed.json not found: start Herdr App once, then rerun to check layout references");
    return;
  }
  const known = new Set(listDir(path.join(packRoot, "mods")).map((e) => e.name));
  for (const k of shipped) if (!k.startsWith("layout:")) known.add(k);
  for (const e of listDir(path.join(o.appHome, "mods"))) known.add(e.name);
  const collect = (v, refs) => {
    if (Array.isArray(v)) return v.forEach((x) => collect(x, refs));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "mod" && typeof x === "string") refs.add(x);
      if (k === "link_handlers" && Array.isArray(x)) x.filter((n) => typeof n === "string").forEach((n) => refs.add(n));
      collect(x, refs);
    }
  };
  let warned = 0;
  for (const e of listDir(path.join(packRoot, "layouts"))) {
    if (!e.name.endsWith(".json")) continue;
    const refs = new Set();
    try {
      collect(readJson(path.join(packRoot, "layouts", e.name)), refs);
    } catch {
      say("warn", `layouts/${e.name}: not valid JSON`);
      continue;
    }
    for (const r of refs) {
      if (known.has(r)) continue;
      say("warn", `layouts/${e.name} needs mod ${r}, which is not in the pack or the Herdr App`);
      warned++;
    }
  }
  if (!warned) say("ok", "every referenced mod is available");
}

// ---- 9. --yes --------------------------------------------------------------

function installPrograms(missing) {
  head("Install programs");
  for (const { name, spec } of missing) {
    const pick = pickInstaller(spec);
    if (!pick) {
      line("missing", `${name}: ${spec.install?.hint || "no installer for this system"}`);
      continue;
    }
    line("install", `${name}: ${pick.label || pick.cmd.join(" ")}`);
    const r = spawnSync(pick.cmd[0], pick.cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...pick.env } });
    if (r.status !== 0) line("failed", `${name}: installer exited ${r.status ?? r.error?.message}`);
  }
}

// ---- main ------------------------------------------------------------------

function run(o, req) {
  stats = { problems: 0, pending: 0 };
  const app = checkHerdrApp(req);
  const missing = checkPrograms(req);
  const manFile = path.join(o.appHome, ".herdr-glass.json");
  let old = null;
  try {
    old = readJson(manFile);
  } catch {}
  const manifest = { version: 1, root: packRoot, items: { ...(old?.version === 1 ? old.items : {}) } };
  let shipped = new Set();
  try {
    shipped = new Set(Object.keys(readJson(path.join(o.appHome, "installed.json"))));
  } catch {}

  const { usable, touched } = syncItems(o, shipped, manifest);
  if (o.keys) syncKeys(o);
  syncHelpers(req, o, usable);
  syncRuntime(req, o, usable);
  checkMods(app, o, touched);
  layoutRefs(o, shipped);
  if (apply && !isDeepStrictEqual(old, manifest)) atomicWrite(manFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { missing };
}

function summarize(missing) {
  const bad = stats.problems > 0 || stats.pending > 0;
  head(bad ? `${stats.problems} problem(s), ${stats.pending} item(s) to install or update` : "Nothing missing or out of date");
  const yes = missing.length ? "; scripts/install.sh --yes also installs missing programs" : "";
  if (!bad) console.log("Switch layout: herdr-app do layout.switch --name glass");
  else if (!apply) console.log(`Run scripts/install.sh --apply${yes}`);
  else console.log(`Fix the problems above${yes}`);
  process.exitCode = bad ? 1 : 0;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!["darwin", "linux"].includes(process.platform)) usage(`Unsupported platform: ${process.platform}`);
  let req;
  try {
    req = readJson(path.join(packRoot, "requirements.json"));
  } catch (e) {
    console.error(`Cannot read requirements.json: ${e.message}`);
    process.exit(1);
  }
  apply = o.mode !== "check";
  let r = run(o, req);
  if (o.mode === "yes" && r.missing.length) {
    installPrograms(r.missing);
    head("Report after installing programs");
    r = run(o, req);
  }
  summarize(r.missing);
}

main();
