// The fixed read-only scripts run on each machine, and parsers for their output.

export const UNSUPPORTED_EXIT = 4;

// Takes no input. The closing @end marks a complete sample.
export const SAMPLE_SCRIPT = `export LC_ALL=C
os=$(uname -s) || exit 3
echo @os; echo "$os"
case $os in
Linux)
  echo @stat; head -n 1 /proc/stat
  echo @cores; getconf _NPROCESSORS_ONLN
  echo @load; cat /proc/loadavg
  echo @mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  ;;
Darwin)
  echo @cpu; iostat -n 0 -c 2 -w 1
  echo @cores; sysctl -n hw.ncpu
  echo @load; sysctl -n vm.loadavg
  echo @mem; sysctl -n kern.memorystatus_vm_pressure_level; sysctl -n vm.swapusage
  echo @vm; vm_stat
  echo @memsize; sysctl -n hw.memsize
  ;;
*) exit ${UNSUPPORTED_EXIT} ;;
esac
echo @df
# BusyBox df has no -l; network filesystems are also dropped by type.
if df -P -k -l / >/dev/null 2>&1; then df -P -k -l; else df -P -k; fi
echo @mount; mount
echo @end
`;

// Process names only, never arguments. What top shows under COMMAND depends on
// its configuration and implementation, so only PID and %CPU are taken from its
// second frame (the first has no interval to measure) and the busiest names are
// read from /proc. top has finished before anything else runs, so the filters
// are not among the processes it measured.
const LINUX_PROCESSES = `export LC_ALL=C
frames=$(top -b -n 2 -d 1 -w 512) || exit 1
busiest=$(printf '%s\\n' "$frames" | awk '
  { p = c = 0; for (i = 1; i <= NF; i++) { if ($i == "PID") p = i; if ($i == "%CPU") c = i } }
  p && c && $1 !~ /^[0-9]+$/ { frame++; pid = p; cpu = c; next }
  frame == 2 && $pid ~ /^[0-9]+$/ && $cpu ~ /^[0-9]+([.][0-9]+)?$/ { print $pid, $cpu }
' | sort -k2,2nr | head -n 20)
printf '%s\\n' "$busiest"
echo @comm
printf '%s\\n' "$busiest" | while read -r pid rest; do grep -H . "/proc/$pid/comm" 2>/dev/null; done
exit 0
`;

export const PROCESS_SCRIPTS = {
  Linux: LINUX_PROCESSES,
  Darwin: "LC_ALL=C ps -Aceo pcpu=,comm= -r",
};

const MARKER = /^@(os|stat|cpu|cores|load|mem|vm|memsize|df|mount|end)$/;

function sections(stdout) {
  const out = {};
  let current = null;
  for (const line of String(stdout).split("\n")) {
    const marker = line.match(MARKER);
    if (marker) out[(current = marker[1])] = [];
    else if (current && line) out[current].push(line);
  }
  return out;
}

const clampPct = (value) => Math.max(0, Math.min(100, value));

// Source and mount point may both contain spaces.
const DF_ROW = /^(.+?)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+(.+)$/;
const MOUNT_ROW = {
  Linux: /^.+? on (.+) type (\S+) \((.*)\)$/, // mount point, type, options
  Darwin: /^.+? on (.+) \(([^()]*)\)$/, // mount point, options led by the type
};
const SKIPPED_TYPES = new Set([
  "tmpfs", "devtmpfs", "efivarfs", "squashfs", "ramfs", "devfs", "autofs", "nullfs", "iso9660", "udf",
  "nfs", "nfs4", "cifs", "smb3", "smbfs", "afpfs", "webdav", "fuse.sshfs",
]);
export const MAC_DATA = "/System/Volumes/Data";

/** The writable local disks worth watching, one per underlying filesystem. */
export function parseDisks(dfLines, mountLines, os) {
  const mounts = new Map();
  for (const line of mountLines) {
    const found = line.match(MOUNT_ROW[os]);
    if (!found) continue;
    const options = found.at(-1).split(",").map((option) => option.trim());
    mounts.set(found[1], {
      type: os === "Linux" ? found[2] : options[0],
      readOnly: options.includes(os === "Linux" ? "ro" : "read-only"),
    });
  }

  let rows = [];
  for (const line of dfLines) {
    const found = line.match(DF_ROW);
    if (!found) continue;
    const [, source, size, used, free, capacity, mount] = found;
    const info = mounts.get(mount);
    if (!info || info.readOnly || Number(size) === 0) continue;
    if (SKIPPED_TYPES.has(info.type) && !(info.type === "tmpfs" && mount === "/tmp")) continue;
    // A container's overlay repeats the disk under it, unless it is all there is.
    if (info.type === "overlay" && mount !== "/") continue;
    const freeKb = Math.max(0, Number(free));
    // APFS volumes share a container, and df's capacity leaves the other volumes out.
    const pct = info.type === "apfs"
      ? clampPct(Math.ceil(((size - freeKb) / size) * 100))
      : Number(capacity);
    // A device is one filesystem, even when its volumes report slightly different
    // figures. Names such as "none" are shared by unrelated ones, told apart by figures.
    const key = source.startsWith("/dev/") ? source : JSON.stringify([source, size, used, free]);
    rows.push({ key, mount, pct, freeKb });
  }
  if (os === "Darwin") {
    // The APFS system volumes share one container with the data volume.
    const hasData = rows.some((row) => row.mount === MAC_DATA);
    rows = rows.filter(({ mount }) =>
      !(mount.startsWith("/System/Volumes/") && mount !== MAC_DATA) && !(hasData && mount === "/"));
  }

  const unique = new Map();
  for (const row of rows) {
    const kept = unique.get(row.key);
    if (!kept || row.mount.length < kept.mount.length) unique.set(row.key, row);
  }
  return [...unique.values()].map(({ mount, pct, freeKb }) => ({ mount, pct, freeKb }));
}

