const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const moduleApi = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const modDir = path.join(root, "mods", "quota-resume");
const HERDR_STUB_SYM = Symbol.for("herdr.test.quotaResumeStub");
let mainLoaderRegistered = false;

async function loadMainMod() {
  if (!mainLoaderRegistered) {
    const gpuiKitSource = `
      export class View {}
      export function div() {
        return { id() { return this; }, size() { return this; } };
      }
    `;
    const herdrSource = `
      const stub = () => globalThis[Symbol.for("herdr.test.quotaResumeStub")];
      export const terminals = (...a) => stub().terminals(...a);
      export const panes = (...a) => stub().panes(...a);
      export const spaces = (...a) => stub().spaces(...a);
      export const shared = (...a) => stub().shared(...a);
      export const setShared = (...a) => stub().setShared(...a);
      export const hc = (...a) => stub().hc(...a);
      export const exec = (...a) => stub().exec(...a);
      export const notify = (...a) => stub().notify(...a);
      export const checking = (...a) => stub().checking(...a);
    `;
    if (typeof moduleApi.registerHooks === "function") {
      moduleApi.registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "gpui-kit" || specifier === "herdr") {
            return { url: "stub:///" + specifier, shortCircuit: true };
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url === "stub:///gpui-kit") {
            return { format: "module", shortCircuit: true, source: gpuiKitSource };
          }
          if (url === "stub:///herdr") {
            return { format: "module", shortCircuit: true, source: herdrSource };
          }
          return nextLoad(url, context);
        },
      });
    } else {
      const hooksSource = `
        export async function resolve(specifier, context, nextResolve) {
          if (specifier === "gpui-kit" || specifier === "herdr") {
            return { url: "stub:///" + specifier, shortCircuit: true };
          }
          return nextResolve(specifier, context);
        }
        export async function load(url, context, nextLoad) {
          if (url === "stub:///gpui-kit") {
            return { format: "module", shortCircuit: true, source: ${JSON.stringify(gpuiKitSource)} };
          }
          if (url === "stub:///herdr") {
            return { format: "module", shortCircuit: true, source: ${JSON.stringify(herdrSource)} };
          }
          return nextLoad(url, context);
        }
      `;
      moduleApi.register(
        "data:text/javascript;base64," + Buffer.from(hooksSource, "utf8").toString("base64"),
        pathToFileURL(__filename),
      );
    }
    mainLoaderRegistered = true;
  }
  const mod = await import(pathToFileURL(path.join(modDir, "main.js")).href);
  return mod.default;
}

async function loadCore() {
  const [protocol, screen, transcript, engine] = await Promise.all([
    import(pathToFileURL(path.join(modDir, "core", "protocol.mjs")).href),
    import(pathToFileURL(path.join(modDir, "core", "screen.mjs")).href),
    import(pathToFileURL(path.join(modDir, "core", "transcript.mjs")).href),
    import(pathToFileURL(path.join(modDir, "core", "engine.mjs")).href),
  ]);
  return { protocol, screen, transcript, engine };
}

const UUID_1 = "d322ef60-1111-4222-8333-444455556666";
const UUID_2 = "a1111111-2222-4333-8444-555566667777";
const UUID_ERR = "e0000000-1111-4222-8333-444455556666";
const UUID_ERR_2 = "e1111111-1111-4222-8333-444455556666";

function makeTerminal(overrides = {}) {
  return {
    address: "t1",
    state: "live",
    status: "idle",
    turn: 10,
    status_ms: 1000,
    title: "Fix quota resume",
    program: { key: "claude", name: "Claude Code", agent: true, shell: false },
    foreground: { pid: 100, name: "claude" },
    report: { app: "claude-code", state: "idle", msg: null },
    labels: { "claude.session": UUID_1, "claude.title": "My Claude Task" },
    argv: ["claude"],
    ...overrides,
  };
}

function makeFreshGet(overrides = {}) {
  return {
    address: "t1",
    state: "live",
    turn: 10,
    foreground: { pid: 100, name: "claude" },
    status: { app: "claude-code", state: "idle" },
    labels: { "claude.session": UUID_1 },
    argv: ["claude"],
    ...overrides,
  };
}

