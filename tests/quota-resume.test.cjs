const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const modDir = path.join(root, "mods", "quota-resume");

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

function makeTerminal(overrides = {}) {
  return {
    address: "t1",
    state: "live",
    status: "done",
    turn: 10,
    status_ms: 1000,
    title: "Fix quota resume",
    program: { key: "claude", name: "Claude Code", agent: true, shell: false },
    foreground: { pid: 100, name: "claude" },
    report: { app: "claude-code", state: "done", msg: null },
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
    status: { app: "claude-code", state: "done" },
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
  hcHandler,
  execHandler,
} = {}) {
  let clock = nowMs;
  const sharedStore = { ...sharedInit };
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
  assert.equal(def.enabled, true);
  assert.equal(def.settings.delaySec, 60);
  assert.deepEqual(def.settings.agents, { claude: true, codex: true, opencode: true });

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
  assert.deepEqual(sends[0], ["send", "linux/t3n", protocol.DEFAULT_PROMPT]);
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

  // resume-now on t2 -> sends immediately despite future resetsAt
  await eng.processCommand({ version: 1, id: "cmd-2", action: "resume-now", address: "t2", atMs: baseMs + 2000 });
  assert.equal(eng.getState().queue.length, 0);
  assert.equal(eng.getState().history[0].outcome, "resumed");
  assert.equal(h.hcCalls.filter((a) => a[0] === "send" && a[1] === "t2").length, 1);

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
    report: { app: null, state: "error" },
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
            status: { app: null, state: "error" },
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
  assert.equal(h.hcCalls.filter((a) => a[0] === "send" && a[1] === "linux/t9").length, 1);
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

test("layouts: do not mount quota-resume-daemon", () => {
  const layoutFiles = ["glass.json", "glass-insights.json", "omarchy.json", "omarchy-next.json"];
  for (const name of layoutFiles) {
    const file = path.join(root, "layouts", name);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      assert.notEqual(node.id, "quota-resume-daemon", `${name}: quota-resume-daemon mounted`);
      assert.notEqual(node.content?.mod, "quota-resume", `${name}: quota-resume mod mounted`);
      for (const value of Object.values(node)) visit(value);
    };
    visit(data);
  }
});
