const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const core = (name) => import(pathToFileURL(path.join(root, "mods", "fleet-resources", "core", name)).href);

const MIN = 60_000;
const HOUR = 60 * MIN;
const GIB = 2 ** 30;

// ---- fixtures --------------------------------------------------------------

function linuxOutput({
  stat = "cpu  1000 0 500 8000 500 0 0 0 0 0",
  available = 8000000,
  df = ["/dev/nvme0n1p2     1000000  500000    500000      50% /"],
  mount = ["/dev/nvme0n1p2 on / type ext4 (rw,relatime)"],
} = {}) {
  return [
    "@os", "Linux",
    "@stat", stat,
    "@cores", "16",
    "@load", "4.50 3.25 2.00 2/500 4321",
    "@mem",
    "MemTotal:       32000000 kB",
    `MemAvailable:   ${available} kB`,
    "SwapTotal:       4194304 kB",
    "SwapFree:        3145728 kB",
    "@df", "Filesystem     1024-blocks    Used Available Capacity Mounted on", ...df,
    "@mount", ...mount,
    "@end", "",
  ].join("\n");
}

const LINUX_DF = [
  "/dev/mapper/root     1000000  930000     70000      93% /var/log",
  "/dev/mapper/root     1000000  930000     70000      93% /",
  "/dev/mapper/root     1000000  930004     69996      93% /home",
  "devtmpfs              100000       0    100000       0% /dev",
  "tmpfs                 100000   99000      1000      99% /run",
  "tmpfs                 100000   20000     80000      20% /tmp",
  "efivarfs                 128     120         8      94% /sys/firmware/efi/efivars",
  "/dev/loop0             65000   65000         0     100% /snap/core/1",
  "/dev/sr0             4000000 4000000         0     100% /run/media/me/Install Disc",
  "/dev/loop1             90000   90000         0     100% /mnt/image",
  "<missing disk>        200000  100000    100000      50% /mnt/My Disk",
  "portal                     0       0         0        - /run/user/1000/doc",
  "empty                      0       0         0       0% /mnt/empty",
  "/dev/sdb1             500000  100000    400000      20% /mnt/ro",
];

const LINUX_MOUNT = [
  "/dev/mapper/root on / type btrfs (rw,relatime,subvol=/@)",
  "/dev/mapper/root on /home type btrfs (rw,relatime,subvol=/@home)",
  "/dev/mapper/root on /var/log type btrfs (rw,relatime,subvol=/@log)",
  "devtmpfs on /dev type devtmpfs (rw,nosuid)",
  "tmpfs on /run type tmpfs (rw,nosuid)",
  "tmpfs on /tmp type tmpfs (rw,nosuid,nodev)",
  "efivarfs on /sys/firmware/efi/efivars type efivarfs (rw,nosuid)",
  "/var/lib/snapd/snaps/core_1.snap on /snap/core/1 type squashfs (ro,nodev,relatime)",
  "/dev/sr0 on /run/media/me/Install Disc type iso9660 (ro,nosuid)",
  "/var/tmp/image.dmg on /mnt/image type hfsplus (ro,relatime)",
  "<missing disk> on /mnt/My Disk type fuseblk (rw,relatime)",
  "portal on /run/user/1000/doc type fuse.portal (rw,nosuid)",
  "empty on /mnt/empty type ext4 (rw)",
  "/dev/sdb1 on /mnt/ro type ext4 (ro,relatime)",
];

// Synthetic, in the formats macOS prints. The data volume's own df capacity (34%)
// differs from its container's use (40%).
const MAC_DF = [
  "Filesystem     1024-blocks      Used Available Capacity  Mounted on",
  "/dev/disk3s1s1   500000000  20000000 300000000     7%    /",
  "/dev/disk3s6     500000000  20000000 300000000     7%    /System/Volumes/VM",
  "/dev/disk3s2     500000000   8000000 300000000     3%    /System/Volumes/Preboot",
  "/dev/disk3s4     500000000   1000000 300000000     1%    /System/Volumes/Update",
  "/dev/disk1s2        500000      6000    490000     2%    /System/Volumes/xarts",
  "/dev/disk1s1        500000      6000    490000     2%    /System/Volumes/iSCPreboot",
  "/dev/disk1s3        500000      3000    490000     1%    /System/Volumes/Hardware",
  "/dev/disk3s5     500000000 150000000 300000000    34%    /System/Volumes/Data",
  "/dev/disk2s1       5000000   2000000   3000000    40%    /System/Volumes/Update/SFR/mnt1",
  "/dev/disk3s1     500000000  20000000 300000000     7%    /System/Volumes/Update/mnt1",
];

const MAC_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)",
  "/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)",
  "/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)",
  "/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)",
  "/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)",
  "/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)",
  "/dev/disk2s1 on /System/Volumes/Update/SFR/mnt1 (apfs, local, journaled, nobrowse)",
  "/dev/disk3s1 on /System/Volumes/Update/mnt1 (apfs, sealed, local, journaled, nobrowse)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
];

function macOutput({ pressure = 2, df = MAC_DF, mount = MAC_MOUNT } = {}) {
  return [
    "@os", "Darwin",
    "@cpu",
    "      cpu    load average",
    " us sy id   1m   5m   15m",
    "  5  5 90  2.00 2.50 3.00",
    " 20 20 60  2.00 2.50 3.00",
    "@cores", "8",
    "@load", "{ 2.00 2.50 3.00 }",
    "@mem", String(pressure), "total = 8192.00M  used = 7168.00M  free = 1024.00M  (encrypted)",
    "@df", ...df,
    "@mount", ...mount,
    "@end", "",
  ].join("\n");
}

// What the Linux process script prints.
const LINUX_PROCESSES = [
  "10 187.5", "11 95.0", "12 50.0", "13 40.0", "14 12.0", "15 1.0", "16 0.9", "17 0.5",
  "@comm",
  "/proc/10/comm:Web Content",
  "/proc/11/comm:node",
  "/proc/12/comm:top",
  "/proc/13/comm:sh",
  "/proc/14/comm:cc1plus",
  "/proc/15/comm:bash",
  "/proc/16/comm:idle",
  "",
].join("\n");

// ---- parsers ---------------------------------------------------------------