function createHarness({
  nowMs = 1_795_715_000_000,
  terminals = [],
  panes = [],
  spaces = [],
  sharedInit = {},
  enabled = true,
  hcHandler,
  execHandler,
  hcTimeoutMs,
} = {}) {
  let clock = nowMs;
  const sharedStore = { ...sharedInit };
  if (enabled !== null && !Object.prototype.hasOwnProperty.call(sharedStore, "quota-resume.state")) {
    sharedStore["quota-resume.state"] = { version: 1, enabled };
  }
  const hcCalls = [];
  const execCalls = [];
  const notifyCalls = [];
  const sleepCalls = [];
  let termList = terminals;

  const env = {
    now: () => clock,
    terminals: () => termList,
    panes: () => panes,
    spaces: () => spaces,
    shared: (k) => sharedStore[k],
    setShared: (k, v) => {
      sharedStore[k] = v;
    },
    hc: async (args) => {
      hcCalls.push(args);
      if (hcHandler) return hcHandler(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    exec: async (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      if (execHandler) return execHandler(cmd, args, opts);
      return { code: 3, stdout: "", stderr: "" };
    },
    notify: (n) => notifyCalls.push(n),
    sleep: async (ms) => {
      sleepCalls.push(ms);
      clock += ms;
    },
    log: () => {},
    ...(hcTimeoutMs != null ? { hcTimeoutMs } : {}),
  };

  return {
    env,
    sharedStore,
    hcCalls,
    execCalls,
    notifyCalls,
    sleepCalls,
    setNow: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
    setTerminals: (list) => {
      termList = list;
    },
  };
}

test("protocol: state normalization, history cap, and command parsing", async () => {
  const { protocol } = await loadCore();
  assert.equal(protocol.STATE_KEY, "quota-resume.state");
  assert.equal(protocol.COMMAND_KEY, "quota-resume.command");

  const def = protocol.defaultState(12345);
  assert.equal(def.version, 1);
  assert.equal(def.enabled, false);
  assert.equal(def.settings.delaySec, 60);
  assert.deepEqual(def.settings.agents, { claude: true, codex: true, opencode: true });

  // Trusted shared state: persisted prompt overrides are rejected in favor of DEFAULT_PROMPT.
  const normSettings = protocol.normalizeSettings({ prompt: "rm -rf /", delaySec: 99999 });
  assert.equal(normSettings.prompt, protocol.DEFAULT_PROMPT);
  assert.equal(normSettings.delaySec, protocol.MAX_DELAY_SEC);

  let hist = [];
  for (let i = 0; i < 65; i++) {
    hist = protocol.appendHistory(hist, { id: `h-${i}`, atMs: i });
  }
  assert.equal(hist.length, 50);
  assert.equal(hist[0].id, "h-64");
  assert.equal(hist[49].id, "h-15");

  assert.equal(protocol.parseCommand({ version: 2, id: "x", action: "clear-history" }), null);
  assert.equal(protocol.parseCommand({ version: 1, id: "x", action: "cancel" }), null);
  assert.equal(protocol.parseCommand({ version: 1, id: "x", action: "toggle-agent", agent: "pi" }), null);
  assert.deepEqual(
    protocol.parseCommand({ version: 1, id: "c1", action: "cancel", address: "linux/t3", atMs: 9 }),
    { version: 1, id: "c1", action: "cancel", address: "linux/t3", atMs: 9 },
  );
  assert.equal(protocol.machineOf("t2c"), null);
  assert.equal(protocol.machineOf("linux/t3n"), "linux");
});

test("screen: detects Claude/Codex/OpenCode banners, parses timestamps, and rejects prose", async () => {
  const { screen } = await loadCore();
  const nowMs = Date.parse("2026-11-26T15:00:00Z");

  // Claude screen banner with trailing prompt chrome
  const claudeText = [
    "Some earlier conversation text",
    "────────────────────────────────────",
    "You've hit your limit · resets 7pm (UTC)",
    "────────────────────────────────────",
    "> ",
    "? for shortcuts   shift+tab to cycle",
  ].join("\n");
  const claudeHit = screen.detectScreenRateLimit({ agent: "claude", text: claudeText, nowMs });
  assert.ok(claudeHit);
  assert.equal(claudeHit.resetsAtMs, Date.parse("2026-11-26T19:00:00Z"));

  // Codex banner with relative retry duration
  const codexText = [
    "Working on refactor...",
    "Error: You've hit your usage limit (usage_limit_reached).",
    "Try again in 4m 30s.",
    "› ",
  ].join("\n");
  const codexHit = screen.detectScreenRateLimit({ agent: "codex", text: codexText, nowMs });
  assert.ok(codexHit);
  assert.equal(codexHit.resetsAtMs, nowMs + (4 * 60 + 30) * 1000);

  // OpenCode banner with HTTP 429 and Retry-After / relative duration
  const ocText = [
    "HTTP 429 Too Many Requests",
    "Rate limit exceeded. Please try again in 2h 15m.",
  ].join("\n");
  const ocHit = screen.detectScreenRateLimit({ agent: "opencode", text: ocText, nowMs });
  assert.ok(ocHit);
  assert.equal(ocHit.resetsAtMs, nowMs + (2 * 3600 + 15 * 60) * 1000);

  // OpenCode Retry-After seconds & "after 30s" & ISO 8601
  assert.equal(screen.parseResetTime("Retry-After: 120", nowMs), nowMs + 120_000);
  assert.equal(screen.parseResetTime("Retry after 30s", nowMs), nowMs + 30_000);
  assert.equal(screen.parseResetTime("Try again in 45 seconds", nowMs), nowMs + 45_000);
  assert.equal(screen.parseResetTime("resets at 2026-11-26T20:30:00Z", nowMs), Date.parse("2026-11-26T20:30:00Z"));

  // Reject casual prose / quoted examples / comments discussing rate limits
  const proseText = [
    'Assistant: For example, when the user sees "You\'ve hit your usage limit" or `rate_limit_exceeded`,',
    "// tests for HTTP 429 Too Many Requests banner matcher",
    "User: How does the rate limit reached pattern work?",
  ].join("\n");
  assert.equal(screen.detectScreenRateLimit({ agent: "claude", text: proseText, nowMs }), null);
  assert.equal(screen.detectScreenRateLimit({ agent: "codex", text: proseText, nowMs }), null);
  assert.equal(screen.detectScreenRateLimit({ agent: "opencode", text: proseText, nowMs }), null);

  // Reject old error buried >15 non-chrome lines above the bottom
  const buriedLines = [
    "You've hit your usage limit",
    ...Array.from({ length: 18 }, (_, i) => `Normal assistant output line ${i + 1}`),
  ].join("\n");
  assert.equal(screen.detectScreenRateLimit({ agent: "codex", text: buriedLines, nowMs }), null);
});

test("transcript: UUID validation, JSONL parsing, active quota error, and reply detection", async () => {
  const { transcript } = await loadCore();

  // Rejects non-UUID / shell injection attempts
  assert.equal(transcript.buildTranscriptExecArgs("not-a-uuid"), null);
  assert.equal(transcript.buildTranscriptExecArgs(`${UUID_1}; rm -rf /`), null);
  assert.equal(transcript.buildTranscriptExecArgs("../secret"), null);

  const args = transcript.buildTranscriptExecArgs(UUID_1);
  assert.ok(Array.isArray(args));
  assert.equal(args[0], "-c");
  assert.equal(args[3], UUID_1);
  assert.equal(args[1].includes(UUID_1), false, "sessionId must never be interpolated into sh script");

  const nowMs = Date.parse("2026-11-26T15:00:00Z");
  const resetsAtSec = Math.floor(Date.parse("2026-11-26T19:00:00Z") / 1000);

  const tailWithError = [
    '{"truncated_first_line',
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-26T14:58:00Z" }),
    JSON.stringify({
      type: "assistant",
      uuid: UUID_ERR,
      isApiErrorMessage: true,
      timestamp: "2026-11-26T14:59:00Z",
      quotaLimits: { resetsAt: resetsAtSec, rateLimitType: "five_hour" },
    }),
  ].join("\n");

  const entries = transcript.parseTranscriptTail(tailWithError);
  assert.equal(entries.length, 2);

  const active = transcript.findActiveQuotaError(entries, nowMs);
  assert.ok(active);
  assert.equal(active.uuid, UUID_ERR);
  assert.equal(active.resetsAtMs, resetsAtSec * 1000);
  assert.equal(active.reason, "five_hour rate limit");
  assert.equal(transcript.hasAssistantReplySince(entries, UUID_ERR), false);

  // Once a non-error assistant reply lands afterwards, error is no longer active
  const withReply = [
    ...entries,
    { type: "assistant", uuid: "reply-1", isApiErrorMessage: false, timestamp: "2026-11-26T15:05:00Z" },
  ];
  assert.equal(transcript.findActiveQuotaError(withReply, nowMs), null);
  assert.equal(transcript.hasAssistantReplySince(withReply, UUID_ERR), true);
});

test("engine: detects remote Claude via transcript, debounces idle terminal, and resumes after reset", async () => {
  const { engine, protocol } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const resetsAtSec = Math.floor(Date.parse("2026-11-26T15:10:00Z") / 1000);

  const transcriptJsonl = JSON.stringify({
    type: "assistant",
    uuid: "err-remote-1",
    isApiErrorMessage: true,
    timestamp: "2026-11-26T14:59:30Z",
    apiErrorParams: { rate_limit_info: { resetsAt: resetsAtSec, rateLimitType: "five_hour" } },
  });

  const remoteTerm = makeTerminal({
    address: "linux/t3n",
    turn: 279,
    labels: { "claude.session": UUID_1, "claude.title": "Herdr layout options" },
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [remoteTerm],
    panes: [{ pane: "p1", terminal: "linux/t3n", tab: "tab-1" }],
    spaces: [{ id: "sp-1", name: "ISW", tabs: [{ id: "tab-1", name: "cdm-ai pr 318" }] }],
    execHandler: async () => ({ code: 0, stdout: transcriptJsonl, stderr: "" }),
    hcHandler: async (args) => {
      if (args[0] === "get") {
        return {
          code: 0,
          stdout: JSON.stringify(makeFreshGet({ address: "linux/t3n", turn: 279 })),
          stderr: "",
        };
      }
      if (args[0] === "send") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  const st1 = await eng.tick();
  assert.equal(st1.queue.length, 1);
  const q = st1.queue[0];
  assert.equal(q.address, "linux/t3n");
  assert.equal(q.machine, "linux");
  assert.equal(q.agent, "claude");
  assert.equal(q.resetSource, "transcript");
  assert.equal(q.resetsAtMs, resetsAtSec * 1000);
  assert.equal(q.resumeAtMs, resetsAtSec * 1000 + 60_000);
  assert.equal(q.where, "ISW / cdm-ai pr 318");
  assert.equal(q.errorFingerprint, "err-remote-1");

  // Verify exec ran on remote machine "linux" with timeout 8000 and positional UUID
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.execCalls[0].cmd, "sh");
  assert.equal(h.execCalls[0].opts.on, "linux");
  assert.equal(h.execCalls[0].opts.timeout, 8000);
  assert.equal(h.execCalls[0].args[3], UUID_1);

  // Before resumeAtMs: nothing sent yet
  h.setNow(resetsAtSec * 1000 + 30_000);
  await eng.tick();
  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);

  // At resumeAtMs: guardrails run and prompt is sent!
  h.setNow(resetsAtSec * 1000 + 60_000);
  const st2 = await eng.tick();
  assert.equal(st2.queue.length, 0);
  assert.equal(st2.history.length, 1);
  assert.equal(st2.history[0].outcome, "resumed");
  assert.equal(st2.history[0].machine, "linux");
  const sends = h.hcCalls.filter((a) => a[0] === "send");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], ["send", "--if", "idle", "linux/t3n", protocol.DEFAULT_PROMPT]);
  assert.equal(h.notifyCalls.length, 1);
  assert.equal(h.notifyCalls[0].level, "info");

  // Subsequent tick with same terminal signature does NOT re-probe or re-queue
  const execBefore = h.execCalls.length;
  await eng.tick();
  assert.equal(h.execCalls.length, execBefore);
  assert.equal(eng.getState().queue.length, 0);
});

test("engine: definitive Claude transcript with no error suppresses screen fallback false positives", async () => {
  const { engine } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");

  const normalTranscript = JSON.stringify({
    type: "assistant",
    uuid: "ok-1",
    isApiErrorMessage: false,
    timestamp: "2026-11-26T14:59:00Z",
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [makeTerminal()],
    execHandler: async () => ({ code: 0, stdout: normalTranscript, stderr: "" }),
    hcHandler: async (args) => {
      if (args[0] === "read") {
        return { code: 0, stdout: "You've hit your limit · resets 7pm (UTC)", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  const st = await eng.tick();
  assert.equal(st.queue.length, 0);
  assert.equal(h.hcCalls.filter((a) => a[0] === "read").length, 0);
});

test("engine: Codex quota fallback and OpenCode screen detection", async () => {
  const { engine, protocol } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const codexResetSec = Math.floor(Date.parse("2026-11-26T16:30:00Z") / 1000);

  const codexTerm = makeTerminal({
    address: "t-codex",
    program: { key: "codex", name: "Codex", agent: true, shell: false },
    foreground: { pid: 200, name: "codex" },
    report: { app: "codex", state: "error" },
    labels: {},
    argv: ["codex"],
  });
  const opencodeTerm = makeTerminal({
    address: "t-oc",
    program: { key: "opencode", name: "OpenCode", agent: true, shell: false },
    foreground: { pid: 300, name: "opencode" },
    report: { app: "opencode", state: "error" },
    labels: {},
    argv: ["opencode"],
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [codexTerm, opencodeTerm],
    sharedInit: {
      [protocol.USAGE_LIMITS_STATE_KEY]: {
        codex: {
          installed: true,
          report: {
            status: "ok",
            observedAt: Math.floor(baseMs / 1000),
            windows: [{ id: "codex:primary", short: "5h", percent: 100, resetsAt: codexResetSec }],
          },
        },
      },
    },
    hcHandler: async (args) => {
      if (args[0] === "read" && args[1] === "t-codex") {
        // No explicit timestamp on screen -> should resolve from usage-limits.state!
        return { code: 0, stdout: "Error: usage_limit_reached", stderr: "" };
      }
      if (args[0] === "read" && args[1] === "t-oc") {
        return { code: 0, stdout: "HTTP 429 Too Many Requests\nRetry after 3m", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  const st = await eng.tick();
  assert.equal(st.queue.length, 2);

  const qCodex = st.queue.find((q) => q.address === "t-codex");
  assert.equal(qCodex.agent, "codex");
  assert.equal(qCodex.resetSource, "quota");
  assert.equal(qCodex.resetsAtMs, codexResetSec * 1000);

  const qOc = st.queue.find((q) => q.address === "t-oc");
  assert.equal(qOc.agent, "opencode");
  assert.equal(qOc.resetSource, "screen");
  assert.equal(qOc.resetsAtMs, baseMs + 180_000);
});

test("engine: live quota deferral and early recovery via usage-limits.state", async () => {
  const { engine, protocol } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const initialResetSec = Math.floor(Date.parse("2026-11-26T15:10:00Z") / 1000);
  const deferredResetSec = Math.floor(Date.parse("2026-11-26T18:00:00Z") / 1000);

  const transcriptJsonl = JSON.stringify({
    type: "assistant",
    uuid: "err-quota-1",
    isApiErrorMessage: true,
    timestamp: "2026-11-26T14:59:00Z",
    quotaLimits: { resetsAt: initialResetSec, type: "five_hour" },
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [makeTerminal({ address: "t1", turn: 5 })],
    execHandler: async () => ({ code: 0, stdout: transcriptJsonl, stderr: "" }),
    hcHandler: async (args) => {
      if (args[0] === "get") {
        return { code: 0, stdout: JSON.stringify(makeFreshGet({ address: "t1", turn: 5 })), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  await eng.tick();
  assert.equal(eng.getState().queue[0].resetsAtMs, initialResetSec * 1000);

  // Case 1: Past initial resetsAt, live usage still reports 100% with newer future resetsAt -> DEFER!
  const afterResetMs = initialResetSec * 1000 + 60_000;
  h.setNow(afterResetMs);
  h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
    claude: {
      report: {
        status: "ok",
        observedAt: Math.floor((initialResetSec * 1000 + 10_000) / 1000),
        windows: [{ id: "session", short: "5h", percent: 100, resetsAt: deferredResetSec }],
      },
    },
  };

  const stDeferred = await eng.tick();
  assert.equal(stDeferred.queue.length, 1, "must defer instead of firing into exhausted quota");
  assert.equal(stDeferred.queue[0].resetsAtMs, deferredResetSec * 1000);
  assert.equal(stDeferred.queue[0].resumeAtMs, deferredResetSec * 1000 + 60_000);
  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);

  // Case 2: Early recovery — fresh reading after detectedAtMs drops to <100% -> PROMOTE and resume immediately!
  const recoveryMs = afterResetMs + 120_000;
  h.setNow(recoveryMs);
  h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
    claude: {
      report: {
        status: "ok",
        observedAt: Math.floor(recoveryMs / 1000),
        windows: [
          { id: "session", short: "5h", percent: 35, resetsAt: deferredResetSec },
          { id: "weekly_all", short: "wk", percent: 40, resetsAt: deferredResetSec + 86400 },
        ],
      },
    },
  };

  const stRecovered = await eng.tick();
  assert.equal(stRecovered.queue.length, 0);
  assert.equal(stRecovered.history[0].outcome, "resumed");
  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
});

test("engine: rejects past resetsAt timestamps to prevent infinite retry loops", async () => {
  const { engine } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const pastResetSec = Math.floor(Date.parse("2026-11-26T14:00:00Z") / 1000);

  const staleTranscript = JSON.stringify({
    type: "assistant",
    uuid: "err-stale",
    isApiErrorMessage: true,
    timestamp: "2026-11-26T13:50:00Z",
    quotaLimits: { resetsAt: pastResetSec, type: "five_hour" },
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [makeTerminal()],
    execHandler: async () => ({ code: 0, stdout: staleTranscript, stderr: "" }),
  });

  const eng = engine.createEngine(h.env);
  const st = await eng.tick();
  assert.equal(st.queue.length, 0);
});

test("engine: pre-fire guardrails skip closed, shell, wrong session, busy, turn-advanced, and replied", async () => {
  const { engine } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const resetSec = Math.floor(Date.parse("2026-11-26T15:05:00Z") / 1000);

  const cases = [
    {
      name: "closed terminal",
      freshGet: makeFreshGet({ state: "exited" }),
      expected: "skipped-closed",
    },
    {
      name: "bare shell in foreground",
      freshGet: makeFreshGet({ foreground: { pid: 10, name: "zsh" } }),
      expected: "skipped-session",
    },
    {
      name: "different claude session label",
      freshGet: makeFreshGet({ labels: { "claude.session": UUID_2 } }),
      expected: "skipped-session",
    },
    {
      name: "busy working terminal",
      freshGet: makeFreshGet({ status: { app: "claude-code", state: "working" } }),
      expected: "skipped-busy",
    },
    {
      name: "blocked terminal",
      freshGet: makeFreshGet({ status: { app: "claude-code", state: "blocked" } }),
      expected: "skipped-busy",
    },
    {
      name: "turn advanced",
      freshGet: makeFreshGet({ turn: 11 }),
      expected: "skipped-replied",
    },
    {
      name: "transcript has assistant reply since error",
      freshGet: makeFreshGet({ turn: 10 }),
      repliedInTranscript: true,
      expected: "skipped-replied",
    },
  ];

  for (const tc of cases) {
    let phase = "detect";
    const errLine = JSON.stringify({
      type: "assistant",
      uuid: UUID_ERR,
      isApiErrorMessage: true,
      timestamp: "2026-11-26T14:59:30Z",
      quotaLimits: { resetsAt: resetSec, rateLimitType: "five_hour" },
    });
    const replyLine = JSON.stringify({
      type: "assistant",
      uuid: "reply-after",
      isApiErrorMessage: false,
      timestamp: "2026-11-26T15:02:00Z",
    });

    const h = createHarness({
      nowMs: baseMs,
      terminals: [makeTerminal({ turn: 10 })],
      execHandler: async () => ({
        code: 0,
        stdout: phase === "fire" && tc.repliedInTranscript ? `${errLine}\n${replyLine}` : errLine,
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(tc.freshGet), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, tc.name);

    phase = "fire";
    h.setNow(resetSec * 1000 + 60_000);
    const st = await eng.tick();
    assert.equal(st.queue.length, 0, tc.name);
    assert.equal(st.history[0].outcome, tc.expected, tc.name);
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, `${tc.name} must not send`);
  }
});

test("engine: staggers concurrent ready resumes by 2000ms", async () => {
  const { engine } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const resetSec = Math.floor(Date.parse("2026-11-26T15:05:00Z") / 1000);

  const t1 = makeTerminal({ address: "t1", labels: { "claude.session": UUID_1 }, turn: 1 });
  const t2 = makeTerminal({ address: "t2", labels: { "claude.session": UUID_2 }, turn: 2 });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [t1, t2],
    execHandler: async (_cmd, args) => ({
      code: 0,
      stdout: JSON.stringify({
        type: "assistant",
        uuid: `err-${args[3]}`,
        isApiErrorMessage: true,
        timestamp: "2026-11-26T14:59:30Z",
        quotaLimits: { resetsAt: resetSec, type: "five_hour" },
      }),
      stderr: "",
    }),
    hcHandler: async (args) => {
      if (args[0] === "get") {
        const isT1 = args[1] === "t1";
        return {
          code: 0,
          stdout: JSON.stringify(
            makeFreshGet({
              address: args[1],
              turn: isT1 ? 1 : 2,
              labels: { "claude.session": isT1 ? UUID_1 : UUID_2 },
            }),
          ),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  await eng.tick();
  assert.equal(eng.getState().queue.length, 2);

  h.setNow(resetSec * 1000 + 60_000);
  await eng.tick();

  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 2);
  assert.deepEqual(h.sleepCalls, [2000]);
});

test("engine: commands (toggle-enabled, toggle-agent, cancel, resume-now, clear-history) and dedup", async () => {
  const { engine, protocol } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const resetSec = Math.floor(Date.parse("2026-11-26T16:00:00Z") / 1000);

  const t1 = makeTerminal({ address: "t1", labels: { "claude.session": UUID_1 }, turn: 4 });
  const t2 = makeTerminal({ address: "t2", labels: { "claude.session": UUID_2 }, turn: 8 });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [t1, t2],
    execHandler: async (_cmd, args) => ({
      code: 0,
      stdout: JSON.stringify({
        type: "assistant",
        uuid: `err-${args[3]}`,
        isApiErrorMessage: true,
        timestamp: "2026-11-26T14:59:30Z",
        quotaLimits: { resetsAt: resetSec, type: "five_hour" },
      }),
      stderr: "",
    }),
    hcHandler: async (args) => {
      if (args[0] === "get") {
        const isT1 = args[1] === "t1";
        return {
          code: 0,
          stdout: JSON.stringify(
            makeFreshGet({
              address: args[1],
              turn: isT1 ? 4 : 8,
              labels: { "claude.session": isT1 ? UUID_1 : UUID_2 },
            }),
          ),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  await eng.tick();
  assert.equal(eng.getState().queue.length, 2);

  // Cancel t1 -> moves to history with outcome "cancelled", and does NOT re-queue on next tick!
  await eng.processCommand({ version: 1, id: "cmd-1", action: "cancel", address: "t1", atMs: baseMs + 1000 });
  assert.equal(eng.getState().queue.length, 1);
  assert.equal(eng.getState().history[0].outcome, "cancelled");
  assert.equal(eng.getState().lastHandledCommandId, "cmd-1");

  // Duplicate command id is ignored
  const handledAgain = await eng.processCommand({ version: 1, id: "cmd-1", action: "cancel", address: "t2", atMs: baseMs + 1001 });
  assert.equal(handledAgain, false);
  assert.equal(eng.getState().queue.length, 1);

  // Next tick does NOT re-queue cancelled t1 even if its status_ms changes (fingerprint remembered)
  h.setTerminals([makeTerminal({ address: "t1", labels: { "claude.session": UUID_1 }, turn: 4, status_ms: 9999 }), t2]);
  await eng.tick();
  assert.equal(eng.getState().queue.length, 1);
  assert.equal(eng.getState().queue[0].address, "t2");

  // resume-now on t2 -> sends immediately despite future resetsAt (using --if idle)
  await eng.processCommand({ version: 1, id: "cmd-2", action: "resume-now", address: "t2", atMs: baseMs + 2000 });
  assert.equal(eng.getState().queue.length, 0);
  assert.equal(eng.getState().history[0].outcome, "resumed");
  assert.equal(h.hcCalls.filter((a) => a[0] === "send" && a[3] === "t2").length, 1);

  // toggle-agent & toggle-enabled
  await eng.processCommand({ version: 1, id: "cmd-3", action: "toggle-agent", agent: "codex", enabled: false, atMs: baseMs + 3000 });
  assert.equal(eng.getState().settings.agents.codex, false);

  await eng.processCommand({ version: 1, id: "cmd-4", action: "toggle-enabled", enabled: false, atMs: baseMs + 4000 });
  assert.equal(eng.getState().enabled, false);

  // clear-history
  await eng.processCommand({ version: 1, id: "cmd-5", action: "clear-history", atMs: baseMs + 5000 });
  assert.deepEqual(eng.getState().history, []);
  assert.equal(h.sharedStore[protocol.STATE_KEY].history.length, 0);
});

test("engine: identifies opencode.exe foreground process and fires safely", async () => {
  const { engine } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");

  assert.equal(engine.identifyAgent({ foreground: { name: "opencode.exe" } }), "opencode");
  assert.equal(engine.identifyAgent({ foreground: { name: "/usr/bin/codex.exe" } }), "codex");

  const ocExeTerm = makeTerminal({
    address: "linux/t9",
    turn: 7,
    program: { key: "agent", name: "Agent", agent: true, shell: false },
    foreground: { pid: 500, name: "opencode.exe" },
    report: { app: null, state: "idle" },
    labels: {},
    argv: ["opencode.exe"],
  });

  const h = createHarness({
    nowMs: baseMs,
    terminals: [ocExeTerm],
    hcHandler: async (args) => {
      if (args[0] === "read") {
        return { code: 0, stdout: "HTTP 429 Too Many Requests\nRetry after 2m", stderr: "" };
      }
      if (args[0] === "get") {
        return {
          code: 0,
          stdout: JSON.stringify({
            address: "linux/t9",
            state: "live",
            turn: 7,
            foreground: { pid: 500, name: "opencode.exe" },
            status: { app: null, state: "idle" },
            labels: {},
            argv: ["opencode.exe"],
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  const st1 = await eng.tick();
  assert.equal(st1.queue.length, 1);
  assert.equal(st1.queue[0].agent, "opencode");

  h.setNow(baseMs + 180_000);
  const st2 = await eng.tick();
  assert.equal(st2.queue.length, 0);
  assert.equal(st2.history[0].outcome, "resumed");
  assert.equal(h.hcCalls.filter((a) => a[0] === "send" && a[3] === "linux/t9").length, 1);
});

test("engine: deferred Claude transcript entry still detects reply via error UUID", async () => {
  const { engine, protocol } = await loadCore();
  const baseMs = Date.parse("2026-11-26T15:00:00Z");
  const initialResetSec = Math.floor(Date.parse("2026-11-26T15:10:00Z") / 1000);
  const deferredResetSec = Math.floor(Date.parse("2026-11-26T16:00:00Z") / 1000);

  const errLine = JSON.stringify({
    type: "assistant",
    uuid: UUID_ERR,
    isApiErrorMessage: true,
    timestamp: "2026-11-26T14:59:00Z",
    quotaLimits: { resetsAt: initialResetSec, rateLimitType: "five_hour" },
  });
  // Intentionally omit timestamp on the reply so ONLY UUID-based hasAssistantReplySince detects it!
  const replyLine = JSON.stringify({
    type: "assistant",
    uuid: "f9999999-1111-4222-8333-444455556666",
    isApiErrorMessage: false,
  });

  let replied = false;
  const h = createHarness({
    nowMs: baseMs,
    terminals: [makeTerminal({ address: "t1", turn: 10 })],
    execHandler: async () => ({
      code: 0,
      stdout: replied ? `${errLine}\n${replyLine}` : errLine,
      stderr: "",
    }),
    hcHandler: async (args) => {
      if (args[0] === "get") {
        return { code: 0, stdout: JSON.stringify(makeFreshGet({ address: "t1", turn: 10 })), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  await eng.tick();
  assert.equal(eng.getState().queue[0].resetSource, "transcript");
  assert.equal(eng.getState().queue[0].errorFingerprint, UUID_ERR);

  // Defer via live usage-limits -> resetSource changes to "quota" while errorFingerprint remains UUID_ERR
  h.setNow(initialResetSec * 1000 + 60_000);
  h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
    claude: {
      report: {
        status: "ok",
        observedAt: Math.floor((initialResetSec * 1000 + 10_000) / 1000),
        windows: [{ id: "session", short: "5h", percent: 100, resetsAt: deferredResetSec }],
      },
    },
  };
  const stDeferred = await eng.tick();
  assert.equal(stDeferred.queue.length, 1);
  assert.equal(stDeferred.queue[0].resetSource, "quota");

  // Reply lands before deferred fire time; firing must still check UUID and skip with skipped-replied!
  replied = true;
  h.setNow(deferredResetSec * 1000 + 60_000);
  const stFired = await eng.tick();
  assert.equal(stFired.queue.length, 0);
  assert.equal(stFired.history[0].outcome, "skipped-replied");
  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
});

test("layouts: mount quota-resume-daemon only in layouts that also mount insights (glass, glass-insights)", () => {
  const collectModRefs = (node, out = new Set()) => {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((c) => collectModRefs(c, out));
      return out;
    }
    if (typeof node.mod === "string") out.add(node.mod);
    if (typeof node.id === "string" && node.id === "quota-resume-daemon") out.add("quota-resume-daemon");
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") collectModRefs(v, out);
    }
    return out;
  };

  for (const name of ["glass.json", "glass-insights.json"]) {
    const file = path.join(root, "layouts", name);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const mods = collectModRefs(data);
    assert.ok(mods.has("insights"), `${name}: must mount insights toggle UI`);
    let foundPair = false;
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.children)) {
        const idx = node.children.findIndex((c) => c?.id === "agent-resume-daemon");
        if (idx !== -1) {
          const next = node.children[idx + 1];
          assert.ok(next, `${name}: missing block after agent-resume-daemon`);
          assert.equal(next.id, "quota-resume-daemon", `${name}: next block id`);
          assert.equal(next.content?.mod, "quota-resume", `${name}: next block mod`);
          assert.deepEqual(next.size, { px: 0 }, `${name}: next block size`);
          foundPair = true;
        }
        node.children.forEach(visit);
      }
    };
    visit(data);
    assert.ok(foundPair, `${name}: did not find agent-resume-daemon + quota-resume-daemon pair`);
  }

  for (const name of ["omarchy.json", "omarchy-next.json"]) {
    const file = path.join(root, "layouts", name);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const mods = collectModRefs(data);
    assert.equal(mods.has("insights"), false, `${name}: does not mount insights`);
    assert.equal(
      mods.has("quota-resume") || mods.has("quota-resume-daemon"),
      false,
      `${name}: must not mount quota-resume-daemon without insights toggle UI`,
    );
  }
});

test("hardening A1/F1/F12: stale banner never loops, terminal-scoped, and allows legitimate later episodes", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  const codexTerm = (overrides = {}) =>
    makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
      ...overrides,
    });

  // Case 1: Superseded banner (user turn + reply below banner) -> 0 sends.
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm()],
      hcHandler: async (args) => {
        if (args[0] === "read") {
          assert.deepEqual(args.slice(2), ["--lines", "0"]);
          return { code: 0, stdout: "Error: usage_limit_reached. Try again in 4m.\n› continue\n• ok\n› ", stderr: "" };
        }
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    for (let i = 0; i < 5; i++) {
      await eng.tick();
      h.advance(5 * MIN + 1000);
      await eng.tick();
      h.setTerminals([codexTerm({ turn: 11 + i })]);
    }
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // Case 2: Un-superseded stale banner left on screen across turns within 2h -> at most 1 send total.
  {
    let currentTurn = 10;
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm({ turn: currentTurn })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 4m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm({ turn: currentTurn })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    for (let i = 0; i < 5; i++) {
      await eng.tick();
      h.advance(5 * MIN + 1000);
      await eng.tick();
      currentTurn = 11 + i;
      h.setTerminals([codexTerm({ turn: currentTurn })]);
    }
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
  }

  // Case 3 (F12): Same banner on second terminal t2 is still queued after t1 resumed.
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm({ address: "t1" })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 4m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm({ address: args[1] })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.advance(6 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    h.setTerminals([codexTerm({ address: "t1" }), codexTerm({ address: "t2" })]);
    h.advance(HOUR);
    await eng.tick();
    assert.equal(eng.getState().queue.some((q) => q.address === "t2"), true);
  }

  // Case 4 (#10): Second episode with identical banner text resumes on a new turn after >=2h.
  {
    const ocTerm = (overrides = {}) =>
      makeTerminal({
        address: "t1",
        program: { key: "opencode", name: "OpenCode", agent: true, shell: false },
        foreground: { pid: 300, name: "opencode" },
        report: { app: "opencode", state: "idle" },
        labels: {},
        argv: ["opencode"],
        ...overrides,
      });
    let currentTurn = 10;
    const h = createHarness({
      nowMs: T0,
      terminals: [ocTerm({ turn: currentTurn })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Rate limit exceeded. Try again in 10m.\n", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(ocTerm({ turn: currentTurn })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.advance(12 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);

    // 30h later on turn 40 with identical banner text -> MUST resume a second time!
    h.setNow(T0 + 30 * HOUR);
    currentTurn = 40;
    h.setTerminals([ocTerm({ turn: currentTurn })]);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);
    h.advance(12 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 2);
  }

  // Case 5 (#10): Claude screen "resets 3pm (UTC)" resumes Day 1 AND Day 2 on a new turn.
  {
    const claudeScreenTerm = (overrides = {}) =>
      makeTerminal({
        address: "t1",
        labels: {},
        ...overrides,
      });
    let currentTurn = 10;
    const h = createHarness({
      nowMs: Date.parse("2026-11-26T10:00:00Z"),
      terminals: [claudeScreenTerm({ turn: currentTurn })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "You've hit your limit · resets 3pm (UTC)\n\n❯ \n", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(claudeScreenTerm({ turn: currentTurn })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(Date.parse("2026-11-26T15:02:00Z"));
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);

    h.setNow(Date.parse("2026-11-27T10:00:00Z"));
    currentTurn = 40;
    h.setTerminals([claudeScreenTerm({ turn: currentTurn })]);
    await eng.tick();
    h.setNow(Date.parse("2026-11-27T15:02:00Z"));
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 2);
  }
});

test("hardening A2/F2 (#5): no promotion on 99% or mismatched low window; requires prior exhaustion and caps promotions at 1 per episode", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  // 1. 99% never promotes.
  {
    const reset = T0 + 5 * HOUR;
    const t = () => makeTerminal({ turn: 10 });
    const h = createHarness({
      nowMs: T0,
      terminals: [t()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(t()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const eng = engine.createEngine(h.env);
    for (let i = 0; i < 6; i++) {
      await eng.tick();
      h.advance(5 * MIN);
      h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
        claude: {
          report: {
            status: "ok",
            observedAt: Math.floor((T0 + (i + 1) * 5 * MIN) / 1000),
            windows: [{ id: "session", short: "5h", percent: 99, resetsAt: reset / 1000 }],
          },
        },
      };
      await eng.tick();
    }
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // 2. Mismatched window (20% with resetsAt +4h when transcript says +3h) NEVER promotes early; sends at +3h!
  {
    const reset = T0 + 3 * HOUR;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ turn: 10 })],
      sharedInit: {
        [protocol.USAGE_LIMITS_STATE_KEY]: {
          claude: {
            report: {
              status: "ok",
              observedAt: T0 / 1000,
              windows: [{ id: "session", short: "5h", percent: 20, resetsAt: (T0 + 4 * HOUR) / 1000 }],
            },
          },
        },
      },
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet({ turn: 10 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(T0 + 20 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY].claude.report.observedAt = (T0 + 20 * MIN) / 1000;
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "must NOT promote without prior exhaustion");

    h.setNow(reset + 2 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, "must send normally at real reset");
  }

  // 3. Genuine recovery after observed 100% on matching window promotes ONCE; second promotion on same episode is capped!
  {
    const reset = T0 + 3 * HOUR;
    const entry = {
      address: "t1",
      machine: null,
      provider: "claude",
      reason: "five_hour rate limit",
      detectedAtMs: T0,
      resetsAtMs: reset,
      status: "waiting",
      sawExhausted: false,
    };
    const exhaustedUsage = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 5 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 100, resetsAt: reset / 1000 }],
        },
      },
    };
    const obs = engine.evaluateQuotaForEntry(entry, exhaustedUsage, T0 + 5 * MIN, 60, []);
    assert.deepEqual(obs, { action: "observe-exhausted" });
    entry.sawExhausted = true;

    const recoveredUsage = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 15 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 35, resetsAt: reset / 1000 }],
        },
      },
    };
    const promo1 = engine.evaluateQuotaForEntry(entry, recoveredUsage, T0 + 15 * MIN, 60, []);
    assert.equal(promo1?.action, "promote");
    assert.ok(promo1?.promoKey);

    // Second attempt for the same (address, resetsAtMs) episode is blocked by promotedEpisodes cap!
    const promo2 = engine.evaluateQuotaForEntry(entry, recoveredUsage, T0 + 20 * MIN, 60, [promo1.promoKey]);
    assert.equal(promo2, null, "early promotion must be capped to 1 per episode");
  }
});

test("hardening A3/F3/F13/F14 (#2, nits): rejects prose & timeless fallback, detects prefixes/models, parses GMT/UTC offsets", async () => {
  const { engine, screen } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // F3 / #2: ordinary agent prose must NEVER trigger even if starting with error words
  const proseCases = [
    ["codex", "• Added retry handling for rate_limit_exceeded in client.ts.\n› "],
    ["opencode", "The upstream returned HTTP 429. Should I delete the cache table?\n> "],
    ["codex", "Rate limit exceeded is the error we now handle.\n› "],
    ["codex", "usage_limit_reached is returned by the API when the quota is exhausted.\n› "],
    ["opencode", "Rate limit exceeded errors are retried automatically.\n> "],
    ["codex", "Rate limit exceeded\nShould I retry now.\n› "],
  ];
  for (const [agent, text] of proseCases) {
    assert.equal(screen.detectScreenRateLimit({ agent, address: "t1", text, nowMs: T0 }), null, `prose: ${text}`);
    const term = makeTerminal({
      address: "t1",
      program: { key: agent, name: agent, agent: true, shell: false },
      foreground: { pid: 200, name: agent },
      report: { app: agent, state: "idle" },
      labels: {},
      argv: [agent],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [term],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: text, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, `must not queue prose: ${text}`);
    h.advance(7 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, `must not send for prose: ${text}`);
  }

  // #2: Timeless banners without usage-limits corroboration MUST NOT schedule via fallback!
  for (const [agent, text] of [
    ["opencode", "Too many requests\n> \n"],
    ["opencode", "Rate limit exceeded. Please try again later.\n"],
    ["codex", "Error: usage_limit_reached\n› "],
  ]) {
    const term = makeTerminal({
      address: "t1",
      program: { key: agent, name: agent, agent: true, shell: false },
      foreground: { pid: 200, name: agent },
      report: { app: agent, state: "idle" },
      labels: {},
      argv: [agent],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [term],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: text, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, `timeless must not queue without quota: ${text}`);
    h.advance(7 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // F13 + nits: Claude 5-hour / weekly / session / Opus / Sonnet / Haiku / ⎿ prefix & Codex ■ prefix
  for (const text of [
    "You've hit your 5-hour limit · resets 3:20pm (America/Argentina/Buenos_Aires)",
    "You've hit your weekly limit · resets 7pm (UTC)",
    "You've hit your session limit · resets 7pm (UTC)",
    "You've hit your Opus limit · resets 7pm (UTC)",
    "You've hit your Sonnet limit · resets 7pm (UTC)",
    "You've hit your Haiku limit · resets 7pm (UTC)",
    "  ⎿  You've hit your limit · resets 3:20pm (UTC)",
    "You've hit your limit",
  ]) {
    assert.ok(screen.detectScreenRateLimit({ agent: "claude", address: "t1", text, nowMs: T0 }), text);
  }
  assert.ok(
    screen.detectScreenRateLimit({
      agent: "codex",
      address: "t1",
      text: "■ You've hit your usage limit. Try again in 10m.\n› ",
      nowMs: T0,
    }),
  );

  // F14 + nit: unparenthesized UTC, GMT-3, UTC+2 offsets parse accurately
  assert.equal(new Date(screen.parseResetTime("resets at 19:00 UTC", T0)).toISOString(), "2026-11-26T19:00:00.000Z");
  assert.equal(new Date(screen.parseResetTime("resets at 19:00 (UTC)", T0)).toISOString(), "2026-11-26T19:00:00.000Z");
  assert.equal(new Date(screen.parseResetTime("resets 7pm UTC", T0)).toISOString(), "2026-11-26T19:00:00.000Z");
  assert.equal(new Date(screen.parseResetTime("resets 7pm GMT-3", T0)).toISOString(), "2026-11-26T22:00:00.000Z");
  assert.equal(new Date(screen.parseResetTime("try again at 19:00 UTC+2", T0)).toISOString(), "2026-11-26T17:00:00.000Z");
});

test("hardening A4/F4 (#3): strict wrapper executable/script position check (rejects trailing data args, eval, non-exec mise)", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // Reject non-agent processes and trailing data arguments masquerading as agents
  assert.equal(engine.identifyForegroundAgent({ name: "nvim" }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "ssh", argv: ["ssh", "host"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "python3", argv: ["python3", "claude.py"] }), null);
  assert.equal(engine.identifyForegroundAgent(undefined), null);
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "/tmp/tool.js", "/tmp/codex/input.json"] }),
    null,
    "node trailing data arg must NOT match codex",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "-e", "console.log('codex')"] }),
    null,
    "node -e must be rejected",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "--print", "claude"] }),
    null,
    "node --print must be rejected",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "build.js"] }),
    null,
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "env", argv: ["env", "-u", "FOO", "/tmp/tool.js", "codex"] }),
    null,
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "npx", argv: ["npx", "-y", "some-other-tool", "codex"] }),
    null,
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "mise", argv: ["mise", "run", "codex"] }),
    null,
  );

  // Accept legitimate wrapper forms at executable/script position
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"] }),
    "claude",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "-r", "dotenv/config", "--max-old-space-size", "4096", "/x/claude-code/cli.js", "--resume"] }),
    "claude",
  );
  assert.equal(engine.identifyForegroundAgent({ name: "bun", argv: ["bun", "opencode"] }), "opencode");
  assert.equal(engine.identifyForegroundAgent({ name: "deno", argv: ["deno", "run", "--allow-all", "/x/codex/cli.js"] }), "codex");
  assert.equal(
    engine.identifyForegroundAgent({ name: "env", argv: ["env", "-i", "-C", "/app", "FOO=1", "node", "/x/claude-code/cli.js"] }),
    "claude",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "npx", argv: ["npx", "-y", "@openai/codex@latest", "--model", "o3"] }),
    "codex",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "mise", argv: ["mise", "exec", "node@22", "--", "claude"] }),
    "claude",
  );
  assert.equal(
    engine.identifyForegroundAgent({ name: "mise", argv: ["mise", "x", "--", "node", "/x/codex/bin.js"] }),
    "codex",
  );

  for (const fg of [
    { name: "nvim" },
    { name: "ssh" },
    { name: "psql" },
    { name: "python3" },
    { name: "node", argv: ["node", "/tmp/tool.js", "/tmp/codex/input.json"] },
    undefined,
  ]) {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: (T0 + 10 * MIN) / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          return {
            code: 0,
            stdout: JSON.stringify({
              state: "live",
              turn: 10,
              foreground: fg,
              status: { app: "claude-code", state: "idle" },
              labels: { "claude.session": UUID_1 },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(T0 + 11 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, `fg=${JSON.stringify(fg)}`);
    assert.equal(st.history[0].outcome, "skipped-session", `fg=${JSON.stringify(fg)}`);
  }
});

test("hardening A5/F5 (#1): detects verb-first, boxed multi-line, and OpenCode drafts; exempts only exact placeholders", async () => {
  const { engine, screen } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // Real drafts MUST return true (including verb-first, boxed multi-line, OpenCode ┃)
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 4m.\n› please also drop the old tab"), true);
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 1m.\n› Fix the production database"), true);
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 1m.\n› Write a migration."), true);
  assert.equal(screen.hasUnsentDraft("banner\n> Fix the failing test in foo.ts\n"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ > half │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ > line1 │\n│   line2 │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ >  │\n│   line2 │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n┃  my half typed text\n┃  Build  Claude"), true);
  assert.equal(screen.hasUnsentDraft("Rate limit exceeded. Try again in 10m.\n\n┃  please also drop the old tab\n"), true);

  // Empty prompts & exact known placeholders MUST return false
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 4m.\n› "), false);
  assert.equal(screen.hasUnsentDraft('You\'ve hit your limit\n❯ Try "refactor utils.ts"\n? for shortcuts'), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Ask Codex to do anything"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Use /skills to list available skills"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Summarize recent commits"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Implement {feature}\n  100% context left"), false);
  assert.equal(screen.hasUnsentDraft("banner\n┃  Ask anything...\n┃  Build  Claude"), false);
  assert.equal(screen.hasUnsentDraft('banner\n┃  Ask anything... "Fix broken tests"\n┃  Build  Claude'), false);
  assert.equal(screen.hasUnsentDraft("banner\n┃  \n┃  Build  Claude"), false);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts"), false);

  // End-to-end: queued while prompt empty, then user types verb-first draft before deadline -> skipped-replied, 0 sends!
  for (const draftScreen of [
    "Error: usage_limit_reached. Try again in 1m.\n› Fix the production database",
    "Error: usage_limit_reached. Try again in 1m.\n› Write a migration.",
    "Error: usage_limit_reached. Try again in 1m.\n╭────╮\n│ > line1 │\n│   line2 │\n╰────╯\n  ? for shortcuts",
    "Error: usage_limit_reached. Try again in 1m.\n┃  my half typed text\n┃  Build  Claude",
  ]) {
    let screenText = "Error: usage_limit_reached. Try again in 1m.\n› ";
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: screenText, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    screenText = draftScreen;
    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.history[0].outcome, "skipped-replied");
    assert.match(st.history[0].detail, /draft/i);
  }
});

test("hardening A6/F6/F10 (#4, #6, #12): replaced banner defers, atomic --if idle only, 5 transient gets recover", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const reset = T0 + 10 * MIN;

  // F6: terminal turns working during transcript re-read which throws -> must NOT send!
  {
    let live = "idle";
    let due = false;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => {
        if (due) {
          live = "working";
          throw new Error("timeout");
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "assistant",
            uuid: UUID_ERR,
            isApiErrorMessage: true,
            timestamp: new Date(T0).toISOString(),
            quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
          }),
          stderr: "",
        };
      },
      hcHandler: async (args) => {
        if (args[0] === "get") {
          due = true;
          return { code: 0, stdout: JSON.stringify(makeFreshGet({ status: { app: "claude-code", state: live } })), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(reset + MIN);
    await eng.tick();
    assert.equal(live, "working");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // #6: `done` and `error` terminals are queued, defer without burning attempts until `idle`, then send with `--if idle`!
  {
    let liveStatus = "done";
    let statusPublishedBeforeSend = null;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ status: "done", report: { app: "claude-code", state: "done" } })],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          return { code: 0, stdout: JSON.stringify(makeFreshGet({ status: { app: "claude-code", state: liveStatus } })), stderr: "" };
        }
        if (args[0] === "send") {
          statusPublishedBeforeSend = h.sharedStore[protocol.STATE_KEY]?.queue?.[0]?.status ?? null;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, "done terminal is still queued for visibility");

    // Due while still `done` -> defers without sending unconditionally or burning attempts!
    h.setNow(reset + MIN);
    let st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.queue.length, 1);
    assert.equal(st.queue[0].attempts, 0);

    // Due while `error` -> also defers!
    liveStatus = "error";
    h.advance(35_000);
    st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.queue.length, 1);
    assert.equal(st.queue[0].attempts, 0);

    // Once terminal reports `idle` -> fires atomically with `--if idle`!
    liveStatus = "idle";
    h.advance(35_000);
    st = await eng.tick();
    assert.equal(statusPublishedBeforeSend, "resuming");
    assert.equal(st.history[0].outcome, "resumed");
    const sendCall = h.hcCalls.find((a) => a[0] === "send");
    assert.deepEqual(sendCall, ["send", "--if", "idle", "t1", protocol.DEFAULT_PROMPT]);
  }

  // #6: `status_mismatch` from `hc send --if idle` records `skipped-busy` (not `failed`, no error notification)
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        if (args[0] === "send") return { code: 1, stdout: "", stderr: "error: status_mismatch (terminal is working)" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(reset + MIN);
    const st = await eng.tick();
    assert.equal(st.history[0].outcome, "skipped-busy");
    assert.equal(h.notifyCalls.length, 0);
  }

  // #4: Replaced banner (`Try again in 1m.` -> `Try again in 5h.`) defers to 5h instead of firing at 1m!
  {
    let screenText = "Error: usage_limit_reached. Try again in 1m.\n› ";
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: screenText, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // Replace banner with 5h wait while keeping turn unchanged!
    screenText = "Error: usage_limit_reached. Try again in 5h.\n› ";
    h.setNow(T0 + 2 * MIN + 1000);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "must NOT send at old 1m deadline");
    assert.equal(st.queue.length, 1);
    assert.ok(st.queue[0].resetsAtMs >= T0 + 5 * HOUR, "must defer resetsAtMs to 5h deadline");

    // At the new 5h deadline, it sends once!
    h.setNow(st.queue[0].resumeAtMs + 1000);
    const st2 = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    assert.equal(st2.history[0].outcome, "resumed");
  }

  // #12 / F10: Five transient `hc get` failures drop entry AND clear lastInspected so recovery re-inspects unchanged terminal!
  {
    let getFail = true;
    const codexTerm = makeTerminal({
      address: "linux/t1",
      turn: 10,
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") {
          if (getFail) return { code: 1, stdout: "", stderr: "unreachable" };
          return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // 4 transient failures -> stays queued
    for (let i = 0; i < 4; i++) {
      h.advance(3 * MIN);
      const st = await eng.tick();
      assert.equal(st.queue.length, 1);
      assert.equal(st.queue[0].getFailures, i + 1);
    }

    // 5th transient failure -> dropped as skipped-closed with remember: false & lastInspected cleared
    h.advance(3 * MIN);
    const st5 = await eng.tick();
    assert.equal(st5.queue.length, 0);
    assert.equal(st5.history[0].outcome, "skipped-closed");

    // Remote host recovers with UNCHANGED turn/status signature -> re-inspected, re-queued, and resumed!
    getFail = false;
    h.advance(15_000);
    const stRec = await eng.tick();
    assert.equal(stRec.queue.length, 1, "unchanged terminal must be re-inspected after 5 transient get failures");
    h.advance(3 * MIN);
    const stSent = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    assert.equal(stSent.history[0].outcome, "resumed");
  }
});

