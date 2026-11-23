#!/usr/bin/env node
// Copies third-party content listed in vendor.json from upstream at a pinned
// commit, unchanged, so the pack ships it without hand edits. vendor.json is
// trusted but typo-prone and the upstream tree is not: sources that escape the
// checkout or are symlinks are refused, destinations are limited to fixed
// patterns under real (non-symlink) pack directories, and nothing in the pack
// is touched until every entry has been fetched and validated.
import { execFileSync } from "node:child_process";
import {
  copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  realpathSync, rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
const NOTICE_NAMES = ["NOTICE", "NOTICE.md", "NOTICE.txt"];
const DEST_PATTERNS = [
  /^mods\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  /^layouts\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(json|svg)$/,
];
const PACK_DIRS = ["mods", "layouts", "LICENSES"];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

const inside = (base, target) => target === base || target.startsWith(base + sep);

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

function assertNoSymlinks(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
  }
}

// Case-insensitive, since .GIT is .git on macOS volumes.
const inGitDir = (checkout, path) => relative(checkout, path).toLowerCase().split(sep).includes(".git");

function safeSource(checkout, rel) {
  const abs = resolve(checkout, rel);
  if (!inside(checkout, abs)) throw new Error(`source escapes checkout: ${rel}`);
  if (abs === checkout || inGitDir(checkout, abs)) {
    throw new Error(`source must be a path below the checkout, outside .git: ${rel}`);
  }
  assertNoSymlinks(abs);
  const real = realpathSync(abs);
  if (!inside(checkout, real) || real === checkout || inGitDir(checkout, real)) {
    throw new Error(`source escapes checkout or reaches .git: ${rel}`);
  }
  return abs;
}

function assertPackDirs() {
  for (const name of PACK_DIRS) {
    const st = lstatOrNull(join(root, name));
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new Error(`${name} must be a real directory, not a symlink`);
    }
  }
}

function assertNotSymlink(path) {
  if (lstatOrNull(path)?.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
}

function findFile(checkout, names) {
  return names.map((n) => join(checkout, n)).find((p) => lstatOrNull(p)?.isFile());
}

const entries = JSON.parse(await readFile(join(root, "vendor.json"), "utf8"));
const tmps = [];

try {
  assertPackDirs();

  // Phase 1: validate and fetch everything; the pack is not touched.
  const seen = new Set();
  const plan = [];
  const outputs = new Set();
  for (const { repo, commit, paths, notices } of entries) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo: ${repo}`);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit: ${commit}`);
    for (const dest of Object.keys(paths)) {
      if (!DEST_PATTERNS.some((re) => re.test(dest))) throw new Error(`bad destination: ${dest}`);
      if (seen.has(dest)) throw new Error(`duplicate destination: ${dest}`);
      seen.add(dest);
    }

    const tmp = mkdtempSync(join(tmpdir(), "vendor-"));
    tmps.push(tmp);
    const checkout = realpathSync(tmp);
    git(checkout, "init", "-q");
    git(checkout, "remote", "add", "origin", `https://github.com/${repo}.git`);
    git(checkout, "fetch", "-q", "--filter=blob:none", "--depth=1", "origin", commit);
    git(checkout, "-c", "advice.detachedHead=false", "checkout", "-q", commit);

    const copies = Object.entries(paths).map(([dest, src]) => {
      const to = join(root, dest);
      assertNotSymlink(to);
      return { from: safeSource(checkout, src), to, label: `${repo}@${commit.slice(0, 7)} ${src}` };
    });

    // A repo pinned at several commits keeps one license set per commit, since
    // NOTICE text can differ between them.
    const shared = entries.filter((e) => e.repo === repo).length > 1;
    const slug = repo.replace("/", "-") + (shared ? `-${commit.slice(0, 7)}` : "");
    const license = findFile(checkout, LICENSE_NAMES);
    if (!license) throw new Error(`no license file in ${repo}@${commit}`);
    const files = [{ from: license, to: join(root, "LICENSES", `${slug}.txt`) }];
    const notice = findFile(checkout, NOTICE_NAMES);
    if (notice) files.push({ from: notice, to: join(root, "LICENSES", `${slug}.NOTICE.txt`) });
    // Notices that upstream keeps outside the vendored paths.
    for (const rel of notices ?? []) {
      const from = safeSource(checkout, rel);
      if (!lstatSync(from).isFile()) throw new Error(`notice is not a regular file: ${rel}`);
      files.push({ from, to: join(root, "LICENSES", `${slug}.${basename(rel)}`) });
    }
    for (const f of files) {
      assertNotSymlink(f.to);
      if (outputs.has(f.to)) throw new Error(`duplicate license output: ${relative(root, f.to)}`);
      outputs.add(f.to);
    }

    plan.push({ copies, files });
  }

  // Phase 2: write.
  for (const name of PACK_DIRS) mkdirSync(join(root, name), { recursive: true });
  assertPackDirs();
  for (const { copies, files } of plan) {
    for (const { from, to, label } of copies) {
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
      console.log(`${label} -> ${relative(root, to)}`);
    }
    for (const { from, to } of files) copyFileSync(from, to);
  }
} finally {
  for (const tmp of tmps) rmSync(tmp, { recursive: true, force: true });
}