test("parses a Linux sample", async () => {
  const { parseSample } = await core("sample.mjs");
  const sample = parseSample(linuxOutput());
  assert.equal(sample.os, "Linux");
  assert.equal(sample.cpu, null);
  assert.deepEqual(sample.counters, { total: 10000, idle: 8500 });
  assert.equal(sample.cores, 16);
  assert.equal(sample.load, 4.5);
  assert.equal(sample.memAvailPct, 25);
  assert.equal(sample.pressure, null);
  assert.deepEqual(sample.swap, { used: 1 * GIB, total: 4 * GIB });
  assert.deepEqual(sample.disks, [{ mount: "/", pct: 50, freeKb: 500000 }]);
});

test("parses a macOS sample: second iostat row, pressure, swap, one real disk", async () => {
  const { parseSample } = await core("sample.mjs");
  const sample = parseSample(macOutput());
  assert.equal(sample.os, "Darwin");
  assert.equal(sample.cpu, 40);
  assert.equal(sample.cores, 8);
  assert.equal(sample.load, 2);
  assert.equal(sample.pressure, 2);
  assert.equal(sample.memAvailPct, null);
  assert.deepEqual(sample.swap, { used: 7 * GIB, total: 8 * GIB });
  assert.deepEqual(sample.disks, [{ mount: "/System/Volumes/Data", pct: 40, freeKb: 300000000 }]);
});

test("APFS use is the container's, rounded up; other filesystems keep df's capacity", async () => {
  const { parseDisks } = await core("sample.mjs");
  const row = (source, mount) => `${source} 1000 100 666 14% ${mount}`;
  const mac = parseDisks(
    [row("/dev/disk5s1", "/Volumes/apfs"), row("/dev/disk6s1", "/Volumes/usb")],
    ["/dev/disk5s1 on /Volumes/apfs (apfs, local)", "/dev/disk6s1 on /Volumes/usb (msdos, local)"],
    "Darwin",
  );
  assert.deepEqual(mac.map((d) => d.pct), [34, 14]);
  const linux = parseDisks([row("/dev/sda1", "/mnt")], ["/dev/sda1 on /mnt type apfs (rw)"], "Linux");
  assert.equal(linux[0].pct, 34);
});

test("filesystems sharing a source name stay apart; overlays count only at /", async () => {
  const { parseDisks } = await core("sample.mjs");
  const df = [
    "none     1000 100 900 10% /mnt/a",
    "none     2000 100 1900 5% /mnt/b",
    "none     1000 100 900 10% /mnt/a/copy",
    "overlay  3000 100 2900 4% /",
    "overlay  4000 100 3900 3% /var/lib/docker/overlay2/x/merged",
  ];
  const mount = [
    "none on /mnt/a type ext4 (rw)",
    "none on /mnt/b type ext4 (rw)",
    "none on /mnt/a/copy type ext4 (rw)",
    "overlay on / type overlay (rw)",
    "overlay on /var/lib/docker/overlay2/x/merged type overlay (rw)",
  ];
  assert.deepEqual(parseDisks(df, mount, "Linux").map((d) => d.mount), ["/mnt/a", "/mnt/b", "/"]);
});

test("network filesystems are left out", async () => {
  const { parseDisks } = await core("sample.mjs");
  const types = ["nfs", "nfs4", "cifs", "smb3", "smbfs", "afpfs", "webdav", "fuse.sshfs"];
  const df = types.map((type, i) => `host:/${type} ${1000 + i} 990 10 99% /mnt/${type}`);
  assert.deepEqual(parseDisks(df, types.map((t) => `host:/${t} on /mnt/${t} type ${t} (rw)`), "Linux"), []);
  assert.deepEqual(parseDisks(df, types.map((t) => `host:/${t} on /mnt/${t} (${t}, nodev)`), "Darwin"), []);
});

test("rejects incomplete output and leaves unreadable metrics unknown", async () => {
  const { parseSample } = await core("sample.mjs");
  assert.equal(parseSample(linuxOutput().replace("@end", "")), null);
  assert.equal(parseSample(""), null);
  const bare = parseSample("@os\nDarwin\n@cpu\n@mem\n@df\n@mount\n@end\n");
  assert.deepEqual(
    [bare.cpu, bare.pressure, bare.swap, bare.load, bare.cores, bare.disks],
    [null, null, null, null, null, []],
  );
  const linux = parseSample("@os\nLinux\n@end\n");
  assert.deepEqual([linux.counters, linux.memAvailPct, linux.swap], [null, null, null]);
});

test("filters Linux disks", async () => {
  const { parseSample } = await core("sample.mjs");
  const { disks } = parseSample(linuxOutput({ df: LINUX_DF, mount: LINUX_MOUNT }));
  assert.deepEqual(disks.map((d) => [d.mount, d.pct]), [
    ["/", 93],
    ["/tmp", 20],
    ["/mnt/My Disk", 50],
  ]);
});

test("skips a disk that mount does not describe", async () => {
  const { parseSample } = await core("sample.mjs");
  assert.deepEqual(parseSample(linuxOutput({ mount: [] })).disks, []);
});

test("counts macOS / only without a data volume, and skips mounted images", async () => {
  const { parseDisks } = await core("sample.mjs");
  const df = [
    "/dev/disk1s1   1000000  500000  500000  50%  /",
    "/dev/disk4s1    200000  200000       0 100%  /Volumes/My App (1.2)",
    "/dev/disk5s1    200000  100000  100000  50%  /Volumes/USB (backup)",
  ];
  const mount = [
    "/dev/disk1s1 on / (apfs, local, journaled)",
    "/dev/disk4s1 on /Volumes/My App (1.2) (hfs, local, nodev, nosuid, read-only, noowners, quarantine)",
    "/dev/disk5s1 on /Volumes/USB (backup) (msdos, local, nodev, nosuid, noowners)",
  ];
  assert.deepEqual(parseDisks(df, mount, "Darwin").map((d) => d.mount), ["/", "/Volumes/USB (backup)"]);
});

test("computes Linux CPU use between two readings", async () => {
  const { cpuBusy, parseSample } = await core("sample.mjs");
  const first = parseSample(linuxOutput()).counters;
  const second = parseSample(linuxOutput({ stat: "cpu  1600 0 800 8050 550 0 0 0 0 0" })).counters;
  assert.equal(cpuBusy(first, second), 90);
  assert.equal(cpuBusy(null, second), null);
  assert.equal(cpuBusy(first, null), null);
  assert.equal(cpuBusy(second, first), null);
});