test("hardening A7/F7/A8/F8/F9/F11/F15 (#11, #13): persisted cancel, default disabled, Claude screen fallback, weekly expiry", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // F7: cancel persists across engine reload
  {
    const reset = T0 + 10 * MIN;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
    });
    let eng = engine.createEngine(h.env);
    await eng.tick();
    await eng.processCommand({ version: 1, id: "c1", action: "cancel", address: "t1" });
    eng = engine.createEngine(h.env);
    h.advance(15_000);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0);
    h.setNow(reset + MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // F8: fresh default is enabled: false and performs zero sends
  {
    const h = createHarness({
      nowMs: T0,
      enabled: null,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: (T0 + 10 * MIN) / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
    });
    const eng = engine.createEngine(h.env);
    assert.equal(eng.getState().enabled, false);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0);
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // F9: failed screen read does not cache lastInspected, so next tick retries and queues
  {
    let reads = 0;
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") {
          return reads++ === 0
            ? { code: 1, stdout: "", stderr: "transient" }
            : { code: 0, stdout: "Error: usage_limit_reached. Try again in 4m.\n› ", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0);
    h.advance(15_000);
    await eng.tick();
    assert.equal(reads, 2);
    assert.equal(eng.getState().queue.length, 1);
  }

  // #11: Claude with session label, transcript code 3 (missing), screen banner -> queues AND resumes cleanly!
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ labels: { "claude.session": UUID_1 } })],
      execHandler: async () => ({ code: 3, stdout: "", stderr: "" }),
      hcHandler: async (args) => {
        if (args[0] === "read") {
          return { code: 0, stdout: "You've hit your 5-hour limit · resets in 1m.\n❯ \n", stderr: "" };
        }
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);
    assert.equal(eng.getState().queue[0].resetSource, "screen");
    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(st.history[0].outcome, "resumed");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
  }

  // F11: OpenCode banner mentioning anthropic resolves provider "claude" and defers when Claude is at 100%
  {
    const ocTerm = makeTerminal({
      address: "t1",
      program: { key: "opencode", name: "OpenCode", agent: true, shell: false },
      foreground: { pid: 300, name: "opencode" },
      report: { app: "opencode", state: "idle" },
      labels: {},
      argv: ["opencode"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [ocTerm],
      sharedInit: {
        [protocol.USAGE_LIMITS_STATE_KEY]: {
          claude: {
            report: {
              status: "ok",
              observedAt: T0 / 1000 + 120,
              windows: [{ id: "session", percent: 100, resetsAt: (T0 + 3 * HOUR) / 1000 }],
            },
          },
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "read") {
          return { code: 0, stdout: "Error: rate limit exceeded (anthropic). Try again in 1m.\n> ", stderr: "" };
        }
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(ocTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue[0].provider, "claude");
    h.advance(3 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // F15: disabled for 72h past a 10-minute reset -> stale entry expires and sends 0
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: (T0 + 10 * MIN) / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    await eng.processCommand({ version: 1, id: "c1", action: "toggle-enabled", enabled: false });
    h.advance(72 * HOUR);
    await eng.processCommand({ version: 1, id: "c2", action: "toggle-enabled", enabled: true });
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // #13: Weekly limit 3 days ahead does NOT expire at 24h + 1ms, fires cleanly at 3 days + 1m!
  {
    const weeklyReset = T0 + 3 * DAY;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: weeklyReset / 1000, rateLimitType: "seven_day" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // 24h + 1ms later: MUST still be queued (not prematurely expired!)
    h.setNow(T0 + DAY + 1);
    const stMid = await eng.tick();
    assert.equal(stMid.queue.length, 1, "3-day weekly limit must NOT expire at 24h");
    assert.equal(stMid.history.length, 0);

    // At 3 days + 2m: fires cleanly!
    h.setNow(weeklyReset + 2 * MIN);
    const stEnd = await eng.tick();
    assert.equal(stEnd.history[0].outcome, "resumed");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
  }
});

test("hardening: immediate cancel & disable during stagger/fire, missing turn fail-closed, and disabled vs expired resume-now", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const reset = T0 + 5 * MIN;

  // 1a. Immediate sync cancel during stagger sleep aborts second send
  // 1b. Immediate sync toggle-enabled=false during stagger sleep aborts second send
  for (const mode of ["cancel", "toggle-enabled"]) {
    const t1 = makeTerminal({ address: "t1", labels: { "claude.session": UUID_1 }, turn: 1 });
    const t2 = makeTerminal({ address: "t2", labels: { "claude.session": UUID_2 }, turn: 2 });
    let eng;
    const h = createHarness({
      nowMs: T0,
      terminals: [t1, t2],
      execHandler: async (_cmd, args) => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: args[3] === UUID_1 ? UUID_ERR : UUID_ERR_2,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          const isT1 = args[1] === "t1";
          return {
            code: 0,
            stdout: JSON.stringify(
              makeFreshGet({
                address: args[1],
                turn: isT1 ? 1 : 2,
                labels: { "claude.session": isT1 ? UUID_1 : UUID_2 },
              }),
            ),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(reset + MIN);
    await eng.tick({
      sleep: async () => {
        if (mode === "cancel") {
          eng.applySyncCommand({ version: 1, id: "cancel-mid-stagger", action: "cancel", address: "t2" });
        } else {
          eng.applySyncCommand({ version: 1, id: "disable-mid-stagger", action: "toggle-enabled", enabled: false });
        }
      },
    });
    const sends = h.hcCalls.filter((a) => a[0] === "send");
    assert.equal(sends.length, 1, `mode=${mode}`);
    assert.equal(sends[0][3], "t1", `mode=${mode}`);
  }

  // 2. Missing `turn` on `hc get` fails closed (skipped-replied, sends: 0)
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ turn: 10 })],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          const fresh = makeFreshGet();
          delete fresh.turn;
          return { code: 0, stdout: JSON.stringify(fresh), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(reset + MIN);
    const st = await eng.tick();
    assert.equal(st.history[0].outcome, "skipped-replied");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // 3a. `resume-now` refuses when disabled (unexpired entry) and ignores persisted prompt override
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      sharedInit: {
        [protocol.STATE_KEY]: {
          version: 1,
          enabled: false,
          settings: { prompt: "INJECTED PROMPT", delaySec: 60, agents: { claude: true, codex: true, opencode: true } },
          queue: [
            {
              address: "t1",
              agent: "claude",
              provider: "claude",
              sessionId: UUID_1,
              transcriptUuid: UUID_ERR,
              detectedAtMs: T0,
              resetsAtMs: reset,
              resumeAtMs: reset + MIN,
              resetSource: "transcript",
              reason: "five_hour rate limit",
              errorTurn: 10,
              errorFingerprint: UUID_ERR,
              status: "waiting",
            },
          ],
          history: [],
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    assert.equal(eng.getState().settings.prompt, protocol.DEFAULT_PROMPT);
    await eng.processCommand({ version: 1, id: "rn-1", action: "resume-now", address: "t1" });
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // 3b. `resume-now` while ENABLED rejects genuinely EXPIRED entry (>2h past resetsAtMs) with outcome "cancelled"!
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // Advance >2h past resetsAtMs while daemon stays enabled -> resume-now MUST cancel as expired!
    h.setNow(reset + 3 * HOUR);
    await eng.processCommand({ version: 1, id: "rn-expired", action: "resume-now", address: "t1" });
    assert.equal(eng.getState().queue.length, 0);
    assert.equal(eng.getState().history[0].outcome, "cancelled");
    assert.match(eng.getState().history[0].detail, /Expired/i);
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }
});

test("hardening (#14): bounds outstanding hung host calls (<=1 across 25 ticks), uses 75s send timeout, no bare setTimeout", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const reset = T0 + 5 * MIN;

  // 1. 25 ticks with hung `hc read` produce AT MOST 1 pending host call (not 25!), then recovers once settled!
  {
    let readCount = 0;
    let releaseRead = null;
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const fakeAfter = (ms, fn) => {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) fn();
      });
      return () => {
        cancelled = true;
      };
    };
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") {
          readCount += 1;
          if (readCount === 1) {
            return new Promise((resolve) => {
              releaseRead = () => resolve({ code: 0, stdout: "", stderr: "" });
            });
          }
          return { code: 0, stdout: "Error: usage_limit_reached. Try again in 2m.\n› ", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    for (let i = 0; i < 25; i++) {
      h.advance(15_000);
      await eng.tick({ after: fakeAfter });
    }
    assert.equal(readCount, 1, "25 ticks with hung screen read must launch at most 1 pending host call");

    // Once the hung call finally settles, the next tick can issue a fresh read and detect the banner!
    releaseRead();
    await new Promise((r) => setImmediate(r));
    h.advance(15_000);
    const st = await eng.tick({ after: () => () => {} });
    assert.equal(readCount, 2);
    assert.equal(st.queue.length, 1);
  }

  // 2. Verify `hc send` uses HC_SEND_TIMEOUT_MS (75_000) while `hc get`/`read` use HC_TIMEOUT_MS (10_000)
  //    and every scheduled timeout is cancelled in finally!
  {
    const scheduled = [];
    let cancelledCount = 0;
    const neverFireAfter = (ms, fn) => {
      const entry = { ms, fn, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
        cancelledCount += 1;
      };
    };
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal()],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick({ after: neverFireAfter });
    h.setNow(reset + MIN);
    const st = await eng.tick({ after: neverFireAfter });
    assert.equal(st.history[0].outcome, "resumed");
    assert.equal(engine.HC_SEND_TIMEOUT_MS, 75_000);
    assert.ok(scheduled.some((s) => s.ms === engine.HC_TIMEOUT_MS), "get/read use HC_TIMEOUT_MS");
    assert.ok(scheduled.some((s) => s.ms === engine.HC_SEND_TIMEOUT_MS), "send uses HC_SEND_TIMEOUT_MS (75s)");
    assert.equal(cancelledCount, scheduled.length, "every scheduled timeout must be cancelled in finally");
  }

  // 3. Static check: no bare setTimeout/clearTimeout/setInterval/clearInterval in mods/quota-resume/.
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(?:m?js|cjs)$/.test(ent.name)) files.push(full);
    }
  };
  walk(modDir);
  assert.ok(files.length >= 5);
  const bareTimerRe = /(?<![.\w$])(?:setTimeout|clearTimeout|setInterval|clearInterval)\b/;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    assert.equal(bareTimerRe.test(src), false, `${rel} must not contain bare setTimeout/setInterval calls`);
  }
});