function parseLinux(part, sample) {
  const stat = part.stat?.[0]?.trim().split(/\s+/) ?? [];
  const ticks = stat.slice(1, 9).map(Number);
  if (stat[0] === "cpu" && ticks.length >= 4 && ticks.every(Number.isFinite)) {
    // iowait counts as idle; guest time is already inside user and nice.
    sample.counters = { total: ticks.reduce((a, b) => a + b, 0), idle: ticks[3] + (ticks[4] ?? 0) };
  }
  const mem = (part.mem ?? []).join("\n");
  const bytes = (key) => {
    const found = mem.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return found ? Number(found[1]) * 1024 : null;
  };
  const [total, available, swapTotal, swapFree] = ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"].map(bytes);
  if (total > 0 && available !== null) {
    sample.memAvailPct = (available / total) * 100;
    sample.memPct = clampPct(100 - sample.memAvailPct);
  }
  if (swapTotal !== null && swapFree !== null) sample.swap = { used: swapTotal - swapFree, total: swapTotal };
}

// Activity Monitor's "Memory Used" (app memory, wired and compressed) as a share
// of physical memory. Formula from mods/vitals/stats.js (Apache-2.0), adapted
// there from ozcberkay/herdr-coban.
function macMemPct(vmLines, memsize) {
  const vm = vmLines.join("\n");
  const number = (pattern) => {
    const found = vm.match(pattern);
    return found ? Number(found[1]) : null;
  };
  const pageSize = number(/page size of (\d+)/);
  const [anonymous, purgeable, wired, compressed] = [
    "Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor",
  ].map((label) => number(new RegExp(`^${label}:\\s+(\\d+)`, "m")));
  const total = Number(memsize);
  if ([pageSize, anonymous, purgeable, wired, compressed].includes(null) || !(total > 0)) return null;
  return clampPct((((anonymous - purgeable + wired + compressed) * pageSize) / total) * 100);
}

const UNITS = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 };

function parseDarwin(part, sample) {
  // The first iostat row averages since boot; the second covers the last second.
  const row = (part.cpu ?? []).map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && f.slice(0, 3).every((v) => /^\d+$/.test(v)))[1];
  if (row) sample.cpu = clampPct(100 - Number(row[2]));
  const level = part.mem?.[0]?.trim();
  if (/^\d+$/.test(level ?? "")) sample.pressure = Number(level);
  const swap = (part.mem ?? []).join("\n").match(/total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/);
  if (swap) sample.swap = { used: Number(swap[3]) * UNITS[swap[4]], total: Number(swap[1]) * UNITS[swap[2]] };
  sample.memPct = macMemPct(part.vm ?? [], part.memsize?.[0]);
}

/**
 * One machine's sample, or null when the output is incomplete. A metric that
 * could not be read is null. Linux CPU use needs two samples: see `cpuBusy`.
 */
export function parseSample(stdout) {
  const part = sections(stdout);
  const os = part.os?.[0]?.trim();
  if (!part.end || (os !== "Linux" && os !== "Darwin")) return null;
  const load = (part.load?.[0] ?? "").match(/\d+(\.\d+)?/);
  const sample = {
    os,
    cpu: null,
    counters: null,
    cores: Number(part.cores?.[0]) || null,
    load: load ? Number(load[0]) : null,
    memAvailPct: null,
    memPct: null,
    pressure: null,
    swap: null,
    disks: parseDisks(part.df ?? [], part.mount ?? [], os),
  };
  (os === "Linux" ? parseLinux : parseDarwin)(part, sample);
  return sample;
}

/** Busy share between two `/proc/stat` readings, or null without both. */
export function cpuBusy(previous, current) {
  if (!previous || !current || current.total <= previous.total) return null;
  return clampPct((1 - (current.idle - previous.idle) / (current.total - previous.total)) * 100);
}

// "PID %CPU" rows, then `@comm` and a "/proc/PID/comm:NAME" line per process
// still alive.
function linuxRows(stdout) {
  const [table, comms = ""] = String(stdout).split("\n@comm\n");
  const names = new Map();
  for (const line of comms.split("\n")) {
    const found = line.match(/^\/proc\/(\d+)\/comm:(.+)$/);
    if (found && !names.has(found[1])) names.set(found[1], found[2]);
  }
  return table.split("\n")
    .map((line) => line.match(/^(\d+) ([\d.]+)$/))
    .filter((found) => found && names.has(found[1]))
    .map((found) => ({ cpu: Number(found[2]), name: names.get(found[1]) }));
}

function psRows(stdout) {
  return String(stdout).split("\n")
    .map((line) => line.match(/^\s*([\d.]+)\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((found) => ({ cpu: Number(found[1]), name: found[2] }));
}

const SAMPLERS = new Set(["top", "ps", "sh"]);

/** Up to three busiest processes, leaving out idle ones and the ones doing the looking. */
export function parseProcesses(os, stdout) {
  return (os === "Linux" ? linuxRows : psRows)(stdout)
    .filter(({ cpu, name }) => cpu >= 1 && !SAMPLERS.has(name))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 3);
}