test("names the top processes from the Linux script's output and from ps", async () => {
  const { parseProcesses } = await core("sample.mjs");
  assert.deepEqual(parseProcesses("Linux", LINUX_PROCESSES), [
    { cpu: 187.5, name: "Web Content" },
    { cpu: 95, name: "node" },
    { cpu: 12, name: "cc1plus" },
  ]);
  assert.deepEqual(parseProcesses("Linux", "\n@comm\n"), []);
  // A process gone before its name was read, and a name with a newline in it.
  assert.deepEqual(
    parseProcesses("Linux", "1 90.0\n2 80.0\n@comm\n/proc/2/comm:two\n/proc/2/comm:lines\n"),
    [{ cpu: 80, name: "two" }],
  );
  const ps = " 80.5 Google Chrome He\n 40.0 ps\n 12.0 sh\n  9.0 WindowServer\n  1.0 kernel_task\n  0.5 launchd\n";
  assert.deepEqual(parseProcesses("Darwin", ps), [
    { cpu: 80.5, name: "Google Chrome He" },
    { cpu: 9, name: "WindowServer" },
    { cpu: 1, name: "kernel_task" },
  ]);
  assert.deepEqual(parseProcesses("Darwin", "  0.5 launchd\n  0.0 cfprefsd\n"), []);
});

const realOs = { linux: "Linux", darwin: "Darwin" }[process.platform];
const sh = (script) => execFileSync("sh", ["-c", script], { encoding: "utf8", timeout: 10_000 });

test("the real sample script produces a complete sample here", { skip: !realOs }, async () => {
  const { SAMPLE_SCRIPT, parseSample } = await core("sample.mjs");
  const sample = parseSample(sh(SAMPLE_SCRIPT));
  assert.ok(sample, "no complete sample");
  assert.equal(sample.os, realOs);
  assert.ok(sample.cores >= 1);
  assert.equal(typeof sample.load, "number");
  assert.ok(sample.swap.total >= sample.swap.used);
  if (realOs === "Linux") {
    assert.ok(sample.counters.total > sample.counters.idle);
    assert.ok(sample.memAvailPct > 0 && sample.memAvailPct <= 100);
  } else {
    assert.ok(sample.cpu >= 0 && sample.cpu <= 100);
    assert.ok([1, 2, 4].includes(sample.pressure));
  }
  assert.ok(sample.disks.length > 0, "no disk survived the filters");
});

test("the real process script names processes here", { skip: !realOs }, async () => {
  const { PROCESS_SCRIPTS, parseProcesses } = await core("sample.mjs");
  const output = sh(PROCESS_SCRIPTS[realOs]);
  if (realOs === "Linux") {
    assert.match(output, /^\d+ [\d.]+$/m);
    assert.match(output, /^\/proc\/\d+\/comm:./m);
    assert.ok(output.split("\n").length <= 100, "output is bounded");
  } else assert.match(output, /^\s*[\d.]+\s+\S/m);
  // A quiet machine may have nothing busy enough to name.
  for (const p of parseProcesses(realOs, output)) assert.ok(p.name && p.cpu >= 1);
});

