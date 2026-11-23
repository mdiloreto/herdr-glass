#!/usr/bin/env node
// Copies third-party content listed in vendor.json from upstream at a pinned
// commit, unchanged, so the pack ships it without hand edits. Source paths that
// escape the checkout or are symlinks are refused: vendor.json is trusted, the
// upstream tree is not.
import { execFileSync } from "node:child_process";
import {
  copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  realpathSync, rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
const NOTICE_NAMES = ["NOTICE", "NOTICE.md", "NOTICE.txt"];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

const inside = (base, target) => target === base || target.startsWith(base + sep);

function assertNoSymlinks(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
  }
}

function safeSource(checkout, rel) {
  const abs = resolve(checkout, rel);
  if (!inside(checkout, abs)) throw new Error(`source escapes checkout: ${rel}`);
  assertNoSymlinks(abs);
  if (!inside(checkout, realpathSync(abs))) throw new Error(`source escapes checkout: ${rel}`);
  return abs;
}

function safeDest(rel) {
  const abs = resolve(root, rel);
  if (abs === root || !inside(root, abs)) throw new Error(`destination escapes pack: ${rel}`);
  return abs;
}

function copyLicense(checkout, names, out) {
  for (const name of names) {
    const src = join(checkout, name);
    try {
      if (!lstatSync(src).isFile()) continue;
    } catch {
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
    return true;
  }
  return false;
}

const entries = JSON.parse(await readFile(join(root, "vendor.json"), "utf8"));

for (const { repo, commit, paths } of entries) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo: ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit: ${commit}`);
  const tmp = mkdtempSync(join(tmpdir(), "vendor-"));
  try {
    const checkout = realpathSync(tmp);
    git(checkout, "init", "-q");
    git(checkout, "remote", "add", "origin", `https://github.com/${repo}.git`);
    git(checkout, "fetch", "-q", "--filter=blob:none", "--depth=1", "origin", commit);
    git(checkout, "-c", "advice.detachedHead=false", "checkout", "-q", commit);

    for (const [dest, src] of Object.entries(paths)) {
      const from = safeSource(checkout, src);
      const to = safeDest(dest);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      console.log(`${repo}@${commit.slice(0, 7)} ${src} -> ${relative(root, to)}`);
    }

    // A repo pinned at several commits keeps one license set per commit, since
    // NOTICE text can differ between them.
    const shared = entries.filter((e) => e.repo === repo).length > 1;
    const slug = repo.replace("/", "-") + (shared ? `-${commit.slice(0, 7)}` : "");
    if (!copyLicense(checkout, LICENSE_NAMES, join(root, "LICENSES", `${slug}.txt`))) {
      throw new Error(`no license file in ${repo}`);
    }
    copyLicense(checkout, NOTICE_NAMES, join(root, "LICENSES", `${slug}.NOTICE.txt`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
