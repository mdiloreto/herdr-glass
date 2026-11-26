const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requirements = JSON.parse(fs.readFileSync(path.join(root, "requirements.json"), "utf8"));
const vendor = JSON.parse(fs.readFileSync(path.join(root, "vendor.json"), "utf8"));

const EXEC_RE = /(?<![\w$.])(?:env\.)?exec\(\s*(["'`])([^"'`]+)\1/g;
const INSTALL_KEYS = ["brew", "brewCask", "pacman", "apt", "dnf", "script", "env", "hint"];
const HELPER_KEYS = ["why", "mod", "repo", "commit", "package", "binary", "stamp", "needs"];
const SHIPPED_MODS = ["worktree"];

const modsDir = path.join(root, "mods");
const localMods = fs.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const vendoredMods = vendor.flatMap((v) => Object.values(v.paths))
  .filter((dest) => /^mods\/[^/]+$/.test(dest)).map((dest) => dest.slice("mods/".length));
const packMods = new Set([...localMods, ...vendoredMods]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "bin") continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function execCalls() {
  const calls = [];
  for (const file of walk(modsDir)) {
    const mod = path.relative(modsDir, file).split(path.sep)[0];
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(EXEC_RE)) {
      // A template path such as `${appHome()}/mods/x/bin/tool` is a mod's own helper, listed under helpers.
      if (match[2].startsWith("${")) continue;
      calls.push({ mod, program: match[2], file });
    }
  }
  return calls;
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

test("exec pattern matches Herdr exec calls only", () => {
  const find = (src) => [...src.matchAll(EXEC_RE)].map((m) => m[2]);
  assert.deepEqual(find('exec("git", ["status"])'), ["git"]);
  assert.deepEqual(find('env.exec("rm", ["-f", x])'), ["rm"]);
  assert.deepEqual(find('db.exec("BEGIN")'), []);
  assert.deepEqual(find('/re/.exec("x")'), []);
});

test("requirements.json follows the schema", () => {
  assert.match(requirements.herdrApp.minVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(isStringArray(requirements.system));

  const programs = Object.entries(requirements.programs);
  assert.ok(programs.length > 0);
  for (const [name, p] of programs) {
    assert.equal(typeof p.why, "string", `${name}.why`);
    assert.equal(typeof p.required, "boolean", `${name}.required`);
    assert.ok(isStringArray(p.mods) && p.mods.length > 0, `${name}.mods`);
    if (p.os !== undefined) {
      assert.ok(isStringArray(p.os) && p.os.every((o) => ["darwin", "linux"].includes(o)), `${name}.os`);
    }
    if (p.version !== undefined) assert.match(p.version.min, /^\d+\.\d+\.\d+$/, `${name}.version.min`);

    const install = p.install;
    assert.ok(install && typeof install === "object", `${name}.install`);
    const keys = Object.keys(install);
    assert.ok(keys.length > 0, `${name}.install is empty`);
    for (const key of keys) assert.ok(INSTALL_KEYS.includes(key), `${name}.install.${key} is not allowed`);
    for (const key of ["brew", "brewCask", "pacman", "apt", "dnf", "hint"]) {
      if (key in install) assert.equal(typeof install[key], "string", `${name}.install.${key}`);
    }
    if ("script" in install) assert.match(install.script, /^https:\/\//, `${name}.install.script`);
    if ("env" in install) {
      assert.ok(Object.values(install.env).every((v) => typeof v === "string"), `${name}.install.env`);
    }
  }

  for (const [name, h] of Object.entries(requirements.helpers)) {
    assert.deepEqual(Object.keys(h).sort(), [...HELPER_KEYS].sort(), `${name} keys`);
    assert.match(h.commit, /^[0-9a-f]{40}$/, `${name}.commit`);
    assert.match(h.repo, /^[\w.-]+\/[\w.-]+$/, `${name}.repo`);
    for (const key of ["binary", "stamp"]) {
      assert.ok(!path.isAbsolute(h[key]) && !h[key].split("/").includes(".."), `${name}.${key}`);
    }
    assert.ok(isStringArray(h.needs), `${name}.needs`);
    for (const need of h.needs) assert.ok(need in requirements.programs, `${name} needs unknown program ${need}`);
  }
});

test("every mod exec call is covered by requirements.json", () => {
  const system = new Set(requirements.system);
  for (const { mod, program, file } of execCalls()) {
    if (system.has(program)) continue;
    const entry = requirements.programs[program];
    const where = path.relative(root, file);
    assert.ok(entry, `${where} runs "${program}", which is in neither system nor programs`);
    assert.ok(entry.mods.includes(mod), `${where} runs "${program}", but programs.${program}.mods lacks "${mod}"`);
  }
});

test("mod names in requirements.json exist in the pack", () => {
  const names = [
    ...Object.values(requirements.programs).flatMap((p) => p.mods),
    ...Object.values(requirements.helpers).map((h) => h.mod),
  ];
  for (const name of names) assert.ok(packMods.has(name), `"${name}" is not a mod in mods/ or vendor.json`);
});

test("keys.fragment.json names only known mods", () => {
  const fragment = JSON.parse(fs.readFileSync(path.join(root, "keys.fragment.json"), "utf8"));
  const known = new Set([...packMods, ...SHIPPED_MODS]);
  const opened = [];
  const visit = (value) => {
    if (typeof value === "string") {
      const m = /^mod\.open:(.+)$/.exec(value);
      if (m) opened.push(m[1]);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(fragment);
  assert.ok(opened.length > 0);
  for (const name of opened) assert.ok(known.has(name), `mod.open:${name} names no pack or shipped mod`);
});