// Runs `script` with stand-ins for some programs ahead of the real ones.
function shWith(programs, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-resources-"));
  try {
    for (const [name, body] of Object.entries(programs)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return execFileSync("sh", ["-c", script], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const printing = (lines) => `cat <<'END'\n${lines.join("\n")}\nEND`;

test("Linux process names come from /proc, never from what top shows", { skip: realOs !== "Linux" }, async () => {
  const { PROCESS_SCRIPTS, parseProcesses } = await core("sample.mjs");
  const comm = fs.readFileSync(`/proc/${process.pid}/comm`, "utf8").trim();
  // A configured top: other column order, full command lines.
  const header = "USER      PID  %MEM  %CPU COMMAND";
  const top = printing([
    "top - 10:00:00", header, `me ${process.pid} 0.1 99.0 tool --password=hunter2`, "",
    "top - 10:00:01", header, `me ${process.pid} 0.1 42.5 tool --password=hunter2`,
    "me 999999999 0.1 41.0 gone --password=hunter2", "",
  ]);
  const output = shWith({ top }, PROCESS_SCRIPTS.Linux);
  assert.doesNotMatch(output, /hunter2|password/);
  assert.deepEqual(parseProcesses("Linux", output), [{ cpu: 42.5, name: comm }]);
});

test("a failing top or one without the columns names nothing", { skip: realOs !== "Linux" }, async () => {
  const { PROCESS_SCRIPTS, parseProcesses } = await core("sample.mjs");
  assert.throws(() => shWith({ top: "exit 1" }, PROCESS_SCRIPTS.Linux));
  const header = "  PID USER COMMAND";
  const row = `${process.pid} me 90.0`;
  const top = printing([header, row, header, row]);
  assert.deepEqual(parseProcesses("Linux", shWith({ top }, PROCESS_SCRIPTS.Linux)), []);
});

test("df is asked for local disks only when it can be", { skip: !realOs }, async () => {
  const { SAMPLE_SCRIPT, parseSample } = await core("sample.mjs");
  const mount = printing([realOs === "Linux"
    ? "/dev/fake on / type ext4 (rw)"
    : "/dev/fake on / (hfs, local)"]);
  const table = (pct) => printing([
    "Filesystem 1024-blocks Used Available Capacity Mounted on", `/dev/fake 1000 500 500 ${pct}% /`,
  ]);
  const local = `case " $* " in *" -l "*) ${table(50)}\n;; *) ${table(99)}\n;; esac`;
  const noLocal = `case " $* " in *" -l "*) echo "df: unrecognized option: l" >&2; exit 1 ;; esac\n${table(60)}`;
  for (const [df, pct] of [[local, 50], [noLocal, 60]]) {
    assert.deepEqual(parseSample(shWith({ df, mount }, SAMPLE_SCRIPT)).disks, [{ mount: "/", pct, freeKb: 500 }]);
  }
});

// ---- rules -----------------------------------------------------------------

const reading = (over = {}) => ({ os: "Linux", cpu: 10, memAvailPct: 50, pressure: null, disks: [], ...over });
const mac = (pressure, over = {}) => reading({ os: "Darwin", memAvailPct: null, pressure, ...over });
const disk = (pct, mount = "/") => reading({ disks: [{ mount, pct, freeKb: 1000 }] });

// Observes `sample` every 15 s from `from` to `to`, returning [time, type, rule] per notification.
function feed(alerts, sample, from, to, machine = "box") {
  const seen = [];
  for (let at = from; at <= to; at += 15_000) {
    for (const event of alerts.observe(machine, sample, at)) seen.push([at, event.type, event.rule]);
  }
  return seen;
}

// Alerts whose notifications are all sent at once, as the daemon normally does.
async function newAlerts(props, saved, now = 0) {
  const { createAlerts, readConfig } = await core("engine.mjs");
  const alerts = createAlerts(saved, readConfig(props), now);
  const observe = (machine, sample, at) => {
    const events = alerts.observe(machine, sample, at);
    for (const event of events) alerts.sent(machine, event, at);
    return events;
  };
  return { ...alerts, observe };
}

test("readConfig falls back on invalid values and caps cpuClearPct", async () => {
  const { readConfig, gapMs } = await core("engine.mjs");
  const defaults = {
    intervalSec: 15, cpuPct: 90, cpuClearPct: 75, memAvailPct: 10, diskPct: 90, holdSec: 120, repeatMin: 15,
    desktop: true,
  };
  assert.deepEqual(readConfig(undefined), defaults);
  assert.deepEqual(readConfig({
    intervalSec: 4, cpuPct: "50", cpuClearPct: NaN, memAvailPct: 0, diskPct: 101, holdSec: -1,
    repeatMin: 0, desktop: "no",
  }), defaults);
  assert.equal(readConfig({ intervalSec: 5, desktop: false }).intervalSec, 5);
  assert.equal(readConfig({ desktop: false }).desktop, false);
  assert.equal(readConfig({ cpuPct: 60 }).cpuClearPct, 60);
  assert.equal(readConfig({ cpuClearPct: 95 }).cpuClearPct, 90);
  assert.equal(gapMs(readConfig({})), 60_000);
  assert.equal(gapMs(readConfig({ intervalSec: 60 })), 180_000);
});

test("CPU raises only after holding for holdSec", async () => {
  const alerts = await newAlerts();
  assert.deepEqual(feed(alerts, reading({ cpu: 90 }), 0, 3 * MIN), [[2 * MIN, "raise", "cpu"]]);
});

test("a raise needs two observations even with no hold", async () => {
  const alerts = await newAlerts({ holdSec: 0 });
  assert.deepEqual(alerts.observe("box", reading({ cpu: 99 }), 0), []);
  assert.deepEqual(alerts.observe("box", reading({ cpu: 99 }), 1000), [{ type: "raise", rule: "cpu", resource: "" }]);
});

test("a value below the raise threshold resets a pending raise", async () => {
  for (const between of [80, 10]) {
    const alerts = await newAlerts();
    feed(alerts, reading({ cpu: 95 }), 0, 105_000);
    alerts.observe("box", reading({ cpu: between }), 120_000);
    assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 135_000, 255_000), [[255_000, "raise", "cpu"]]);
  }
});

test("CPU clears below cpuClearPct held for 60 s", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  assert.deepEqual(feed(alerts, reading({ cpu: 75 }), 135_000, 5 * MIN), []);
  assert.deepEqual(feed(alerts, reading({ cpu: 74 }), 315_000, 360_000), []);
  alerts.observe("box", reading({ cpu: 80 }), 375_000);
  assert.deepEqual(feed(alerts, reading({ cpu: 74 }), 390_000, 450_000), [[450_000, "recover", "cpu"]]);
});

test("an active alert repeats every repeatMin, only while the reading is over the threshold", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 135_000, 33 * MIN), [
    [17 * MIN, "raise", "cpu"],
    [32 * MIN, "raise", "cpu"],
  ]);
  assert.deepEqual(feed(alerts, reading({ cpu: 80 }), 33 * MIN + 15_000, 65 * MIN), []);
  const off = await newAlerts();
  assert.deepEqual(feed(off, null, 0, 60 * MIN), [[2 * MIN, "raise", "unreachable"]]);
  const quiet = await newAlerts({ repeatMin: 1 });
  feed(quiet, reading({ cpu: 95 }), 0, 2 * MIN);
  assert.deepEqual(feed(quiet, reading({ cpu: 10 }), 135_000, 195_000), [[195_000, "recover", "cpu"]]);
});

test("a re-raise inside the repeat window waits for the window to end", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  feed(alerts, reading({ cpu: 10 }), 135_000, 195_000);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 210_000, 6 * MIN), []);
  assert.equal(alerts.snapshot().alerts[0].active, true);
  // It was never announced, so it also clears silently.
  assert.deepEqual(feed(alerts, reading({ cpu: 10 }), 375_000, 450_000), []);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 465_000, 17 * MIN), [[17 * MIN, "raise", "cpu"]]);
});

test("a cleared alert is dropped once its window has passed", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  feed(alerts, reading({ cpu: 10 }), 135_000, 195_000);
  assert.equal(alerts.snapshot().alerts.length, 1);
  feed(alerts, reading({ cpu: 10 }), 210_000, 17 * MIN);
  assert.deepEqual(alerts.snapshot(), { alerts: [] });
});

test("Linux memory raises below memAvailPct and clears 5 points higher", async () => {
  const alerts = await newAlerts();
  assert.deepEqual(feed(alerts, reading({ memAvailPct: 10 }), 0, 5 * MIN), []);
  assert.deepEqual(feed(alerts, reading({ memAvailPct: 9.9 }), 315_000, 435_000), [[435_000, "raise", "memory"]]);
  assert.deepEqual(feed(alerts, reading({ memAvailPct: 14.9 }), 450_000, 10 * MIN), []);
  assert.deepEqual(feed(alerts, reading({ memAvailPct: 15 }), 615_000, 675_000), [[675_000, "recover", "memory"]]);
});

test("macOS memory alerts only at critical pressure, whatever the swap", async () => {
  const { parseSample } = await core("sample.mjs");
  const alerts = await newAlerts();
  assert.deepEqual(feed(alerts, parseSample(macOutput()), 0, 10 * MIN), []);
  const start = 10 * MIN + 15_000;
  assert.deepEqual(feed(alerts, mac(4), start, start + 2 * MIN), [[start + 2 * MIN, "raise", "memory"]]);
  const clear = start + 2 * MIN + 15_000;
  assert.deepEqual(feed(alerts, mac(2), clear, clear + MIN), [[clear + MIN, "recover", "memory"]]);
});

