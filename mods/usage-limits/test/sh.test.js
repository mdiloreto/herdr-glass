import "./stubs/hooks.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { host, resetHost } from "./stubs/host.mjs";

const GIT_CORE = "C:/Program Files/Git/mingw64/libexec/git-core";
const GIT_SH = "C:/Program Files/Git/bin/sh.exe";

async function freshRunSh() {
  const { runSh } = await import(`../io/sh.js?${Math.random()}`);
  return runSh;
}

function windowsWithoutSh(onTimeout = false) {
  resetHost();
  host.exec = async (bin) => {
    if (bin === "sh") throw new Error(onTimeout ? "timed out" : "cannot run sh: not found");
    if (bin === "git") return { code: 0, stdout: `${GIT_CORE}\n` };
    return { code: 0, stdout: "ok" };
  };
}

test("on Windows git is on PATH but its sh is not: the helper runs with the sh next to git, and keeps using it", async () => {
  windowsWithoutSh();
  const runSh = await freshRunSh();
  assert.deepEqual(await runSh(["helper.sh"]), { code: 0, stdout: "ok" });
  host.execs.length = 0;
  await runSh(["again.sh"], { timeout: 5 });
  assert.deepEqual(host.execs, [[GIT_SH, ["again.sh"], { timeout: 5 }]]);
});

test("a helper that timed out is not retried with another shell", async () => {
  windowsWithoutSh(true);
  const runSh = await freshRunSh();
  await assert.rejects(runSh(["helper.sh"]), /timed out/);
  assert.deepEqual(host.execs.map(([bin]) => bin), ["sh"]);
});

test("without git either, the shell's own error is what fails", async () => {
  resetHost();
  host.exec = async () => { throw new Error("cannot run sh"); };
  const runSh = await freshRunSh();
  await assert.rejects(runSh(["helper.sh"]), /cannot run sh/);
});
