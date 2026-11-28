// Samples every machine, feeds the alert rules, sends what they ask for and
// publishes the latest figures. Herdr's functions are passed in. A machine name
// only ever travels as `exec`'s `on` option, so it never reaches a shell.
import { createAlerts, gapMs } from "./engine.mjs";
import { staleAfterSec, toReading, worthWriting } from "./readings.mjs";
import {
  PROCESS_SCRIPTS, SAMPLE_SCRIPT, UNSUPPORTED_EXIT, cpuBusy, parseProcesses, parseSample,
} from "./sample.mjs";

export const STATE_KEY = "fleet-resources.state";
export const READINGS_KEY = "fleet-resources.readings";
export const TIMEOUT_MS = 10_000;

const PRESSURE = { 1: "normal", 2: "warn", 4: "critical" };

// Names come from other machines: no control or direction characters, bounded length.
function clean(text, max) {
  const line = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const gib = (bytes) => (bytes / 2 ** 30).toFixed(1);
const sentences = (...parts) => parts.filter(Boolean).join(". ");

function describe({ type, rule, resource }, sample, processes) {
  const recovered = type === "recover";
  if (rule === "unreachable") {
    return recovered
      ? ["answering again", "Resource samples are arriving again."]
      : ["not answering", "No resource sample could be read from it."];
  }
  if (rule === "disk") {
    const disk = sample.disks.find((item) => item.mount === resource);
    return [
      `disk ${recovered ? "recovered, " : ""}${disk.pct}% full`,
      `${gib(disk.freeKb * 1024)} GB free on ${clean(resource, 120)}`,
    ];
  }
  const top = processes.length
    ? `Top CPU: ${processes.map((p) => `${clean(p.name, 40)} ${Math.round(p.cpu)}%`).join(", ")}`
    : "";
  if (rule === "cpu") {
    const load = sample.load !== null && sample.cores ? `Load ${sample.load} on ${sample.cores} cores` : "";
    return [`CPU ${recovered ? "recovered, " : ""}${Math.round(sample.cpu)}%`, sentences(load, top)];
  }
  const value = sample.os === "Darwin"
    ? `pressure ${PRESSURE[sample.pressure] ?? sample.pressure}`
    : `${Math.floor(sample.memAvailPct)}% available`;
  const swap = sample.swap ? `Swap ${gib(sample.swap.used)} of ${gib(sample.swap.total)} GB used` : "";
  return [`memory ${recovered ? "recovered, " : ""}${value}`, sentences(swap, top)];
}

const PLATFORMS = { linux: "Linux", macos: "Darwin" };

/** `platform` is the viewer's `window().platform`, used until this computer has been sampled. */
export function createDaemon({ machines, exec, notify, shared, setShared, now, log, config, platform }) {
  const alerts = createAlerts(shared(STATE_KEY), config, now());
  const hosts = new Map(); // listed machine -> what its next sample needs; null = this computer
  const busy = new Set();
  let written = JSON.stringify(alerts.snapshot());
  let listed = new Map(); // machine -> layout, as of the latest tick
  let published = []; // the readings last written
  let viewerOs = PLATFORMS[platform] ?? null;
  let closed = false;

  // Every write re-renders all mods, so only a change is written.
  function persist() {
    const state = alerts.snapshot();
    const text = JSON.stringify(state);
    if (text === written) return;
    written = text;
    setShared(STATE_KEY, state);
  }

  // A failed sample leaves the previous reading, which ages through `observedAt`.
  // The latest layout decides here, so a late sample cannot bring back a machine
  // that has since become unavailable.
  function publish() {
    const entries = [];
    for (const [name, host] of hosts) {
      if (listed.get(name) === "unavailable") host.reading = null;
      if (host.reading) entries.push({ route: name, ...host.reading });
    }
    if (!worthWriting(published, entries)) return;
    published = entries;
    setShared(READINGS_KEY, { version: 1, staleAfterSec: staleAfterSec(config), machines: entries });
  }

  async function desktop(title, body) {
    const options = { timeout: TIMEOUT_MS };
    let result;
    if (viewerOs === "Linux") {
      // notify-send decodes backslash escapes, and many daemons read the body as markup.
      const text = body.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      result = await exec("notify-send", ["-a", "Herdr", "--", title, text], options);
    } else if (viewerOs === "Darwin") {
      result = await exec("osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", title, body,
      ], options);
    } else return;
    if (result.code !== 0) throw new Error(result.stderr?.trim() || `exit ${result.code}`);
  }

  function announce(name, event, sample, processes) {
    const [headline, detail] = describe(event, sample, processes);
    const title = clean(`${name === null ? "This computer" : clean(name, 60)}: ${headline}`, 120);
    const body = clean(detail, 300);
    const level = event.type === "recover" ? "success" : event.rule === "unreachable" ? "error" : "warning";
    notify({ title, body, level });
    if (config.desktop && event.type === "raise") {
      desktop(title, body).catch((error) => log(`desktop notification failed: ${error?.message ?? error}`));
    }
  }

  async function topProcesses(name, sample, events) {
    if (!events.some((e) => e.type === "raise" && (e.rule === "cpu" || e.rule === "memory"))) return [];
    try {
      const result = await exec("sh", ["-c", PROCESS_SCRIPTS[sample.os]], { on: name, timeout: TIMEOUT_MS });
      return result.code === 0 ? parseProcesses(sample.os, result.stdout) : [];
    } catch {
      return [];
    }
  }

  async function record(name, host, sample) {
    const at = now();
    if (host.at !== null && at - host.at > gapMs(config)) host.counters = null;
    host.at = at;
    if (sample?.os === "Linux") sample.cpu = cpuBusy(host.counters, sample.counters);
    host.counters = sample?.counters ?? null;
    if (sample) host.reading = toReading(sample, at);
    if (sample && name === null) viewerOs = sample.os;

    const events = alerts.observe(name, sample, at);
    if (events.length) {
      const processes = await topProcesses(name, sample, events);
      if (closed || hosts.get(name) !== host) return;
      for (const event of events) {
        announce(name, event, sample, processes);
        alerts.sent(name, event, now());
      }
    }
    persist();
  }

  async function check(name, layout) {
    if (layout === "loading" || busy.has(name)) return;
    if (!hosts.has(name)) hosts.set(name, { counters: null, at: null, reading: null, unsupported: false });
    const host = hosts.get(name);
    busy.add(name);
    try {
      let result = null;
      if (layout !== "unavailable") {
        try {
          result = await exec("sh", ["-c", SAMPLE_SCRIPT], { on: name, timeout: TIMEOUT_MS });
        } catch {
          // unreachable: a failed observation
        }
        if (closed || hosts.get(name) !== host) return;
      }
      if (result?.code === UNSUPPORTED_EXIT) {
        host.unsupported = true;
        host.reading = null;
        alerts.forget((machine) => machine === name);
        persist();
        return;
      }
      const sample = result ? parseSample(result.stdout) : null;
      // A system we cannot sample must never be reported as not answering.
      if (!sample && host.unsupported) return;
      await record(name, host, sample);
    } finally {
      busy.delete(name);
    }
  }

  return {
    /** Starts one sample on every machine that has none in flight, then publishes. */
    async tick() {
      if (closed) return;
      // This computer is sampled once, whether or not machines() lists it.
      listed = new Map([[null, "ready"]]);
      for (const { name, layout } of machines()) if (name) listed.set(name, layout);
      for (const name of hosts.keys()) if (!listed.has(name)) hosts.delete(name);
      alerts.forget((name) => !listed.has(name));
      persist();
      await Promise.all([...listed].map(([name, layout]) =>
        check(name, layout).catch((error) => log(`check failed: ${error?.message ?? error}`))));
      if (!closed) publish();
    },
    close() {
      closed = true;
    },
  };
}
