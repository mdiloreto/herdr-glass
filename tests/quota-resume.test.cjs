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

  // Case 2: Un-superseded stale banner left on screen across turns within 10m cooldown -> at most 1 send total.
  {
    let currentTurn = 10;
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm({ turn: currentTurn, status_ms: 1000 })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 2m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm({ turn: currentTurn, status_ms: 1000 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.advance(3 * MIN + 1000);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);

    // Rapid turn bumps within 10m cooldown must NOT re-queue or re-send.
    for (let i = 0; i < 4; i++) {
      currentTurn = 11 + i;
      h.setTerminals([codexTerm({ turn: currentTurn, status_ms: 1000 + i + 1 })]);
      h.advance(2 * MIN);
      await eng.tick();
    }
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
  }

  // Case 2b (#9): Overnight dateless Claude banner ("resets 4pm (UTC)") with only turn 10->11 must NOT roll forward next day.
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
      terminals: [claudeScreenTerm({ turn: currentTurn, status_ms: 1000 })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "You've hit your limit · resets 4pm (UTC)\n\n❯ \n", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(claudeScreenTerm({ turn: currentTurn, status_ms: 1000 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(Date.parse("2026-11-26T16:02:00Z"));
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);

    // Next day with only turn incremented by 1 (10 -> 11) -> suppressed (0 extra sends)!
    h.setNow(Date.parse("2026-11-27T10:00:00Z"));
    currentTurn = 11;
    h.setTerminals([claudeScreenTerm({ turn: currentTurn, status_ms: 1000 })]);
    await eng.tick();
    h.setNow(Date.parse("2026-11-27T16:02:00Z"));
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, "overnight stale 4pm banner must not re-fire");
  }

  // Case 2c (#9): Upgrade migration — legacy screen fingerprint in handledFingerprints suppresses same-turn replay.
  {
    const { screen, protocol } = await loadCore();
    const banner = "Error: usage_limit_reached. Try again in 4m.\n› ";
    const det = screen.detectScreenRateLimit({ agent: "codex", address: "t1", text: banner, nowMs: T0 });
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm({ turn: 10 })],
      sharedInit: {
        [protocol.STATE_KEY]: {
          version: 1,
          enabled: true,
          handledFingerprints: [det.fingerprint],
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: banner, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm({ turn: 10 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, "legacy handledFingerprint must suppress same-turn replay");
    h.advance(6 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
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

  // Case 4 (#14): Second episode within 2h (18m and 30m later) on new turn & updated status_ms resumes cleanly!
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
    let currentStatusMs = 1;
    let screenText = "Rate limit exceeded. Try again in 10m.\n\n┃  Ask anything...\n";
    const h = createHarness({
      nowMs: T0,
      terminals: [ocTerm({ turn: currentTurn, status_ms: currentStatusMs })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: screenText, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(ocTerm({ turn: currentTurn, status_ms: currentStatusMs })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.advance(12 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);

    // 18m later on turn 30 with updated status_ms after work resumed and hit limit again -> MUST resume a 2nd time!
    screenText = "Working...\n";
    currentTurn = 20;
    currentStatusMs = 3;
    h.setNow(T0 + 20 * MIN);
    h.setTerminals([ocTerm({ turn: currentTurn, status_ms: currentStatusMs })]);
    await eng.tick();

    screenText = "Rate limit exceeded. Try again in 10m.\n\n┃  Ask anything...\n";
    h.setNow(T0 + 30 * MIN);
    currentTurn = 30;
    currentStatusMs = 5;
    h.setTerminals([ocTerm({ turn: currentTurn, status_ms: currentStatusMs })]);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, "second episode 18m later on new turn must queue");
    h.advance(12 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 2);

    // Real second Codex hit on turn 11 at +30m with updated status_ms -> ALSO resumes!
    let cTurn = 10;
    let cStatusMs = 1;
    const h2 = createHarness({
      nowMs: T0,
      terminals: [codexTerm({ turn: cTurn, status_ms: cStatusMs })],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "You've hit your usage limit. Try again in 10m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm({ turn: cTurn, status_ms: cStatusMs })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng2 = engine.createEngine(h2.env);
    await eng2.tick();
    h2.advance(12 * MIN);
    await eng2.tick();
    assert.equal(h2.hcCalls.filter((a) => a[0] === "send").length, 1);

    h2.setNow(T0 + 30 * MIN);
    cTurn = 11;
    cStatusMs = 2000;
    h2.setTerminals([codexTerm({ turn: cTurn, status_ms: cStatusMs })]);
    await eng2.tick();
    assert.equal(eng2.getState().queue.length, 1, "second Codex hit on turn 11 at +30m with updated status_ms must queue");
    h2.advance(12 * MIN);
    await eng2.tick();
    assert.equal(h2.hcCalls.filter((a) => a[0] === "send").length, 2);
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

  // 2. (#5) Observe 100% on matching +3h window at +10m, then 20% on DIFFERENT +4h window at +20m
  //    AND stale 20% on +3h at +5m -> NEITHER promotes early; sends at real +3h reset!
  {
    const reset = T0 + 3 * HOUR;
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
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet({ turn: 10 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // Step 2a: Observe 100% on the matching +3h window at +10m -> sets sawExhausted & exhaustedObservedAtMs
    h.setNow(T0 + 10 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 10 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 100, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(eng.getState().queue[0].sawExhausted, true);
    assert.equal(eng.getState().queue[0].exhaustedObservedAtMs, T0 + 10 * MIN);
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);

    // Step 2b: Observe 20% on DIFFERENT window (+4h) at +20m -> MUST NOT promote!
    h.setNow(T0 + 20 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 20 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 20, resetsAt: (T0 + 4 * HOUR) / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "mismatched +4h window must NOT promote +3h entry");

    // Step 2c: Stale observation (observedAt +5m < exhaustedObservedAtMs +10m) on +3h at 20% -> MUST NOT promote!
    h.setNow(T0 + 25 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 5 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 20, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "stale observation older than exhaustedObservedAtMs must NOT promote");

    // Step 2d: At the real +3h reset, it fires normally!
    h.setNow(reset + 2 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, "must send normally at real reset");
  }

  // 3. (#5) Promotion cap driven end-to-end through engine.tick() (no manual promotedEpisodes injection)!
  {
    const reset = T0 + 3 * HOUR;
    let failGet = true;
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
          if (failGet) return { code: 1, stdout: "", stderr: "transient" };
          return { code: 0, stdout: JSON.stringify(makeFreshGet({ turn: 10 })), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // Observe 100% at +5m
    h.setNow(T0 + 5 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 5 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 100, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(eng.getState().queue[0].sawExhausted, true);

    // First promotion through engine.tick() at +15m (hc get fails transiently so we can trigger drop & re-queue)
    h.setNow(T0 + 15 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: (T0 + 15 * MIN) / 1000,
          windows: [{ id: "session", short: "5h", percent: 35, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(eng.getState().promotedEpisodes.length, 1, "first promotion must be persisted by engine");

    // Exhaust transient get failures so entry is dropped with remember: false, then re-queued on next tick
    for (let i = 1; i < engine.MAX_GET_FAILURES; i++) {
      h.advance(35_000);
      await eng.tick();
    }
    assert.equal(eng.getState().queue.length, 0);

    // Recover hc get; terminal re-queues for the SAME (address, resetsAtMs) episode
    failGet = false;
    h.advance(15_000);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: Math.floor(h.env.now() / 1000),
          windows: [{ id: "session", short: "5h", percent: 100, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);
    assert.equal(eng.getState().queue[0].sawExhausted, true);

    // Drop to 20% again on the same episode -> MUST NOT promote a second time (persisted promotedEpisodes cap)!
    h.advance(10 * MIN);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      claude: {
        report: {
          status: "ok",
          observedAt: Math.floor(h.env.now() / 1000),
          windows: [{ id: "session", short: "5h", percent: 20, resetsAt: reset / 1000 }],
        },
      },
    };
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "second early promotion for same episode must be capped");
    assert.equal(eng.getState().queue[0].earlyPromoted, false);
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

  // Real drafts MUST return true (including verb-first, Claude Try "...", OpenCode single-spaced Build, 6+ indented lines, boxed multi-line)
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 4m.\n› please also drop the old tab"), true);
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 1m.\n› Fix the production database"), true);
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 1m.\n› Write a migration."), true);
  assert.equal(screen.hasUnsentDraft('You\'ve hit your limit\n❯ Try "delete the old database"\n? for shortcuts'), true);
  assert.equal(screen.hasUnsentDraft('You\'ve hit your limit\n❯ Try "refactor utils.ts"\n? for shortcuts'), true);
  assert.equal(screen.hasUnsentDraft("banner\n> Fix the failing test in foo.ts\n"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ > half │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ > line1 │\n│   line2 │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ >  │\n│   line2 │\n╰────╯\n  ? for shortcuts"), true);
  assert.equal(screen.hasUnsentDraft("banner\n┃  my half typed text\n┃  Build  Claude"), true);
  assert.equal(screen.hasUnsentDraft("banner\n┃  Build the production migration\n┃  Build  Claude"), true);
  assert.equal(screen.hasUnsentDraft("Rate limit exceeded. Try again in 10m.\n\n┃  please also drop the old tab\n"), true);
  // 6+ indented continuation lines below Claude prompt MUST be caught as draft (#1)
  assert.equal(
    screen.hasUnsentDraft(
      [
        "You've hit your limit",
        "❯ first line",
        "  cont 1",
        "  cont 2",
        "  cont 3",
        "  cont 4",
        "  cont 5",
        "  cont 6",
        "  cont 7",
        "? for shortcuts",
      ].join("\n"),
    ),
    true,
  );

  // Empty prompts & exact known placeholders MUST return false (#12: all real Codex placeholders)
  assert.equal(screen.hasUnsentDraft("Error: usage_limit_reached. Try again in 4m.\n› "), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Ask Codex to do anything"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Use /skills to list available skills"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Summarize recent commits"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Implement {feature}\n  100% context left"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Explain this codebase"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Find and fix a bug in @filename"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Write tests for @filename"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Improve documentation in @filename"), false);
  assert.equal(screen.hasUnsentDraft("banner\n› Run /review on my current changes"), false);
  assert.equal(screen.hasUnsentDraft("banner\n┃  Ask anything...\n┃  Build  Claude"), false);
  assert.equal(screen.hasUnsentDraft('banner\n┃  Ask anything... "Fix broken tests"\n┃  Build  Claude'), false);
  assert.equal(screen.hasUnsentDraft("banner\n┃  \n┃  Build  Claude"), false);
  assert.equal(screen.hasUnsentDraft("banner\n╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts"), false);

  // End-to-end: queued while prompt empty, then user types draft on the MATCHING agent terminal -> skipped-replied, 0 sends!
  const agentDraftCases = [
    { agent: "codex", initial: "Error: usage_limit_reached. Try again in 1m.\n› ", draft: "Error: usage_limit_reached. Try again in 1m.\n› Fix the production database" },
    { agent: "codex", initial: "Error: usage_limit_reached. Try again in 1m.\n› ", draft: "Error: usage_limit_reached. Try again in 1m.\n› Write a migration." },
    { agent: "claude", initial: "You've hit your limit · resets in 1m.\n❯ ", draft: 'You\'ve hit your limit · resets in 1m.\n❯ Try "delete the old database"\n? for shortcuts' },
    {
      agent: "claude",
      initial: "You've hit your limit · resets in 1m.\n❯ ",
      draft: "You've hit your limit · resets in 1m.\n❯ draft line\n  c1\n  c2\n  c3\n  c4\n  c5\n  c6\n? for shortcuts",
    },
    { agent: "claude", initial: "You've hit your limit · resets in 1m.\n❯ ", draft: "You've hit your limit · resets in 1m.\n╭────╮\n│ > line1 │\n│   line2 │\n╰────╯\n  ? for shortcuts" },
    { agent: "opencode", initial: "Rate limit exceeded. Try again in 1m.\n┃  \n┃  Build  Claude", draft: "Rate limit exceeded. Try again in 1m.\n┃  my half typed text\n┃  Build  Claude" },
    { agent: "opencode", initial: "Rate limit exceeded. Try again in 1m.\n┃  \n┃  Build  Claude", draft: "Rate limit exceeded. Try again in 1m.\n┃  Build the production migration\n┃  Build  Claude" },
  ];
  for (const tc of agentDraftCases) {
    let screenText = tc.initial;
    const term = makeTerminal({
      address: "t1",
      program: { key: tc.agent, name: tc.agent, agent: true, shell: false },
      foreground: { pid: 200, name: tc.agent },
      report: { app: tc.agent, state: "idle" },
      labels: {},
      argv: [tc.agent],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [term],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: screenText, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, `should queue initial ${tc.agent}`);

    screenText = tc.draft;
    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, `must not send into ${tc.agent} draft`);
    assert.equal(st.history[0].outcome, "skipped-replied");
    assert.match(st.history[0].detail, /draft/i);
  }

  // End-to-end (#12): All 5 previously-unlisted Codex placeholders queue and resume cleanly!
  for (const ph of [
    "Explain this codebase",
    "Find and fix a bug in @filename",
    "Write tests for @filename",
    "Improve documentation in @filename",
    "Run /review on my current changes",
  ]) {
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
        if (args[0] === "read") return { code: 0, stdout: `You've hit your usage limit. Try again in 10m.\n\n› ${ph}\n`, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, `Codex placeholder must queue: ${ph}`);
    h.advance(12 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, `Codex placeholder must resume: ${ph}`);
    assert.equal(st.history[0].outcome, "resumed");
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

  // #13: `idle` uses `--if idle`; permanent `done` and `error` fire after immediate `finalGet` (never passing `--force`);
  //      `working` and `blocked` are skipped!
  for (const [status, expectedArgs] of [
    ["idle", ["send", "--if", "idle", "t1", protocol.DEFAULT_PROMPT]],
    ["done", ["send", "t1", protocol.DEFAULT_PROMPT]],
    ["error", ["send", "t1", protocol.DEFAULT_PROMPT]],
  ]) {
    let statusPublishedBeforeSend = null;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ status, report: { app: "claude-code", state: status } })],
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
          return { code: 0, stdout: JSON.stringify(makeFreshGet({ status: { app: "claude-code", state: status } })), stderr: "" };
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
    assert.equal(eng.getState().queue.length, 1, `${status} terminal must queue`);

    h.setNow(reset + MIN);
    const st = await eng.tick();
    assert.equal(statusPublishedBeforeSend, "resuming", `${status}: must publish resuming before send`);
    assert.equal(st.history[0].outcome, "resumed", `${status}: must resume`);
    const sendCall = h.hcCalls.find((a) => a[0] === "send");
    assert.deepEqual(sendCall, expectedArgs, `${status}: exact send args`);
    assert.equal(sendCall.includes("--force"), false, `${status}: must never pass --force`);
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

  // #19 / F10: Transient `hc get` failures survive 5+ outages (MAX_GET_FAILURES=12), drop after MAX_GET_FAILURES
  //            and clear lastInspected so unchanged terminal re-inspects cleanly; preGet success does NOT reset getFailures!
  {
    let getFail = true;
    const reset1m = T0 + MIN;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ address: "linux/t1", turn: 10 })],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: reset1m / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          if (getFail) return { code: 1, stdout: "", stderr: "unreachable" };
          return { code: 0, stdout: JSON.stringify(makeFreshGet({ address: "linux/t1", turn: 10 })), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    // 5 transient failures after +1m reset -> STILL queued (not lost at 5!)
    h.setNow(reset1m + MIN + 1000);
    for (let i = 0; i < 5; i++) {
      const st = await eng.tick();
      assert.equal(st.queue.length, 1);
      assert.equal(st.queue[0].getFailures, i + 1);
      h.advance(35_000);
    }

    // Host recovers on tick 6 -> +1m Claude transcript entry STILL fires cleanly!
    getFail = false;
    const stSent = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    assert.equal(stSent.history[0].outcome, "resumed");
  }

  // #19: preGet succeeds while finalGet fails repeatedly -> getFailures increments past 1 and eventually drops!
  {
    let getCalls = 0;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ address: "linux/t2", turn: 10 })],
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR_2,
          isApiErrorMessage: true,
          timestamp: new Date(T0).toISOString(),
          quotaLimits: { resetsAt: (T0 + MIN) / 1000, rateLimitType: "five_hour" },
        }),
        stderr: "",
      }),
      hcHandler: async (args) => {
        if (args[0] === "get") {
          getCalls += 1;
          // Odd calls are preGet (succeed), even calls are finalGet (fail)!
          if (getCalls % 2 === 1) {
            return { code: 0, stdout: JSON.stringify(makeFreshGet({ address: "linux/t2", turn: 10 })), stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "final get transient fail" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(T0 + 2 * MIN + 1000);
    for (let i = 0; i < engine.MAX_GET_FAILURES - 1; i++) {
      const st = await eng.tick();
      assert.equal(st.queue.length, 1);
      assert.equal(st.queue[0].getFailures, i + 1, "preGet success must NOT reset getFailures");
      h.advance(35_000);
    }
    const stDrop = await eng.tick();
    assert.equal(stDrop.queue.length, 0);
    assert.equal(stDrop.history[0].outcome, "skipped-closed");
  }

  // #19: Claude screen-fallback (code 3 at detection, then 5x code 1 at due time, then code 3) stays queued and resumes!
  {
    let execCode = 3;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ labels: { "claude.session": UUID_1 } })],
      execHandler: async () => ({ code: execCode, stdout: "", stderr: "" }),
      hcHandler: async (args) => {
        if (args[0] === "read") {
          return { code: 0, stdout: "You've hit your 5-hour limit · resets 3:10pm (UTC)\n❯ \n", stderr: "" };
        }
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet()), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);
    assert.equal(eng.getState().queue[0].resetSource, "screen");

    // 5 transient exit-1 transcript failures at due time must NOT drop the valid screen entry!
    execCode = 1;
    h.setNow(Date.parse("2026-11-26T15:11:01Z"));
    for (let i = 0; i < 5; i++) {
      const st = await eng.tick();
      assert.equal(st.queue.length, 1);
      assert.equal(st.queue[0].transcriptFailures, i + 1);
      h.advance(35_000);
    }

    // Transcript returns code 3 again -> resumes cleanly!
    execCode = 3;
    const stResumed = await eng.tick();
    assert.equal(stResumed.history[0].outcome, "resumed");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
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

test("hardening (#15): hung host calls evict after TTL, cap globally at 32 across 220 addrs, close() settles wait, 75s send timeout", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const reset = T0 + 5 * MIN;

  // 1a. Within eviction window, repeated ticks launch at most 1 hung call; after TTL / p4.mjs P7 hang clears -> recovers & queues!
  {
    let hang = true;
    let readCount = 0;
    const codexTerm = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    const fastTimeoutAfter = (_ms, fn) => {
      const t = setTimeout(fn, 1);
      return () => clearTimeout(t);
    };
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") {
          readCount += 1;
          if (hang) return new Promise(() => {}); // NEVER settles!
          return { code: 0, stdout: "You've hit your usage limit. Try again in 10m.\n› \n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    // 3 ticks while hung (clock fixed like p4.mjs P7): launches only 1 hung read!
    for (let i = 0; i < 3; i++) {
      await eng.tick({ after: fastTimeoutAfter });
    }
    assert.equal(readCount, 1, "must not launch duplicate hung reads within eviction window");

    // Hang clears (first promise still never settled!) -> next ticks evict stale hung op and queue!
    hang = false;
    for (let i = 0; i < 3; i++) {
      await eng.tick({ after: fastTimeoutAfter });
    }
    assert.equal(eng.getState().queue.length, 1, "p4.mjs P7: hung read must evict so terminal recovers");
  }

  // 1b. Global cap (MAX_GLOBAL_IN_FLIGHT = 32): rotating through 220 broken addresses never spawns >32 pending host calls!
  {
    let totalReads = 0;
    const immediateTimeoutAfter = (_ms, fn) => {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) fn();
      });
      return () => {
        cancelled = true;
      };
    };
    const brokenTerms = Array.from({ length: 220 }, (_, i) =>
      makeTerminal({
        address: `broken-${i}`,
        program: { key: "codex", name: "Codex", agent: true, shell: false },
        foreground: { pid: 200 + i, name: "codex" },
        report: { app: "codex", state: "idle" },
        labels: {},
        argv: ["codex"],
      }),
    );
    const h = createHarness({
      nowMs: T0,
      terminals: brokenTerms,
      hcHandler: async (args) => {
        if (args[0] === "read") {
          totalReads += 1;
          return new Promise(() => {}); // never settles
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick({ after: immediateTimeoutAfter });
    assert.equal(totalReads, engine.MAX_GLOBAL_IN_FLIGHT, "220 broken addresses must be capped at MAX_GLOBAL_IN_FLIGHT (32)");
    assert.equal(engine.MAX_GLOBAL_IN_FLIGHT, 32);
  }

  // 1c. close() immediately settles any pending wait promise on a hung host call!
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
      hcHandler: async (args) => {
        if (args[0] === "read") return new Promise(() => {}); // never settles
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    const tickPromise = eng.tick({ after: () => () => {} });
    await Promise.resolve();
    eng.close();
    // Must settle immediately without hanging!
    const settled = await Promise.race([
      tickPromise.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("hung"), 200)),
    ]);
    assert.equal(settled, "settled", "close() must immediately settle pending hung host call waits");
  }

  // 1d. `hc send` timing out after HC_SEND_TIMEOUT_MS records uncertain timeout failure and never retries!
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
        if (args[0] === "send") return new Promise(() => {}); // hangs past 75s deadline
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick({ after: () => () => {} });
    h.setNow(reset + MIN);
    const st = await eng.tick({
      after: (ms, fn) => {
        if (ms === engine.HC_SEND_TIMEOUT_MS) {
          let cancelled = false;
          queueMicrotask(() => {
            if (!cancelled) fn();
          });
          return () => {
            cancelled = true;
          };
        }
        return () => {};
      },
    });
    assert.equal(st.history[0].outcome, "failed");
    assert.equal(st.history[0].detail, "hc send timed out (delivery uncertain; not retrying)");
    assert.equal(st.queue.length, 0);
    assert.equal(h.notifyCalls.length, 1);
    assert.equal(h.notifyCalls[0].title, "Resume timed out for Claude Code");
    assert.equal(h.notifyCalls[0].level, "warning");
    // Subsequent tick must NOT retry because episode attempt & cooldown are recorded!
    h.advance(MIN);
    await eng.tick({ after: () => () => {} });
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
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

test("hardening (#6): concurrent engines across minute boundary & stale clear-history writer send at most once", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  const term = makeTerminal({
    address: "t1",
    program: { key: "codex", name: "Codex", agent: true, shell: false },
    foreground: { pid: 200, name: "codex" },
    report: { app: "codex", state: "idle" },
    labels: {},
    argv: ["codex"],
  });

  // Case 1 (p5.mjs & Codex #6): Two engines reading the same relative banner across a minute boundary
  // (15:00:59 vs 15:01:00, and 15:00:30 vs 15:01:10) contend on address-keyed claim and send at most ONCE!
  for (const [c1Init, c2Init, banner] of [
    [T0 + 59_000, T0 + 60_000, "You've hit your usage limit. Try again in 1m.\n› "],
    [T0 + 30_000, T0 + 70_000, "You've hit your usage limit. Try again in 10m.\n› "],
  ]) {
    const sharedStore = { [protocol.STATE_KEY]: { version: 1, enabled: true } };
    const sends = [];
    let c1 = c1Init;
    let c2 = c2Init;
    let releaseA = null;
    let resolveStarted = null;
    const startedPromise = new Promise((r) => {
      resolveStarted = r;
    });
    const makeEnv = (getNow, holdFirstSend) => ({
      now: getNow,
      terminals: () => [term],
      panes: () => [],
      spaces: () => [],
      shared: (k) => sharedStore[k],
      setShared: (k, v) => {
        sharedStore[k] = v;
      },
      hc: async (args) => {
        await Promise.resolve();
        if (args[0] === "read") return { code: 0, stdout: banner, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        if (args[0] === "send") {
          sends.push(args);
          if (holdFirstSend && !releaseA) {
            await new Promise((r) => {
              releaseA = r;
              resolveStarted();
            });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async () => ({ code: 3, stdout: "", stderr: "" }),
      notify: () => {},
      sleep: async () => {},
      log: () => {},
    });

    const engA = engine.createEngine(makeEnv(() => c1, true));
    const engB = engine.createEngine(makeEnv(() => c2, false));
    await engA.tick();
    await engB.tick();

    c1 = T0 + 13 * MIN;
    c2 = c1 + 40_000;
    const pA = engA.tick();
    const pB = engB.tick();
    await Promise.race([startedPromise, Promise.all([pA, pB])]);
    if (releaseA) releaseA();
    await Promise.all([pA, pB]);

    assert.equal(sends.length, 1, "two engines across minute boundary must send at most once");
  }

  // Case 2 (Codex #6 stale writer): Engine B runs `clear-history` while Engine A holds an active claim & pending send.
  // Engine B's full-state write MUST preserve Engine A's claim and Engine B MUST NOT double-send!
  {
    const sharedStore = { [protocol.STATE_KEY]: { version: 1, enabled: true } };
    const sends = [];
    let clock = T0;
    let releaseA = null;
    let resolveStarted = null;
    const startedPromise = new Promise((r) => {
      resolveStarted = r;
    });
    const makeEnv = (holdSend) => ({
      now: () => clock,
      terminals: () => [term],
      panes: () => [],
      spaces: () => [],
      shared: (k) => sharedStore[k],
      setShared: (k, v) => {
        sharedStore[k] = v;
      },
      hc: async (args) => {
        await Promise.resolve();
        if (args[0] === "read") return { code: 0, stdout: "You've hit your usage limit. Try again in 10m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        if (args[0] === "send") {
          sends.push(args);
          if (holdSend) {
            await new Promise((r) => {
              releaseA = r;
              resolveStarted();
            });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async () => ({ code: 3, stdout: "", stderr: "" }),
      notify: () => {},
      sleep: async () => {},
      log: () => {},
    });

    const engA = engine.createEngine(makeEnv(true));
    const engB = engine.createEngine(makeEnv(false));
    await engA.tick();
    await engB.tick();

    clock = T0 + 12 * MIN;
    const pA = engA.tick();
    await startedPromise;
    assert.ok(releaseA, "Engine A should hold active claim with send pending");

    // Stale writer Engine B executes clear-history while A's send is still pending!
    engB.applySyncCommand({ version: 1, id: "stale-clear-1", action: "clear-history", atMs: clock });
    assert.ok(sharedStore[protocol.STATE_KEY].claims?.t1, "clear-history on Engine B must NOT erase Engine A's claim");

    await engB.tick();
    releaseA();
    await pA;

    assert.equal(sends.length, 1, "stale clear-history writer must NOT allow Engine B to double-send");
    // After Engine A released its claim, Engine B publishing must NOT resurrect A's released claim!
    assert.equal(sharedStore[protocol.STATE_KEY].claims?.t1, undefined, "Engine A should release its claim after send");
    engB.applySyncCommand({ version: 1, id: "stale-clear-2", action: "clear-history", atMs: clock + 1000 });
    assert.equal(sharedStore[protocol.STATE_KEY].claims?.t1, undefined, "Engine B must NOT resurrect Engine A's released claim");
  }

  // Case 3: Lost claim readback copies external owner into local state.claims so duplicate local queue entry is dropped!
  {
    const sharedStore = { [protocol.STATE_KEY]: { version: 1, enabled: true } };
    let clock = T0;
    const h = createHarness({
      nowMs: T0,
      terminals: [term],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "You've hit your usage limit. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const origSetShared = h.env.setShared;
    h.env.setShared = (k, v) => {
      if (k === protocol.STATE_KEY && v?.queue?.[0]?.status === "resuming") {
        // Simulate another engine winning the claim race in shared state!
        origSetShared(k, { ...v, claims: { t1: { owner: "other-winner", atMs: h.env.now() } } });
        return;
      }
      origSetShared(k, v);
    };
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(T0 + 3 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(st.queue.length, 0, "lost claim to active external owner must drop duplicate local queue entry");
    assert.equal(st.claims?.t1?.owner, "other-winner");
    void sharedStore;
    void clock;
  }
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

test("hardening (#7, #16): main.js lifecycle — close() mid-tick aborts a real due send (control sends 1, close sends 0 & writes 0)", async () => {
  const QuotaResume = await loadMainMod();
  const { protocol, screen } = await loadCore();

  const bannerText = "Error: usage_limit_reached. Try again in 1m.\n› ";
  const runScenario = async (shouldClose) => {
    const baseNow = Date.now();
    const detected = screen.detectScreenRateLimit({
      agent: "codex",
      address: "t1",
      text: bannerText,
      nowMs: baseNow - 180_000,
    });
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
            detectedAtMs: baseNow - 180_000,
            resetsAtMs: baseNow - 120_000,
            resumeAtMs: baseNow - 60_000,
            resetSource: "screen",
            reason: detected.reason,
            errorTurn: 10,
            errorFingerprint: detected.fingerprint,
            matchedLine: detected.matchedLine,
            matchedSnippet: detected.normalizedSnippet,
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
            releaseRead = () => resolve({ code: 0, stdout: bannerText, stderr: "" });
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

    for (let i = 0; i < 10 && !releaseRead; i++) {
      await Promise.resolve();
    }
    assert.ok(releaseRead, "main.js tick should be blocked inside hc read");

    // Test render() sync command dispatch
    store[protocol.COMMAND_KEY] = { version: 1, id: `sync-clear-${shouldClose}`, action: "clear-history", atMs: Date.now() };
    view.render(fakeCx);
    assert.equal(view.engine.getState().lastHandledCommandId, `sync-clear-${shouldClose}`);

    if (shouldClose) {
      closedCalled = true;
      view.close();
      assert.equal(timerCancelled, true);
      assert.equal(view.engine.isClosed(), true);
    }

    releaseRead();
    await Promise.all(spawnedTasks);
    if (!shouldClose) view.close();
    return { sends, writesAfterClose };
  };

  // Control run WITHOUT close() MUST send 1 (proving the fixture truly sends when not closed!)
  const control = await runScenario(false);
  assert.equal(control.sends.length, 1, "control run without close() must send 1");

  // Run WITH close() mid-tick MUST produce 0 sends and 0 writes after close!
  const closed = await runScenario(true);
  assert.equal(closed.sends.length, 0, "close() mid-tick must produce 0 sends");
  assert.equal(closed.writesAfterClose, 0, "close() mid-tick must produce 0 setShared writes");
});


test("followups (#2, #11, #17): rejects prose with retry time & quoted logs, accepts all 3 valid timed banners, parses GMT-0330", async () => {
  const { engine, screen } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // #2: Prose with retry time & quoted/logged output MUST be rejected (0 queued, 0 sends)
  const rejectCases = [
    ["codex", "Rate limit exceeded. Try again in 1m if the request fails.\n› "],
    ["codex", "Here is the log I saw:\n  Rate limit exceeded. Try again in 10m.\n\n› \n"],
    ["opencode", "Here is the log I saw:\nRate limit exceeded. Try again in 10m.\n\n› \n"],
  ];
  for (const [agent, text] of rejectCases) {
    assert.equal(screen.detectScreenRateLimit({ agent, address: "t1", text, nowMs: T0 }), null, `reject: ${text}`);
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
    assert.equal(eng.getState().queue.length, 0);
    h.advance(12 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // #17: All three valid timed banners MUST queue and send once!
  const validTimedCases = [
    {
      name: "Claude (transcript exit 3 + Cooked chrome)",
      agent: "claude",
      labels: { "claude.session": UUID_1 },
      text: "You've hit your 5-hour limit · resets in 1m.\n✻ Cooked for 12s\n❯ ",
    },
    {
      name: "Codex (contact your admin)",
      agent: "codex",
      labels: {},
      text: "You've hit your usage limit. To get more access, contact your admin or try again in 1m.\n› ",
    },
    {
      name: "OpenCode (provider throttled + empty bar composer)",
      agent: "opencode",
      labels: {},
      text: "429 Too Many Requests: provider throttled this request. Retry after 1m.\n┃  \n┃  Build  Claude",
    },
  ];
  for (const tc of validTimedCases) {
    const term = makeTerminal({
      address: "t1",
      program: { key: tc.agent, name: tc.agent, agent: true, shell: false },
      foreground: { pid: 200, name: tc.agent },
      report: { app: tc.agent, state: "idle" },
      labels: tc.labels,
      argv: [tc.agent],
    });
    const h = createHarness({
      nowMs: T0,
      terminals: [term],
      execHandler: async () => ({ code: 3, stdout: "", stderr: "" }),
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: tc.text, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(term), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, `${tc.name}: must queue`);
    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, `${tc.name}: must send once`);
    assert.equal(st.history[0].outcome, "resumed", tc.name);
  }

  // #11: Offset timezone GMT-0330 & bare numeric -0330 parse as 22:30:00.000Z (not 22:00:00.000Z)
  assert.equal(
    new Date(screen.parseResetTime("resets at 19:00 GMT-0330", T0)).toISOString(),
    "2026-11-26T22:30:00.000Z",
  );
  assert.equal(
    new Date(screen.parseResetTime("resets at 19:00 (GMT-0330)", T0)).toISOString(),
    "2026-11-26T22:30:00.000Z",
  );
  assert.equal(
    new Date(screen.parseResetTime("resets at 19:00 -0330", T0)).toISOString(),
    "2026-11-26T22:30:00.000Z",
  );
  assert.equal(
    new Date(screen.parseResetTime("Nov 26 at 19:00 GMT-0330", T0)).toISOString(),
    "2026-11-26T22:30:00.000Z",
  );
});

test("followups (#3): rejects non-entrypoint scripts in codex folder, attached -e/-p eval flags, and npx -c/--call", async () => {
  const { engine } = await loadCore();

  assert.equal(engine.identifyForegroundAgent({ name: "node", argv: ["node", "/tmp/codex/report.js"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "node", argv: ["node", "-econsole.log(1)", "codex"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "node", argv: ["node", "-p1+1", "claude"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "bun", argv: ["bun", "-eprocess.exit(0)", "opencode"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "npx", argv: ["npx", "-c", "codex"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "npx", argv: ["npx", "--call", "codex"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "npx", argv: ["npx", "--call=codex", "codex"] }), null);
  assert.equal(engine.identifyForegroundAgent({ name: "node", argv: ["node", "/x/claude-code/cli.js"] }), "claude");
  assert.equal(
    engine.identifyForegroundAgent({ name: "node", argv: ["node", "/usr/lib/node_modules/@openai/codex/dist/anything.js"] }),
    "codex",
  );
});

test("followups (#4): ignores ISO timestamp above replacement banner & defers to newer Claude transcript error B", async () => {
  const { engine, screen } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  // 4a. Neighboring ISO timestamp ABOVE replacement banner MUST NOT win parseResetTime!
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

    screenText = "Last request logged 2026-11-26T15:01:00Z\nError: usage_limit_reached. Try again in 5h.\n› ";
    const det = screen.detectScreenRateLimit({ agent: "codex", address: "t1", text: screenText, nowMs: T0 + 2 * MIN });
    assert.equal(det.resetsAtMs, T0 + 2 * MIN + 5 * HOUR, "line above banner must be ignored");

    h.setNow(T0 + 2 * MIN + 1000);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "must NOT send at old 1m deadline");
    assert.equal(st.queue.length, 1);
    assert.ok(st.queue[0].resetsAtMs >= T0 + 5 * HOUR);
  }

  // 4b. Claude newer quota error B (+5h) appended after A (+1m) on same turn -> updates to B & defers!
  {
    const errA = JSON.stringify({
      type: "assistant",
      uuid: UUID_ERR,
      isApiErrorMessage: true,
      timestamp: new Date(T0).toISOString(),
      quotaLimits: { resetsAt: (T0 + MIN) / 1000, rateLimitType: "five_hour" },
    });
    const errB = JSON.stringify({
      type: "assistant",
      uuid: UUID_ERR_2,
      isApiErrorMessage: true,
      timestamp: new Date(T0 + 30_000).toISOString(),
      quotaLimits: { resetsAt: (T0 + 5 * HOUR) / 1000, rateLimitType: "seven_day" },
    });
    let appendedB = false;
    const h = createHarness({
      nowMs: T0,
      terminals: [makeTerminal({ turn: 10 })],
      execHandler: async () => ({ code: 0, stdout: appendedB ? `${errA}\n${errB}` : errA, stderr: "" }),
      hcHandler: async (args) => {
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(makeFreshGet({ turn: 10 })), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue[0].transcriptUuid, UUID_ERR);

    appendedB = true;
    h.setNow(T0 + 3 * MIN);
    const stMid = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "must NOT send at error A's +1m deadline");
    assert.equal(stMid.queue.length, 1);
    assert.equal(stMid.queue[0].transcriptUuid, UUID_ERR_2);
    assert.equal(stMid.queue[0].resetsAtMs, T0 + 5 * HOUR);

    h.setNow(T0 + 5 * HOUR + 2 * MIN);
    const stEnd = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    assert.equal(stEnd.history[0].outcome, "resumed");
  }
});

test("followups (#7): forged stored reset on genuine Claude/Codex evidence defers; cleared report.msg skips", async () => {
  const { engine, protocol, screen } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  // 7a. Claude restored entry with genuine live UUID + forged stored reset now-1m (live transcript says now+3h) -> defers, 0 sends!
  {
    const liveReset = T0 + 3 * HOUR;
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
              transcriptUuid: UUID_ERR,
              detectedAtMs: T0 - 5 * MIN,
              resetsAtMs: T0 - MIN, // FORGED past reset
              resumeAtMs: T0 - 1000,
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
      execHandler: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "assistant",
          uuid: UUID_ERR,
          isApiErrorMessage: true,
          timestamp: new Date(T0 - 5 * MIN).toISOString(),
          quotaLimits: { resetsAt: liveReset / 1000, rateLimitType: "five_hour" },
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
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "forged reset must NOT send early");
    assert.equal(st.queue.length, 1);
    assert.equal(st.queue[0].resetsAtMs, liveReset);
  }

  // 7b. Restored Codex entry with genuine fingerprint + resetsAtMs=now+1m, resumeAtMs=now -> clamped, 0 immediate sends!
  {
    const banner = "Error: usage_limit_reached. Try again in 1m.\n› ";
    const det = screen.detectScreenRateLimit({ agent: "codex", address: "t1", text: banner, nowMs: T0 });
    const codexTerm = makeTerminal({
      address: "t1",
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
      sharedInit: {
        [protocol.STATE_KEY]: {
          version: 1,
          enabled: true,
          queue: [
            {
              address: "t1",
              agent: "codex",
              provider: "codex",
              detectedAtMs: T0,
              resetsAtMs: T0 + MIN,
              resumeAtMs: T0, // FORGED early resumeAtMs
              resetSource: "screen",
              reason: det.reason,
              errorTurn: 10,
              errorFingerprint: det.fingerprint,
              matchedLine: det.matchedLine,
              matchedSnippet: det.normalizedSnippet,
              status: "waiting",
            },
          ],
          history: [],
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: banner, stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    assert.equal(eng.getState().queue[0].resumeAtMs, T0 + 2 * MIN, "normalizeQueueEntry must clamp resumeAtMs");
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // 7c. Banner seen ONLY in preliminary `report.msg`, cleared by `finalGet` -> skipped-replied, 0 sends!
  {
    let getCalls = 0;
    const codexTermWithMsg = makeTerminal({
      address: "t1",
      turn: 10,
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle", msg: "You've hit your usage limit. Try again in 1m." },
      labels: {},
      argv: ["codex"],
    });
    const codexTermCleared = { ...codexTermWithMsg, report: { app: "codex", state: "idle", msg: null } };
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTermWithMsg],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Normal output\n› ", stderr: "" };
        if (args[0] === "get") {
          getCalls += 1;
          return {
            code: 0,
            stdout: JSON.stringify(getCalls === 1 ? codexTermWithMsg : codexTermCleared),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);

    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0, "cleared report.msg on finalGet must not send");
    assert.equal(st.history[0].outcome, "skipped-replied");
  }
});

test("followups (#8, #10): cancel survives 100+ evictions on other addrs; missing detection-time turn fetches or fails closed", async () => {
  const { engine } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;

  // #8: Hold first read for t1, cancel t1, issue 100+ cancels on other addresses -> t1 STILL cancelled!
  {
    let releaseRead = null;
    const codexTerm = makeTerminal({
      address: "t1",
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
        if (args[0] === "read") {
          return new Promise((resolve) => {
            releaseRead = () =>
              resolve({ code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" });
          });
        }
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    const p = eng.tick();
    await Promise.resolve();
    assert.ok(releaseRead);

    eng.applySyncCommand({ version: 1, id: "cancel-t1", action: "cancel", address: "t1" });
    for (let i = 0; i < 110; i++) {
      eng.applySyncCommand({ version: 1, id: `cancel-other-${i}`, action: "cancel", address: `other-${i}` });
    }
    releaseRead();
    await p;

    assert.equal(eng.getState().queue.length, 0, "t1 must stay cancelled even after 110 cancels on other addresses");
    h.advance(3 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // #10a: `terminals()` omits `turn`, `hc get` returns `turn: 99` -> captures errorTurn: 99 and detects later turn change!
  {
    let liveTurn = 99;
    const termNoTurn = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    delete termNoTurn.turn;

    const h = createHarness({
      nowMs: T0,
      terminals: [termNoTurn],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ ...termNoTurn, turn: liveTurn }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1);
    assert.equal(eng.getState().queue[0].errorTurn, 99, "must fetch authoritative detection-time turn");

    liveTurn = 100;
    h.advance(3 * MIN);
    const st = await eng.tick();
    assert.equal(st.history[0].outcome, "skipped-replied");
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
  }

  // #10b: Both `terminals()` and `hc get` omit `turn` -> fails closed, 0 queued, 0 sends!
  {
    const termNoTurn = makeTerminal({
      address: "t1",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
      foreground: { pid: 200, name: "codex" },
      report: { app: "codex", state: "idle" },
      labels: {},
      argv: ["codex"],
    });
    delete termNoTurn.turn;
    const h = createHarness({
      nowMs: T0,
      terminals: [termNoTurn],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(termNoTurn), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, "must fail closed when turn is unavailable at detection time");
  }
});

test("followups (#16, #18, size): abandoned claim recovery, dropped write rollback, late evidence, OpenCode wrong provider, compact state", async () => {
  const { engine, protocol } = await loadCore();
  const T0 = Date.parse("2026-11-26T15:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  const codexTerm = makeTerminal({
    address: "t1",
    turn: 10,
    program: { key: "codex", name: "Codex", agent: true, shell: false },
    foreground: { pid: 200, name: "codex" },
    report: { app: "codex", state: "idle" },
    labels: {},
    argv: ["codex"],
  });

  // #16a: Crash after publishing `resuming` before `hc send` delivers -> restart after 6m recovers and sends!
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng1 = engine.createEngine(h.env);
    await eng1.tick();
    // Simulate a crash right after acquireExclusiveClaim published `resuming` (before hc send started)
    const snapped = h.sharedStore[protocol.STATE_KEY];
    snapped.queue[0].status = "resuming";
    snapped.claims = { t1: { owner: "crashed-instance", atMs: T0 + 2 * MIN } };

    // 6 minutes later (> 5m CLAIM_TTL_MS): new instance restarts -> claim expired, attempts still 0 -> sends!
    h.setNow(T0 + 8 * MIN);
    const eng2 = engine.createEngine(h.env);
    assert.equal(eng2.getState().queue[0].status, "waiting");
    const st = await eng2.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1, "abandoned pre-send claim must recover after TTL");
    assert.equal(st.history[0].outcome, "resumed");
  }

  // #16b: Dropped `resuming` write in setShared -> rolls back status to "waiting" (never wedges), next tick sends!
  {
    let dropResumingWrite = true;
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached. Try again in 1m.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const origSetShared = h.env.setShared;
    h.env.setShared = (k, v) => {
      if (dropResumingWrite && k === protocol.STATE_KEY && v?.queue?.[0]?.status === "resuming") {
        dropResumingWrite = false;
        return; // drop the write!
      }
      origSetShared(k, v);
    };
    const eng = engine.createEngine(h.env);
    await eng.tick();
    h.setNow(T0 + 3 * MIN);
    await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 0);
    assert.equal(eng.getState().queue[0].status, "waiting", "failed claim readback must roll back to waiting");

    // Next tick succeeds cleanly!
    h.advance(15_000);
    const st2 = await eng.tick();
    assert.equal(h.hcCalls.filter((a) => a[0] === "send").length, 1);
    assert.equal(st2.history[0].outcome, "resumed");
  }

  // #18a: Timeless banner whose 100% usage report arrives one tick later -> re-scans with unchanged terminal signature & queues!
  {
    const h = createHarness({
      nowMs: T0,
      terminals: [codexTerm],
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Error: usage_limit_reached.\n› ", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(codexTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, "no usage report yet");

    // Next tick: matching 100% Codex usage report arrives while terminal signature is UNCHANGED!
    h.advance(15_000);
    h.sharedStore[protocol.USAGE_LIMITS_STATE_KEY] = {
      codex: {
        report: {
          status: "ok",
          observedAt: Math.floor((T0 + 15_000) / 1000),
          windows: [{ id: "codex:primary", short: "5h", percent: 100, resetsAt: Math.floor((T0 + HOUR) / 1000) }],
        },
      },
    };
    await eng.tick();
    assert.equal(eng.getState().queue.length, 1, "late 100% usage report must trigger rescan and queue");
    assert.equal(eng.getState().queue[0].resetSource, "quota");
  }

  // #18b: Generic OpenCode `Too Many Requests` + unrelated exhausted Claude window -> MUST NOT attach Claude window!
  {
    const ocTerm = makeTerminal({
      address: "t1",
      turn: 10,
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
              observedAt: Math.floor(T0 / 1000),
              windows: [{ id: "session", short: "5h", percent: 100, resetsAt: Math.floor((T0 + HOUR) / 1000) }],
            },
          },
        },
      },
      hcHandler: async (args) => {
        if (args[0] === "read") return { code: 0, stdout: "Too Many Requests\n┃  \n┃  Build  Gemini", stderr: "" };
        if (args[0] === "get") return { code: 0, stdout: JSON.stringify(ocTerm), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const eng = engine.createEngine(h.env);
    await eng.tick();
    assert.equal(eng.getState().queue.length, 0, "generic OpenCode banner must NOT attach unrelated Claude exhausted window");
  }

  // Size: Bookkeeping caps are reduced (64/32), expired claims/cooldowns prune, and populated state stays compact!
  {
    assert.equal(protocol.MAX_HANDLED_FINGERPRINTS, 64);
    assert.equal(protocol.MAX_HANDLED_BANNERS, 64);
    assert.equal(protocol.MAX_PROMOTED_EPISODES, 64);
    assert.equal(protocol.MAX_EPISODE_ATTEMPTS_KEYS, 64);
    assert.equal(protocol.MAX_TERMINAL_COOLDOWNS, 64);
    assert.equal(protocol.MAX_CANCEL_EPOCHS, 64);
    assert.equal(protocol.MAX_CLAIMS, 32);

    // Populated store with expired claims/cooldowns pruned stays well under 15 KB (down from ~60 KB).
    const rawPopulated = {
      version: 1,
      enabled: true,
      handledFingerprints: Array.from({ length: 200 }, (_, i) => `e0000000-1111-4222-8333-${String(i).padStart(12, "0")}`),
      handledBanners: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          `linux/t${i}`,
          { bannerKey: `screen:linux/t${i}:codex:codex-hit-limit:deadbeef`, turn: i, statusMs: T0, resetsAtMs: T0, handledAtMs: T0, cancelled: false },
        ]),
      ),
      promotedEpisodes: Array.from({ length: 32 }, (_, i) => `linux/t${i}:29928500`),
      episodeAttempts: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`linux/t${i}:codex:29928500`, 1])),
      terminalCooldowns: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`linux/t${i}`, T0 - 20 * MIN])),
      cancelEpochs: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`linux/t${i}`, 1])),
      cancelledSignatures: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`linux/t${i}`, `10|1000|live|idle|`])),
      claims: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`linux/t${i}`, { owner: "qr-1-abc", atMs: T0 - 10 * MIN }])),
    };
    const norm = protocol.normalizeState(rawPopulated, T0);
    assert.equal(norm.handledFingerprints.length, 64);
    assert.equal(Object.keys(norm.terminalCooldowns).length, 0, "expired cooldowns must be pruned");
    assert.equal(Object.keys(norm.claims).length, 0, "expired claims must be pruned");
    const bytes = Buffer.byteLength(JSON.stringify(norm), "utf8");
    assert.ok(bytes < 15_000, `populated bookkeeping state must be <15 KB (got ${bytes} bytes)`);
  }
});
