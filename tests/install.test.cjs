const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const COMMIT = "9bd1f7e9a55a264563bfd82d2552502fda1cca6d";

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

function systemTool(name) {
  for (const d of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  }
  throw new Error(`system tool not found: ${name}`);
}

// PATH holds only fake programs and the few system tools the scripts need,
// so the host's real node, pacman, sudo, go and brew never leak in.
function makeBin(dir, withNode) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ["sh", "dirname", "chmod", "git"]) fs.symlinkSync(systemTool(t), path.join(dir, t));
  if (withNode) fs.symlinkSync(process.execPath, path.join(dir, "node"));
}

function build(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glass-install-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const pack = path.join(tmp, "pack");
  const app = path.join(tmp, "app");
  const bin = path.join(tmp, "bin");
  const log = path.join(tmp, "calls.log");
  for (const f of ["install.mjs", "install.sh"]) {
    write(path.join(pack, "scripts", f), fs.readFileSync(path.join(repo, "scripts", f)), 0o755);
  }
  write(
    path.join(pack, "requirements.json"),
    JSON.stringify({
      herdrApp: { minVersion: "0.1.16" },
      system: ["sh"],
      programs: {
        node: { why: "Runs mods.", required: true, mods: ["insights"], version: { min: "18.0.0" }, install: { hint: "https://nodejs.org" } },
        "tool-a": {
          why: "Alpha tool.",
          required: true,
          mods: ["alpha"],
          os: ["darwin", "linux"],
          install: { brew: "tool-a", pacman: "tool-a", apt: "tool-a", dnf: "tool-a" },
        },
      },
      helpers: {
        "branch-pr": {
          why: "PR helper.",
          mod: "branch-pr",
          repo: "example/herdr-mods",
          commit: COMMIT,
          package: "branch-pr/helper",
          binary: "bin/herdr-pr",
          stamp: "bin/.herdr-pr.rev",
          needs: ["git", "go"],
        },
      },
    }),
  );
  for (const m of ["alpha", "insights", "branch-pr"]) {
    write(path.join(pack, "mods", m, "mod.json"), JSON.stringify({ name: m }));
    write(path.join(pack, "mods", m, "main.js"), `// ${m} v1\n`);
  }
  write(path.join(pack, "layouts", "glass.json"), JSON.stringify({ panes: [{ mod: "alpha" }, { mod: "nope" }], link_handlers: ["alpha"] }));
  write(path.join(pack, "layouts", "glass.svg"), "<svg/>");
  write(path.join(pack, "themes", "glass.json"), JSON.stringify({ name: "glass" }));
  write(
    path.join(pack, "keys.fragment.json"),
    JSON.stringify({
      $comment: "fixture",
      global: { "ctrl-space c": "tab.new", "ctrl-space N": { command: "space.new", args: { folder: "" } } },
      "layout:glass": { "alt-1": "pane.focus" },
    }),
  );

  makeBin(bin, true);
  write(path.join(bin, "herdr-app"), `#!/bin/sh\ncase "$1" in\n  --version) echo "herdr-app 0.1.18" ;;\n  check) echo "$@" >> "${log}" ;;\nesac\n`, 0o755);
  write(path.join(bin, "tool-a"), "#!/bin/sh\necho tool-a 1.0.0\n", 0o755);
  return { tmp, pack, app, bin, log };
}

