// Zero-size daemon mod that detects rate-limited Claude Code, Codex, and OpenCode
// sessions (local and fleet) and resumes them automatically once their quota resets.
import { View, div } from "gpui-kit";
import {
  terminals,
  panes,
  spaces,
  shared,
  setShared,
  hc,
  exec,
  notify,
  checking,
} from "herdr";
import { COMMAND_KEY } from "./core/protocol.mjs";
import { DEFAULT_TICK_MS, createEngine } from "./core/engine.mjs";

export default class QuotaResume extends View {
  init(_props, cx) {
    this.timer = null;
    this.closed = false;
    this.tickQueued = false;
    this.inFlight = Promise.resolve();
    this.seenCommandId = null;
    this.engine = null;

    // Never start timers, shell/hc calls, or shared-state writes during `Herdr check`.
    if (checking()) return;

    this.engine = createEngine({
      terminals,
      panes,
      spaces,
      shared,
      setShared,
      hc,
      exec,
      notify,
      now: () => Date.now(),
      log: (m) => console.log(`quota-resume: ${m}`),
    });

    this.seenCommandId = this.engine.getState().lastHandledCommandId;
    this.engine.publish(true);

    this.timer = cx.timer.every(DEFAULT_TICK_MS, (tickCx) => this.runTick(tickCx));
    this.runTick(cx);
  }

  enqueue(cx, fn) {
    const prev = this.inFlight;
    let release;
    this.inFlight = new Promise((resolve) => {
      release = resolve;
    });
    cx.spawn(async (taskCx) => {
      try {
        await prev;
        if (this.closed || !this.engine) return;
        await fn(taskCx);
      } finally {
        release();
      }
    });
  }

  runTick(cx) {
    if (this.closed || this.tickQueued || !this.engine) return;
    this.tickQueued = true;
    this.enqueue(cx, async (taskCx) => {
      try {
        await this.engine.tick({
          sleep: (ms) => taskCx.sleep(ms),
        });
      } catch (e) {
        console.log(`quota-resume: tick failed: ${e?.message ?? e}`);
      } finally {
        this.tickQueued = false;
      }
    });
  }

  dispatchCommand(cmd, cx) {
    if (this.closed || !this.engine) return;
    this.seenCommandId = cmd.id;
    this.enqueue(cx, async () => {
      try {
        await this.engine.processCommand(cmd);
      } catch (e) {
        console.log(`quota-resume: command failed: ${e?.message ?? e}`);
      }
    });
  }

  render(cx) {
    if (!checking() && !this.closed && this.engine) {
      const cmd = shared(COMMAND_KEY);
      if (
        cmd &&
        typeof cmd.id === "string" &&
        cmd.id &&
        cmd.id !== this.seenCommandId &&
        cmd.id !== this.engine.getState().lastHandledCommandId
      ) {
        this.dispatchCommand(cmd, cx);
      }
    }
    return div().id("quota-resume").size(0);
  }

  close() {
    this.closed = true;
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }
}
