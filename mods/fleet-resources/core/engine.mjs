// Alert rules and their state: which readings raise, hold, repeat and clear.
// Pure: time and samples come in as arguments.
//
// The hold and recovery state machine is modeled on mods/health-watch/engine.js
// in ananjaemin/herdr-health-watch (MIT, commit
// de41f5a1db48e46af0ae300b1b4cb5488758c601); no code is copied. License:
// LICENSES/ananjaemin-herdr-health-watch.txt.

const CLEAR_MS = 60_000;
const DISK_HOLD_MS = 30_000;
const DISK_REPEAT_MS = 24 * 3600_000;

// [default, min, max]
const NUMBERS = {
  intervalSec: [15, 5, 3600],
  cpuPct: [90, 1, 100],
  cpuClearPct: [75, 1, 100],
  memAvailPct: [10, 1, 95],
  diskPct: [90, 4, 100],
  holdSec: [120, 0, 86400],
  repeatMin: [15, 1, 10080],
};

export function readConfig(props) {
  const config = {};
  for (const [name, [fallback, min, max]] of Object.entries(NUMBERS)) {
    const value = props?.[name];
    config[name] = Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  }
  config.cpuClearPct = Math.min(config.cpuClearPct, config.cpuPct);
  config.desktop = typeof props?.desktop === "boolean" ? props.desktop : true;
  return config;
}

// Observations further apart than this say nothing about the time between them.
export const gapMs = (config) => Math.max(3 * config.intervalSec, 60) * 1000;

// What one observation says about each rule it can judge; an unknown metric has
// no reading. `null` stands for a failed observation.
function readings(sample, config) {
  const holdMs = config.holdSec * 1000;
  const list = [];
  const add = (rule, resource, high, low, hold = holdMs, clearMs = CLEAR_MS) =>
    list.push({ rule, resource, high, low, holdMs: hold, clearMs });
  // No clear duration: the two-observation minimum alone clears it.
  add("unreachable", "", !sample, Boolean(sample), holdMs, 0);
  if (!sample) return list;
  const { os, cpu, memAvailPct, pressure, disks } = sample;
  if (cpu !== null) add("cpu", "", cpu >= config.cpuPct, cpu < config.cpuClearPct);
  // macOS runs normally at "warn" pressure with swap nearly full: only critical counts.
  if (os === "Darwin") {
    if (pressure !== null) add("memory", "", pressure >= 4, pressure < 4);
  } else if (memAvailPct !== null) {
    add("memory", "", memAvailPct < config.memAvailPct, memAvailPct >= config.memAvailPct + 5);
  }
  for (const { mount, pct } of disks) {
    add("disk", mount, pct >= config.diskPct, pct < config.diskPct - 3, DISK_HOLD_MS);
  }
  return list;
}

// An unbroken stretch of observations that agree.
const extend = (run, now) => ({ since: run?.since ?? now, count: (run?.count ?? 0) + 1 });
const lasted = (run, ms, now) => run !== null && run.count >= 2 && now - run.since >= ms;

/**
 * `saved` is an earlier `snapshot()`: the alerts that were sent, and when. Those
 * older than their repeat window say nothing about what is happening now.
 */
export function createAlerts(saved, config, now) {
  const entries = new Map();
  const keyOf = (machine, rule, resource) => JSON.stringify([machine, rule, resource]);
  const repeatMs = (rule) => (rule === "disk" ? DISK_REPEAT_MS : config.repeatMin * 60_000);
  const blank = (machine, rule, resource) => ({
    machine, rule, resource, active: false, notified: false, notifiedAt: null,
    highs: null, lows: null, seenAt: null,
  });

  for (const item of Array.isArray(saved?.alerts) ? saved.alerts : []) {
    const { machine, rule, resource, notifiedAt } = item ?? {};
    if (!(machine === null || typeof machine === "string") || typeof rule !== "string"
      || typeof resource !== "string" || !Number.isFinite(notifiedAt)
      || now - notifiedAt >= repeatMs(rule)) continue;
    entries.set(keyOf(machine, rule, resource), {
      ...blank(machine, rule, resource),
      active: item.active === true,
      notified: item.notified === true,
      notifiedAt,
    });
  }

  return {
    /**
     * Returns the notifications now due: `{ type: "raise" | "recover", rule,
     * resource }`. A raise stays due until `sent` confirms it.
     */
    observe(machine, sample, now) {
      const events = [];
      for (const { rule, resource, high, low, holdMs, clearMs } of readings(sample, config)) {
        const key = keyOf(machine, rule, resource);
        const entry = entries.get(key) ?? blank(machine, rule, resource);
        entries.set(key, entry);
        if (entry.seenAt !== null && now - entry.seenAt > gapMs(config)) entry.highs = entry.lows = null;
        entry.seenAt = now;
        entry.highs = high ? extend(entry.highs, now) : null;
        entry.lows = low ? extend(entry.lows, now) : null;

        const sustained = lasted(entry.highs, holdMs, now);
        if (!entry.active) {
          entry.active = sustained;
        } else if (lasted(entry.lows, clearMs, now)) {
          entry.active = false;
          if (entry.notified) events.push({ type: "recover", rule, resource });
          entry.notified = false;
        }

        // Covers the raise itself, its repeats, and a re-raise held back by the window.
        // A machine that is off stays off, so each outage is announced once.
        const told = rule === "unreachable" && entry.notified;
        if (entry.active && sustained && !told
          && (entry.notifiedAt === null || now - entry.notifiedAt >= repeatMs(rule))) {
          events.push({ type: "raise", rule, resource });
        }
      }
      for (const [key, entry] of entries) {
        if (entry.machine !== machine || entry.active || entry.highs) continue;
        if (entry.notifiedAt === null || now - entry.notifiedAt >= repeatMs(entry.rule)) entries.delete(key);
      }
      return events;
    },

    /** Records that a notification from `observe` reached the person. */
    sent(machine, { type, rule, resource }, now) {
      const entry = entries.get(keyOf(machine, rule, resource));
      if (type !== "raise" || !entry) return;
      entry.notified = true;
      entry.notifiedAt = now;
    },

    forget(gone) {
      for (const [key, entry] of entries) if (gone(entry.machine)) entries.delete(key);
    },

    snapshot() {
      return {
        alerts: [...entries.values()]
          .filter((entry) => entry.notifiedAt !== null)
          .map(({ machine, rule, resource, active, notified, notifiedAt }) =>
            ({ machine, rule, resource, active, notified, notifiedAt })),
      };
    },
  };
}