function run(f, args, { path: pathEnv = f.bin } = {}) {
  const r = spawnSync(process.execPath, [path.join(f.pack, "scripts", "install.mjs"), ...args, "--app-home", f.app], {
    encoding: "utf8",
    env: { PATH: pathEnv, HOME: f.tmp },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function dump(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const l = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (l.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (l.isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else out[rel] = `${fs.readFileSync(p, "utf8")}@${l.mtimeMs}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const stampHelper = (f) => {
  write(path.join(f.app, "mods", "branch-pr", "bin", "herdr-pr"), "#!/bin/sh\n", 0o755);
  write(path.join(f.app, "mods", "branch-pr", "bin", ".herdr-pr.rev"), `${COMMIT}\n`);
};

test("default check reports installs and writes nothing", (t) => {
  const f = build(t);
  const r = run(f, []);
  assert.equal(r.status, 1);
  assert.match(r.out, /install\s+mods\/alpha/);
  assert.equal(fs.existsSync(f.app), false);
});

test("apply installs everything; a second apply changes nothing", (t) => {
  const f = build(t);
  const first = run(f, ["--apply"]);
  assert.equal(first.status, 1, "helper cannot build without go");
  for (const p of ["mods/alpha/main.js", "mods/insights/main.js", "layouts/glass.json", "layouts/glass.svg", "themes/glass.json", "keys.json"]) {
    assert.ok(fs.existsSync(path.join(f.app, p)), p);
  }
  const manifest = JSON.parse(read(f.app, ".herdr-glass.json"));
  assert.equal(manifest.root, f.pack);
  assert.ok(manifest.items["mods/alpha"].files["main.js"]);
  assert.ok(manifest.items["layouts/glass.json"].sha256);
  assert.equal(JSON.parse(read(f.app, "keys.json")).global["ctrl-space c"], "tab.new");
  assert.deepEqual(JSON.parse(read(f.app, "mods/insights/runtime.json")), { node: path.join(f.bin, "node") });
  const calls = read(f.log).trim().split("\n").sort();
  assert.deepEqual(calls, ["alpha", "branch-pr", "insights"].map((m) => `check ${path.join(f.app, "mods", m)}`));

  stampHelper(f);
  const before = dump(f.app);
  const second = run(f, ["--apply"]);
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(dump(f.app), before);
  assert.equal(read(f.log).trim().split("\n").length, 3);
});

test("local edit survives a pack update and is reported", (t) => {
  const f = build(t);
  run(f, ["--apply"]);
  write(path.join(f.app, "mods", "alpha", "main.js"), "// mine\n");
  write(path.join(f.pack, "mods", "alpha", "main.js"), "// alpha v2\n");
  const r = run(f, ["--apply"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /skip\s+mods\/alpha: edited locally: main\.js/);
  assert.equal(read(f.app, "mods/alpha/main.js"), "// mine\n");
});

test("unedited owned mod is updated, new files added, dropped files removed", (t) => {
  const f = build(t);
  write(path.join(f.pack, "mods", "alpha", "old.js"), "old\n");
  run(f, ["--apply"]);
  assert.ok(fs.existsSync(path.join(f.app, "mods/alpha/old.js")));
  write(path.join(f.pack, "mods", "alpha", "main.js"), "// alpha v2\n");
  write(path.join(f.pack, "mods", "alpha", "lib", "new.js"), "new\n");
  fs.rmSync(path.join(f.pack, "mods", "alpha", "old.js"));
  const r = run(f, ["--apply"]);
  assert.match(r.out, /update\s+mods\/alpha/);
  assert.equal(read(f.app, "mods/alpha/main.js"), "// alpha v2\n");
  assert.equal(read(f.app, "mods/alpha/lib/new.js"), "new\n");
  assert.equal(fs.existsSync(path.join(f.app, "mods/alpha/old.js")), false);
});

test("foreign mod with other content is left alone and reported", (t) => {
  const f = build(t);
  write(path.join(f.app, "mods", "alpha", "main.js"), "// foreign\n");
  const r = run(f, ["--apply"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /skip\s+mods\/alpha: not installed by herdr-glass/);
  assert.equal(read(f.app, "mods/alpha/main.js"), "// foreign\n");
  assert.deepEqual(fs.readdirSync(path.join(f.app, "mods", "alpha")), ["main.js"]);
});

test("items listed in installed.json are never written", (t) => {
  const f = build(t);
  write(path.join(f.app, "installed.json"), JSON.stringify({ alpha: {}, "layout:glass": {} }));
  const r = run(f, ["--apply"]);
  assert.match(r.out, /shipped by Herdr/);
  assert.equal(fs.existsSync(path.join(f.app, "mods", "alpha")), false);
  assert.equal(fs.existsSync(path.join(f.app, "layouts", "glass.json")), false);
  assert.equal(fs.existsSync(path.join(f.app, "layouts", "glass.svg")), false);
  assert.ok(fs.existsSync(path.join(f.app, "themes", "glass.json")));
});

test("keys merge is add-only, backs up, and compares objects deeply", (t) => {
  const f = build(t);
  const original = {
    global: { "ctrl-space c": "other", "ctrl-space N": { args: { folder: "" }, command: "space.new" }, mine: "x" },
    custom: { a: "b" },
  };
  write(path.join(f.app, "keys.json"), JSON.stringify(original));
  const r = run(f, ["--apply"]);
  assert.match(r.out, /conflict\s+keys\.json \[global\] ctrl-space c: yours "other", pack "tab\.new"/);
  assert.doesNotMatch(r.out, /conflict.*ctrl-space N/);
  const keys = JSON.parse(read(f.app, "keys.json"));
  assert.equal(keys.global["ctrl-space c"], "other");
  assert.equal(keys.global.mine, "x");
  assert.deepEqual(keys.global["ctrl-space N"], original.global["ctrl-space N"]);
  assert.deepEqual(keys.custom, { a: "b" });
  assert.deepEqual(keys["layout:glass"], { "alt-1": "pane.focus" });
  assert.equal(keys.$comment, undefined);
  const backups = fs.readdirSync(f.app).filter((n) => /^keys\.json\.bak-herdr-glass-\d{14}$/.test(n));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(read(f.app, backups[0])), original);
});

test("keys.json that does not parse is left alone", (t) => {
  const f = build(t);
  write(path.join(f.app, "keys.json"), "{ nope");
  const r = run(f, ["--apply"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /failed\s+keys\.json does not parse/);
  assert.equal(read(f.app, "keys.json"), "{ nope");
});

test("--link makes mods symlinks, is idempotent, and replaces identical copies", (t) => {
  const f = build(t);
  run(f, ["--apply"]);
  assert.equal(fs.lstatSync(path.join(f.app, "mods", "alpha")).isDirectory(), true);
  run(f, ["--apply", "--link"]);
  for (const m of ["alpha", "insights", "branch-pr"]) {
    const p = path.join(f.app, "mods", m);
    assert.equal(fs.lstatSync(p).isSymbolicLink(), true, m);
    assert.equal(fs.readlinkSync(p), path.join(f.pack, "mods", m));
  }
  assert.equal(fs.lstatSync(path.join(f.app, "layouts", "glass.json")).isSymbolicLink(), false);
  const before = dump(f.app);
  const again = run(f, ["--apply", "--link"]);
  assert.doesNotMatch(again.out, /^ +(install|update) /m);
  assert.deepEqual(dump(f.app), before);
});

test("helper without go is reported missing and nothing is fetched", (t) => {
  const f = build(t);
  const r = run(f, []);
  assert.equal(r.status, 1);
  assert.match(r.out, /missing\s+branch-pr: needs go/);
  const a = run(f, ["--apply"]);
  assert.match(a.out, /missing\s+branch-pr: needs go/);
  assert.equal(fs.existsSync(path.join(f.app, "mods", "branch-pr", "bin")), false);
});

test("--yes installs a missing program through the system package manager", (t) => {
  const f = build(t);
  fs.rmSync(path.join(f.bin, "tool-a"));
  const create = `printf '#!/bin/sh\\necho tool-a 1.0.0\\n' > "${path.join(f.bin, "tool-a")}"\nchmod +x "${path.join(f.bin, "tool-a")}"\n`;
  let expected;
  if (process.platform === "darwin") {
    write(path.join(f.bin, "brew"), `#!/bin/sh\necho "brew $@" >> "${f.log}.pm"\n${create}`, 0o755);
    expected = "brew install tool-a";
  } else {
    write(path.join(f.bin, "pacman"), `#!/bin/sh\necho "pacman $@" >> "${f.log}.pm"\n${create}`, 0o755);
    write(path.join(f.bin, "sudo"), '#!/bin/sh\nexec "$@"\n', 0o755);
    expected = "pacman -S --needed --noconfirm tool-a";
  }
  const r = run(f, ["--yes"]);
  assert.equal(read(`${f.log}.pm`).trim(), expected);
  const [first, final] = r.out.split("Report after installing programs");
  assert.match(first, /missing\s+tool-a/);
  assert.match(final, /ok\s+tool-a/);
});

test("layout referencing a mod outside the pack warns", (t) => {
  const f = build(t);
  assert.match(run(f, []).out, /warn\s+installed\.json not found/);
  write(path.join(f.app, "installed.json"), JSON.stringify({ agents: {} }));
  const r = run(f, []);
  assert.match(r.out, /warn\s+layouts\/glass\.json needs mod nope/);
  assert.doesNotMatch(r.out, /needs mod alpha/);
});

test("unknown option exits 2", (t) => {
  const f = build(t);
  const r = run(f, ["--bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /Unknown option: --bogus/);
  assert.match(r.err, /Usage:/);
});

test("install.sh runs the report, and explains when node is missing", (t) => {
  const f = build(t);
  const direct = run(f, ["--check"]);
  const viaSh = spawnSync("/bin/sh", [path.join(f.pack, "scripts", "install.sh"), "--check", "--app-home", f.app], {
    encoding: "utf8",
    env: { PATH: f.bin, HOME: f.tmp },
  });
  assert.equal(viaSh.status, 1);
  assert.equal(viaSh.stdout, direct.out);

  const bare = path.join(f.tmp, "bare");
  makeBin(bare, false);
  const noNode = spawnSync("/bin/sh", [path.join(f.pack, "scripts", "install.sh"), "--check"], {
    encoding: "utf8",
    env: { PATH: bare, HOME: f.tmp },
  });
  assert.equal(noNode.status, 1);
  assert.match(noNode.stderr, /Node\.js 22\.15\+ is required.*https:\/\/nodejs\.org/);
});
