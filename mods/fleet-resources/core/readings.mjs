// The latest figures of each machine, as published in shared state for other
// mods to show. Pure: samples and time come in as arguments.
import { MAC_DATA } from "./sample.mjs";

const METRICS = ["cpuPct", "memPct", "diskPct"];
const STEP = 3;
const HEARTBEAT_SEC = 60;

/** How old a reading may be before a reader should stop showing it as live. */
export const staleAfterSec = (config) => Math.max(180, Math.ceil(3 * config.intervalSec));

const whole = (pct) => (pct === null ? null : Math.max(0, Math.min(100, Math.round(pct))));

// The disk holding the user's files, never a stand-in for it.
function mainDisk({ os, disks }) {
  const at = (mount) => disks.find((disk) => disk.mount === mount);
  return (os === "Darwin" ? at(MAC_DATA) ?? at("/") : at("/"))?.pct ?? null;
}

/** One sample taken at `at` (milliseconds), as whole percentages in use. */
export function toReading(sample, at) {
  return {
    cpuPct: whole(sample.cpu),
    memPct: whole(sample.memPct),
    diskPct: whole(mainDisk(sample)),
    observedAt: Math.floor(at / 1000),
  };
}

const moved = (before, after) =>
  (before === null || after === null ? before !== after : Math.abs(after - before) >= STEP);

/**
 * Whether the `latest` entries differ enough from the `written` ones to be worth
 * a write. A newer observation alone counts now and then, to show the data is live.
 */
export function worthWriting(written, latest) {
  if (written.length !== latest.length) return true;
  const previous = new Map(written.map((entry) => [entry.route, entry]));
  return latest.some((entry) => {
    const old = previous.get(entry.route);
    return !old || entry.observedAt - old.observedAt >= HEARTBEAT_SEC
      || METRICS.some((metric) => moved(old[metric], entry[metric]));
  });
}