test("a disk raises after 30 s, clears below diskPct-3 and repeats daily per mount", async () => {
  const alerts = await newAlerts();
  assert.deepEqual(feed(alerts, disk(90), 0, MIN), [[30_000, "raise", "disk"]]);
  assert.deepEqual(feed(alerts, disk(87), 75_000, 5 * MIN), []);
  assert.deepEqual(alerts.observe("box", disk(87), 5 * MIN + 15_000), []);
  // Hours later, past any repeatMin, it still waits for a full day.
  for (let at = HOUR; at < 24 * HOUR; at += HOUR) assert.deepEqual(alerts.observe("box", disk(91), at), []);
  assert.deepEqual(feed(alerts, disk(91), 24 * HOUR, 24 * HOUR + 30_000),
    [[24 * HOUR + 30_000, "raise", "disk"]]);
  const next = 24 * HOUR + 45_000;
  assert.deepEqual(feed(alerts, disk(86), next, next + MIN), [[next + MIN, "recover", "disk"]]);
  // A second mount has its own window.
  assert.deepEqual(feed(alerts, disk(95, "/data"), next + 75_000, next + 105_000),
    [[next + 105_000, "raise", "disk"]]);
});

test("a gap between observations resets pending raise and clear timers", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 105_000);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 166_000, 286_000), [[286_000, "raise", "cpu"]]);
  feed(alerts, reading({ cpu: 10 }), 300_000, 330_000);
  assert.deepEqual(feed(alerts, reading({ cpu: 10 }), 391_000, 451_000), [[451_000, "recover", "cpu"]]);
});

test("a gap of exactly the limit keeps the pending timer", async () => {
  const alerts = await newAlerts();
  alerts.observe("box", reading({ cpu: 95 }), 0);
  alerts.observe("box", reading({ cpu: 95 }), MIN);
  assert.equal(alerts.observe("box", reading({ cpu: 95 }), 2 * MIN).length, 1);
});

test("an unknown metric neither raises nor clears", async () => {
  const alerts = await newAlerts();
  const unknown = reading({ cpu: null, memAvailPct: null });
  assert.deepEqual(feed(alerts, unknown, 0, 5 * MIN), []);
  feed(alerts, reading({ cpu: 95 }), 315_000, 435_000);
  assert.deepEqual(feed(alerts, unknown, 450_000, 40 * MIN), []);
  assert.equal(alerts.snapshot().alerts[0].active, true);
});

test("a metric unknown for longer than the gap loses its pending timer", async () => {
  const alerts = await newAlerts();
  alerts.observe("box", reading({ cpu: 95 }), 0);
  feed(alerts, reading({ cpu: null }), 15_000, 3 * MIN);
  assert.deepEqual(alerts.observe("box", reading({ cpu: 95 }), 195_000), []);
});

test("unreachable raises after holdSec and clears on two successes in a row", async () => {
  const alerts = await newAlerts();
  feed(alerts, null, 0, 105_000);
  alerts.observe("box", reading(), 120_000);
  assert.deepEqual(feed(alerts, null, 135_000, 255_000), [[255_000, "raise", "unreachable"]]);
  assert.deepEqual(alerts.observe("box", reading(), 270_000), []);
  assert.deepEqual(alerts.observe("box", null, 285_000), []);
  assert.deepEqual(alerts.observe("box", reading(), 300_000), []);
  assert.deepEqual(alerts.observe("box", reading(), 315_000),
    [{ type: "recover", rule: "unreachable", resource: "" }]);
});

test("other alerts stay as they are while a machine is unreachable", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  const events = feed(alerts, null, 135_000, 30 * MIN);
  assert.ok(events.every(([, , rule]) => rule === "unreachable"));
  assert.equal(alerts.snapshot().alerts.find((a) => a.rule === "cpu").active, true);
});

test("a restart does not re-notify, and keeps repeating and recovering", async () => {
  const before = await newAlerts();
  feed(before, reading({ cpu: 95 }), 0, 2 * MIN);
  const saved = JSON.parse(JSON.stringify(before.snapshot()));

  const after = await newAlerts({}, saved);
  assert.deepEqual(feed(after, reading({ cpu: 95 }), 3 * MIN, 17 * MIN), [[17 * MIN, "raise", "cpu"]]);

  const recovering = await newAlerts({}, saved);
  assert.deepEqual(feed(recovering, reading({ cpu: 10 }), 3 * MIN, 4 * MIN), [[4 * MIN, "recover", "cpu"]]);
  // Still inside the window after that recovery: a restart must not lose it.
  const again = await newAlerts({}, recovering.snapshot());
  assert.deepEqual(feed(again, reading({ cpu: 95 }), 5 * MIN, 10 * MIN), []);
});

test("a repeat needs the reading sustained again, not one spike after the window", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  assert.deepEqual(feed(alerts, reading({ cpu: 80 }), 135_000, 30 * MIN), []);
  assert.deepEqual(alerts.observe("box", reading({ cpu: 99 }), 30 * MIN + 15_000), []);
  assert.deepEqual(feed(alerts, reading({ cpu: 80 }), 31 * MIN, 32 * MIN), []);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 33 * MIN, 35 * MIN), [[35 * MIN, "raise", "cpu"]]);
  // Waking from sleep: the first samples say nothing about how long it has been so.
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 5 * HOUR, 5 * HOUR + 105_000), []);
  assert.equal(alerts.observe("box", reading({ cpu: 95 }), 5 * HOUR + 2 * MIN).length, 1);
});

test("a held-back re-raise is sent only once the reading is sustained", async () => {
  const alerts = await newAlerts();
  feed(alerts, reading({ cpu: 95 }), 0, 2 * MIN);
  feed(alerts, reading({ cpu: 10 }), 135_000, 195_000);
  feed(alerts, reading({ cpu: 95 }), 210_000, 6 * MIN); // raised again, silently
  feed(alerts, reading({ cpu: 80 }), 375_000, 18 * MIN);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 18 * MIN + 15_000, 20 * MIN), []);
  assert.deepEqual(feed(alerts, reading({ cpu: 95 }), 20 * MIN + 15_000, 21 * MIN),
    [[20 * MIN + 15_000, "raise", "cpu"]]);
});