test("hardening (#7): multi-instance concurrent engines send at most once via exclusive claim", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const reset = T0 + 10 * MIN;

  const sharedStore = { [protocol.STATE_KEY]: { version: 1, enabled: true } };
  const sends = [];
  let clock = T0;
  const term = makeTerminal({
    address: "t1",
    program: { key: "codex", name: "Codex", agent: true, shell: false },
    foreground: { pid: 200, name: "codex" },
    report: { app: "codex", state: "idle" },
    labels: {},
    argv: ["codex"],
  });

  // Intentionally give each engine its OWN env wrapper closures over the SAME shared store!
  const makeEnv = () => ({
    now: () => clock,
    terminals: () => [term],
    panes: () => [],
    spaces: () => [],
    shared: (k) => sharedStore[k],
    setShared: (k, v) => {
      sharedStore[k] = v;
    },
    hc: async (args) => {
      // Yield a microtask so both engines interleave realistically
      await Promise.resolve();
      if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 10m.\n› ", stderr: "" };
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
      if (args[0] === "send") {
        sends.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    exec: async () => ({ code: 3, stdout: "", stderr: "" }),
    notify: () => {},
    sleep: async () => {},
    log: () => {},
  });

  const engA = engine.createEngine(makeEnv());
  const engB = engine.createEngine(makeEnv());

  await Promise.all([engA.tick(), engB.tick()]);
  clock = reset + 2 * MIN;
  await Promise.all([engA.tick(), engB.tick()]);

  assert.equal(sends.length, 1, "two concurrent engines sharing a store must send at most once");
});

test("hardening (#8): restored state re-verifies live evidence (forged transcriptUuid on Codex & Claude send 0)", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // Case 1: Restored Codex entry with `transcriptUuid: "invented"` & dangerous screen prompt -> 0 sends!
  {
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      sharedInit: {
        [protocol.STATE_KEY]: {
          version: 1,
          enabled: true,
          queue: [
            {
              address: "t1",
              agent: "codex",
              provider: "codex",
              transcriptUuid: "invented",
              detectedAtMs: T0 - 5 * MIN,
              resetsAtMs: T0 - MIN,
              resumeAtMs: T0 - 1000,
              resetSource: "transcript",
              reason: "usage_limit_reached",
              errorTurn: 10,
              errorFingerprint: "forged-fp",
              status: "waiting",
            },
          ],
          history: [],
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        if (args[0] === "read") return { code: 0, stdout: "Should I delete the database?\n› ", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const eng = engine.createEngine(h.env);
    // normalizeQueueEntry must have stripped transcriptUuid and resetSource !== "transcript"
    assert.equal(eng.getState().queue[0].transcriptUuid, null);
    assert.notEqual(eng.getState().queue[0].resetSource, "transcript");

    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.history[0].outcome, "skipped-replied");
  }

  // Case 2: Restored Claude entry with forged valid UUID not in transcript -> verifyActiveTranscriptError rejects, 0 sends!
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ turn: 10 })],
      sharedInit: {
        [protocol.STATE_KEY]: {
          version: 1,
          enabled: true,
          queue: [
            {
              address: "t1",
              agent: "claude",
              provider: "claude",
              sessionId: UUID_1,
              transcriptUuid: UUID_ERR_2, // valid UUID, but NOT in transcript!
              detectedAtMs: T0 - 5 * MIN,
              resetsAtMs: T0 - MIN,
              resumeAtMs: T0 - 1000,
              resetSource: "transcript",
              reason: "five_hour rate limit",
              errorTurn: 10,
              errorFingerprint: UUID_ERR_2,
              status: "waiting",
            },
          ],
          history: [],
        },
      },
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR, // different UUID, and not an error!
          isApiErrorMessage: false,
          timestamp: new Date(T0 - 6 * MIN).toISOString(),
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet({ turn: 10 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.history[0].outcome, "skipped-replied");
  }
});