test("a raise stays due, and unsaved, until it is sent", async () => {
  const { createAlerts, readConfig } = await core("engine.mjs");
  const alerts = createAlerts(undefined, readConfig({ holdSec: 0 }), 0);
  alerts.observe("box", reading({ cpu: 95 }), 0);
  const [event] = alerts.observe("box", reading({ cpu: 95 }), 15_000);
  assert.deepEqual(alerts.snapshot(), { alerts: [] });
  assert.equal(alerts.observe("box", reading({ cpu: 95 }), 30_000).length, 1);
  alerts.sent("box", event, 30_000);
  assert.deepEqual(alerts.snapshot().alerts.map((a) => [a.notified, a.notifiedAt]), [[true, 30_000]]);
  assert.deepEqual(alerts.observe("box", reading({ cpu: 95 }), 45_000), []);
});

test("saved state older than its repeat window is dropped, so a new outage is announced", async () => {
  const before = await newAlerts();
  feed(before, null, 0, 2 * MIN);
  const saved = before.snapshot();
  assert.equal(saved.alerts.length, 1);

  const soon = await newAlerts({}, saved, 10 * MIN);
  assert.deepEqual(feed(soon, null, 10 * MIN, 40 * MIN), []);

  const later = await newAlerts({}, saved, 3 * HOUR);
  assert.deepEqual(later.snapshot(), { alerts: [] });
  assert.deepEqual(feed(later, null, 3 * HOUR, 3 * HOUR + 3 * MIN),
    [[3 * HOUR + 2 * MIN, "raise", "unreachable"]]);
});

test("a saved disk alert lasts a day, whatever repeatMin says", async () => {
  const before = await newAlerts({ repeatMin: 1 });
  feed(before, disk(95), 0, 30_000);
  const saved = before.snapshot();
  assert.equal((await newAlerts({ repeatMin: 1 }, saved, 23 * HOUR)).snapshot().alerts.length, 1);
  assert.equal((await newAlerts({ repeatMin: 1 }, saved, 24 * HOUR + 30_000)).snapshot().alerts.length, 0);
});

test("unusable saved state is ignored", async () => {
  for (const saved of [undefined, null, 7, "x", {}, { alerts: 3 }, { alerts: [null, 1, { machine: 1 }, {}] }]) {
    assert.deepEqual((await newAlerts({}, saved)).snapshot(), { alerts: [] });
  }
});

// ---- daemon ----------------------------------------------------------------

// `hosts` maps a machine (null = this computer) to what sampling it does:
// a stdout string, an exec result, an Error to reject with, or a function.
async function rig({
  props, hosts = new Map(), machines = [], store = new Map(), desktop, processes, platform, clock = 0,
} = {}) {
  const { createDaemon } = await core("daemon.mjs");
  const { readConfig } = await core("engine.mjs");
  const { SAMPLE_SCRIPT } = await core("sample.mjs");
  const r = { clock, calls: [], notes: [], writes: [], logs: [], machines, hosts, store };
  if (!hosts.has(null)) hosts.set(null, linuxOutput());
  const exec = async (program, args, options) => {
    r.calls.push({ program, args, options });
    if (program !== "sh") return desktop ? desktop(program) : { code: 0, stdout: "", stderr: "" };
    let answer = args[1] === SAMPLE_SCRIPT ? r.hosts.get(options.on) : processes?.(options.on);
    if (typeof answer === "function") answer = await answer();
    if (answer instanceof Error || answer === undefined) throw answer ?? new Error("unreachable");
    return typeof answer === "string" ? { code: 0, stdout: answer, stderr: "" } : answer;
  };
  r.daemon = createDaemon({
    exec,
    machines: () => r.machines,
    notify: (n) => r.notes.push(n),
    shared: (key) => r.store.get(key),
    setShared: (key, value) => {
      r.writes.push(value);
      r.store.set(key, value);
    },
    now: () => r.clock,
    log: (m) => r.logs.push(m),
    config: readConfig(props),
    platform,
  });
  r.run = async (ticks, step = 15_000) => {
    for (let i = 0; i < ticks; i++) {
      await r.daemon.tick();
      r.clock += step;
    }
    await new Promise(setImmediate);
  };
  r.samples = (on) => r.calls.filter((c) => c.args[1] === SAMPLE_SCRIPT && c.options.on === on);
  r.desktops = () => r.calls.filter((c) => c.program !== "sh");
  return r;
}

const remote = (name, layout = "ready") => ({ name, layout });
const fullDisk = (pct = 95) => linuxOutput({ df: [`/dev/nvme0n1p2 1000000 950000 50000 ${pct}% /`] });

test("samples this computer once, listed or not, and routes machines through `on`", async () => {
  const hostile = "box; rm -rf /";
  for (const listed of [[], [remote(null, "loading")]]) {
    const r = await rig({
      machines: [...listed, remote(hostile), remote(hostile)],
      hosts: new Map([[hostile, linuxOutput()]]),
    });
    await r.run(1);
    assert.equal(r.samples(null).length, 1);
    assert.equal(r.samples(hostile).length, 1);
    assert.equal(r.calls.length, 2);
    for (const call of r.calls) {
      assert.equal(call.options.timeout, 10_000);
      assert.ok(!call.args.join(" ").includes(hostile));
    }
  }
});

test("keeps at most one sample in flight per machine", async () => {
  let release;
  const slow = () => new Promise((resolve) => (release = resolve));
  const r = await rig({ machines: [remote("slow"), remote("fast")] });
  r.hosts.set("slow", slow);
  r.hosts.set("fast", linuxOutput());
  const first = r.daemon.tick();
  await new Promise(setImmediate);
  await r.daemon.tick();
  assert.equal(r.samples("slow").length, 1);
  assert.equal(r.samples("fast").length, 2);
  release(linuxOutput());
  await first;
  r.hosts.set("slow", linuxOutput());
  await r.daemon.tick();
  assert.equal(r.samples("slow").length, 2);
});

test("an unavailable machine counts as not answering without exec; a loading one is skipped", async () => {
  const r = await rig({ machines: [remote("down", "unavailable"), remote("booting", "loading")] });
  await r.run(9);
  assert.equal(r.samples("down").length, 0);
  assert.equal(r.samples("booting").length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].title, "down: not answering");
  assert.equal(r.notes[0].level, "error");
});

test("a rejected exec and incomplete output are failed observations", async () => {
  const r = await rig({ machines: [remote("gone"), remote("cut")] });
  r.hosts.set("gone", new Error("no route"));
  r.hosts.set("cut", { code: 1, stdout: "@os\nLinux\n", stderr: "" });
  await r.run(9);
  assert.deepEqual(r.notes.map((n) => n.title).sort(), ["cut: not answering", "gone: not answering"]);
});

test("an unsupported system never alerts, even once unavailable", async () => {
  const r = await rig({ machines: [remote("bsd")] });
  r.hosts.set("bsd", { code: 4, stdout: "@os\nFreeBSD\n", stderr: "" });
  await r.run(12);
  r.machines = [remote("bsd", "unavailable")];
  await r.run(12);
  r.machines = [remote("bsd")];
  r.hosts.set("bsd", new Error("timeout"));
  await r.run(12);
  assert.deepEqual(r.notes, []);
});

test("a removed machine is forgotten, and its late sample is dropped", async () => {
  const r = await rig({ machines: [remote("box")] });
  r.hosts.set("box", fullDisk());
  await r.run(3);
  assert.equal(r.notes.length, 1);
  let release;
  r.hosts.set("box", () => new Promise((resolve) => (release = resolve)));
  const pending = r.daemon.tick();
  await new Promise(setImmediate);
  r.machines = [];
  await r.daemon.tick();
  assert.deepEqual(r.store.get("fleet-resources.state"), { alerts: [] });
  release(fullDisk());
  await pending;
  assert.deepEqual(r.store.get("fleet-resources.state"), { alerts: [] });
  r.machines = [remote("box")];
  r.hosts.set("box", fullDisk());
  await r.run(3);
  assert.equal(r.notes.length, 2);
});

// Counters after `n` samples of a machine that is `busy` percent busy.
const statAt = (n, busy) => `cpu  ${n * busy * 10} 0 0 ${n * (100 - busy) * 10} 0 0 0 0 0 0`;
const busyHost = (busy = 95) => {
  let n = 0;
  return () => linuxOutput({ stat: statAt(++n, busy) });
};

test("a CPU spike on another machine notifies with its busiest processes", async () => {
  const r = await rig({ machines: [remote("builder")], processes: () => LINUX_PROCESSES });
  r.hosts.set("builder", busyHost());
  await r.run(9);
  assert.deepEqual(r.notes, []);
  await r.run(1);
  assert.deepEqual(r.notes, [{
    title: "builder: CPU 95%",
    body: "Load 4.5 on 16 cores. Top CPU: Web Content 188%, node 95%, cc1plus 12%",
    level: "warning",
  }]);
  const processCalls = r.calls.filter((c) => c.args[1]?.includes("top -b"));
  assert.equal(processCalls.length, 1);
  assert.deepEqual(processCalls[0].options, { on: "builder", timeout: 10_000 });
});

test("CPU recovery is an in-app notice only", async () => {
  const r = await rig({ processes: () => LINUX_PROCESSES });
  let n = 0;
  let idle = 0;
  let load = 95;
  r.hosts.set(null, () => {
    n += load;
    idle += 100 - load;
    return linuxOutput({ stat: `cpu  ${n} 0 0 ${idle} 0 0 0 0 0 0` });
  });
  await r.run(10);
  load = 10;
  await r.run(5);
  assert.deepEqual(r.notes.map((x) => [x.title, x.level]), [
    ["This computer: CPU 95%", "warning"],
    ["This computer: CPU recovered, 10%", "success"],
  ]);
  assert.equal(r.desktops().length, 1);
});

test("a failure or a gap drops the previous CPU counters", async () => {
  for (const interrupt of ["failure", "gap"]) {
    const r = await rig({ props: { holdSec: 0 } });
    const host = busyHost();
    r.hosts.set(null, host);
    await r.run(2); // one measured reading: the raise is pending
    if (interrupt === "failure") {
      r.hosts.set(null, new Error("blip"));
      await r.run(1);
      r.hosts.set(null, host);
    } else r.clock += 5 * MIN;
    await r.run(2); // unmeasured, then the first reading after the interruption
    assert.equal(r.notes.length, interrupt === "failure" ? 1 : 0, interrupt);
    await r.run(1);
    assert.equal(r.notes.length, 1, interrupt);
  }
});

test("a memory alert carries swap, and survives a failed process listing", async () => {
  for (const processes of [undefined, () => ({ code: 1, stdout: LINUX_PROCESSES, stderr: "" })]) {
    const r = await rig({ processes });
    r.hosts.set(null, linuxOutput({ available: 1600000 }));
    await r.run(9);
    assert.deepEqual(r.notes, [{
      title: "This computer: memory 5% available",
      body: "Swap 1.0 of 4.0 GB used",
      level: "warning",
    }]);
  }
});

test("a macOS machine at warn pressure with full swap stays quiet; critical alerts", async () => {
  const r = await rig({ machines: [remote("mac")], processes: () => " 50.0 WindowServer\n" });
  r.hosts.set("mac", macOutput());
  await r.run(40);
  assert.deepEqual(r.notes, []);
  r.hosts.set("mac", macOutput({ pressure: 4 }));
  await r.run(9);
  assert.deepEqual(r.notes, [{
    title: "mac: memory pressure critical",
    body: "Swap 7.0 of 8.0 GB used. Top CPU: WindowServer 50%",
    level: "warning",
  }]);
  assert.ok(r.calls.some((c) => c.args[1]?.includes("ps -Aceo pcpu=,comm= -r") && c.options.on === "mac"));
});

test("desktop notifications go to the viewer's own system", async () => {
  const title = "builder: disk 95% full";
  const body = "0.0 GB free on /";
  const cases = [
    [linuxOutput(), "notify-send", ["-a", "Herdr", "--", title, body]],
    [macOutput(), "osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run", title, body,
    ]],
  ];
  for (const [local, program, args] of cases) {
    const r = await rig({ machines: [remote("builder")] });
    r.hosts.set(null, local);
    r.hosts.set("builder", fullDisk());
    await r.run(3);
    assert.deepEqual(r.desktops(), [{ program, args, options: { timeout: 10_000 } }]);
    assert.deepEqual(r.notes, [{ title, body, level: "warning" }]);
  }
});