test("hardening (#9): cancel during in-flight inspection discards resulting banner and does not re-queue until signature changes", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  let releaseRead = null;
  const codexTerm = (overrides = {}) =>
    makeTerminal({
      address: "t1",
      turn: 10,
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
      ...overrides,
    });

  let readCalls = 0;
  const h = createHarness({
    nowMs: T0,
    terminals: [codexTerm()],
    hcHandler: async (args) => {
      if (args[0] === "read") {
        readCalls += 1;
        if (readCalls === 1) {
          return new Promise((resolve) => {
            releaseRead = () =>
              resolve({ code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" });
          });
        }
        return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
      }
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm()), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const eng = engine.createEngine(h.env);
  const tickPromise = eng.tick();
  // Wait a microtask so screen read is pending in flight
  await Promise.resolve();
  assert.ok(releaseRead, "first screen read should be in flight");

  // Issue cancel while first inspection is pending!
  eng.applySyncCommand({ version: 1, id: "cancel-in-flight", action: "cancel", address: "t1" });
  releaseRead();
  await tickPromise;

  assert.equal(eng.getState().queue.length, 0, "in-flight detection must be discarded after cancel");

  // Subsequent ticks with same signature (even after engine reload) must NOT re-queue or send!
  const engReloaded = engine.createEngine(h.env);
  h.advance(3 * MIN);
  await engReloaded.tick();
  assert.equal(engReloaded.getState().queue.length, 0);
  assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
});

test("hardening (#7, #16): main.js lifecycle — close() mid-tick aborts with 0 sends & 0 writes; render() dispatches sync commands", async () => {
  const QuotaResume = await loadMainMod();
  const { protocol } = await loadCore();

  // 1. Block a due tick inside `hc read`, call `close()`, then release the read -> 0 sends, 0 writes after close!
  let releaseRead = null;
  let writesAfterClose = 0;
  let closedCalled = false;
  let timerCancelled = false;
  const sends = [];
  const store = {
    [protocol.STATE_KEY]: {
      version: 1,
      enabled: true,
      queue: [
        {
          address: "t1",
          agent: "codex",
          provider: "codex",
          detectedAtMs: Date.now() - 120_000,
          resetsAtMs: Date.now() - 60_000,
          resumeAtMs: Date.now() - 1000,
          resetSource: "screen",
          reason: "usage_limit_reached",
          errorTurn: 10,
          errorFingerprint: "screen:t1:codex:codex-usage-limit-reached:abcd",
          status: "waiting",
        },
      ],
      history: [],
    },
  };
  const codexTerm = makeTerminal({
    address: "t1",
    turn: 10,
    program: { key: "codex", name: "Codex", agent: true, shell: false },
    foreground: { pid: 200, name: "codex" },
    report: { app: "codex", state: "idle" },
    labels: {},
    argv: ["codex"],
  });

  globalThis[HERDR_STUB_SYM] = {
    terminals: () => [codexTerm],
    panes: () => [],
    spaces: () => [],
    shared: (k) => store[k],
    setShared: (k, v) => {
      if (closedCalled) writesAfterClose += 1;
      store[k] = v;
    },
    hc: async (args) => {
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
      if (args[0] === "read") {
        return new Promise((resolve) => {
          releaseRead = () =>
            resolve({ code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" });
        });
      }
      if (args[0] === "send") {
        sends.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    exec: async () => ({ code: 3, stdout: "", stderr: "" }),
    notify: () => {},
    checking: () => false,
  };

  const spawnedTasks = [];
  const fakeCx = {
    timer: {
      every: () => ({
        cancel: () => {
          timerCancelled = true;
        },
      }),
      after: () => ({ cancel: () => {} }),
    },
    sleep: async () => {},
    spawn: (fn) => {
      const p = fn(fakeCx);
      spawnedTasks.push(p);
      return p;
    },
  };

  const view = new QuotaResume();
  view.init({}, fakeCx);

  // Wait until the initial tick reaches the blocked `hc read`
  for (let i = 0; i < 10 && !releaseRead; i++) {
    await Promise.resolve();
  }
  assert.ok(releaseRead, "main.js tick should be blocked inside hc read");

  // Also test render() sync command dispatch before closing
  store[protocol.COMMAND_KEY] = { version: 1, id: "sync-clear-1", action: "clear-history", atMs: Date.now() };
  view.render(fakeCx);
  assert.equal(view.engine.getState().lastHandledCommandId, "sync-clear-1");

  // Close the view while tick is in flight, then release the blocked read!
  closedCalled = true;
  view.close();
  assert.equal(timerCancelled, true);
  assert.equal(view.engine.isClosed(), true);

  releaseRead();
  await Promise.all(spawnedTasks);

  assert.equal(sends.length, 0, "close() mid-tick must produce 0 sends");
  assert.equal(writesAfterClose, 0, "close() mid-tick must produce 0 setShared writes");
});