test("only the notify-send body is escaped as markup", async () => {
  const mount = "/mnt/<a & b>";
  const host = linuxOutput({
    df: [`/dev/sda1 1000000 950000 50000 95% ${mount}`],
    mount: [`/dev/sda1 on ${mount} type ext4 (rw)`],
  });
  for (const [local, expected] of [
    [linuxOutput(), "0.0 GB free on /mnt/&lt;a &amp; b&gt;"],
    [macOutput(), `0.0 GB free on ${mount}`],
  ]) {
    const r = await rig({ machines: [remote("box")] });
    r.hosts.set(null, local);
    r.hosts.set("box", host);
    await r.run(3);
    assert.equal(r.notes[0].body, `0.0 GB free on ${mount}`);
    assert.equal(r.desktops()[0].args.at(-1), expected);
  }
});

test("the window's platform picks the desktop notifier until this computer is sampled", async () => {
  for (const [platform, local, program] of [
    ["linux", new Error("no sh"), "notify-send"],
    ["macos", new Error("no sh"), "osascript"],
    ["linux", macOutput(), "osascript"],
    [undefined, new Error("no sh"), undefined],
  ]) {
    const r = await rig({ platform, machines: [remote("box")] });
    r.hosts.set(null, local);
    r.hosts.set("box", fullDisk());
    await r.run(3);
    assert.equal(r.desktops()[0]?.program, program, `${platform}`);
  }
});

test("desktop: false sends only in-app notifications", async () => {
  const r = await rig({ props: { desktop: false } });
  r.hosts.set(null, fullDisk());
  await r.run(3);
  assert.equal(r.notes.length, 1);
  assert.deepEqual(r.desktops(), []);
});

test("a failing desktop notification is logged and sampling goes on", async () => {
  const failures = [
    () => { throw new Error("no notify-send"); },
    () => ({ code: 1, stdout: "", stderr: "no daemon" }),
  ];
  for (const desktop of failures) {
    const r = await rig({ desktop });
    r.hosts.set(null, fullDisk());
    await r.run(6);
    assert.equal(r.notes.length, 1);
    assert.equal(r.samples(null).length, 6);
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /desktop notification failed/);
  }
});

test("text from a machine is stripped of control characters and capped", async () => {
  const name = `evil\u001b[31m\u202e\u061c\u200e\u200f${"x".repeat(200)}`;
  const r = await rig({
    machines: [remote(name)],
    processes: () => ` 90.0 ${"p".repeat(500)}\u0007\n`,
  });
  r.hosts.set(name, macOutput({ pressure: 4 }));
  await r.run(9);
  const [note] = r.notes;
  assert.doesNotMatch(note.title + note.body, /[\u0000-\u001f\u061c\u200e\u200f\u202e]/);
  assert.ok(note.title.length <= 120);
  assert.ok(note.body.length <= 300);
  assert.ok(!note.body.includes("p".repeat(41)));
});

test("shared state is written only when alert state changes", async () => {
  const r = await rig();
  await r.run(10);
  assert.equal(r.writes.length, 0);
  r.hosts.set(null, fullDisk());
  await r.run(10);
  assert.equal(r.writes.length, 1);
});

test("a new daemon reads the saved state and does not notify again", async () => {
  const store = new Map();
  const hosts = new Map([[null, fullDisk()]]);
  const first = await rig({ store, hosts });
  await first.run(3);
  assert.equal(first.notes.length, 1);
  first.daemon.close();
  const second = await rig({ store, hosts, clock: first.clock });
  await second.run(10);
  assert.deepEqual(second.notes, []);
  assert.equal(second.writes.length, 0);
});

test("an alert cut off before it was sent is not saved as sent, even if others write", async () => {
  const store = new Map();
  const r = await rig({
    store,
    machines: [remote("hot"), remote("full")],
    processes: () => new Promise(() => {}), // the listing for `hot` is still running
  });
  r.hosts.set("hot", macOutput({ pressure: 4 }));
  r.hosts.set("full", linuxOutput());
  await r.run(8);
  r.daemon.tick(); // `hot` raises and waits for its listing
  await new Promise(setImmediate);
  r.clock += 15_000;
  r.hosts.set("full", fullDisk());
  for (let i = 0; i < 3; i++) { // `full` raises, and writes the state
    await Promise.race([r.daemon.tick(), new Promise(setImmediate)]);
    r.clock += 15_000;
  }
  r.daemon.close();
  assert.deepEqual(r.notes.map((n) => n.title), ["full: disk 95% full"]);
  assert.deepEqual(store.get("fleet-resources.state").alerts.map((a) => a.machine), ["full"]);

  const next = await rig({
    store, clock: r.clock, machines: r.machines, hosts: r.hosts, processes: () => " 50.0 WindowServer\n",
  });
  await next.run(9);
  assert.deepEqual(next.notes.map((n) => n.title), ["hot: memory pressure critical"]);
});

test("a closed daemon sends and writes nothing", async () => {
  let release;
  const r = await rig({ processes: () => new Promise((resolve) => (release = resolve)) });
  r.hosts.set(null, macOutput({ pressure: 4 }));
  await r.run(8);
  const pending = r.daemon.tick();
  await new Promise(setImmediate);
  r.daemon.close();
  release(" 1.0 launchd\n");
  await pending;
  await r.daemon.tick();
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.writes, []);
  assert.equal(r.samples(null).length, 9);
});

// ---- layouts ---------------------------------------------------------------

test("both glass layouts run the daemon and offer the Vitals panel", () => {
  const find = (node, id) => (node.id === id ? node
    : (node.children ?? []).reduce((found, child) => found ?? find(child, id), null));
  for (const name of ["glass", "glass-insights"]) {
    const layout = JSON.parse(fs.readFileSync(path.join(root, "layouts", `${name}.json`), "utf8"));
    const daemon = find(layout, "work").children.find((c) => c.id === "fleet-resources-daemon");
    assert.deepEqual(daemon, {
      id: "fleet-resources-daemon", type: "block", content: { mod: "fleet-resources" }, size: { px: 0 },
    }, name);
    const button = find(layout, "tabs").content.props.buttons.find((b) => b.id === "vitals");
    assert.equal(button.icon, "mods/vitals/vitals.svg", name);
    assert.ok(fs.existsSync(path.join(root, button.icon)));
    assert.deepEqual(button.action, { type: "panel", container: "panel", stack: "panel-body", target: "vitals" });
    const stack = find(layout, "panel-body");
    assert.deepEqual(stack.children.find((c) => c.id === "vitals"),
      { id: "vitals", type: "block", content: { mod: "vitals" } }, name);
    assert.equal(stack.active, "pull-requests", name);
  }
});
