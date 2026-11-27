// Zero-size daemon mod that watches CPU, memory and disk on every connected
// machine and notifies about spikes, whether or not any panel is open.
import { View, div } from "gpui-kit";
import { machines, exec, notify, shared, setShared, props, checking, window } from "herdr";
import { readConfig } from "./core/engine.mjs";
import { createDaemon } from "./core/daemon.mjs";

export default class FleetResources extends View {
  init(_props, cx) {
    this.timer = null;
    this.daemon = null;

    // Never start timers, exec calls, or shared-state writes during `Herdr check`.
    if (checking()) return;

    const config = readConfig(props());
    this.daemon = createDaemon({
      machines,
      exec,
      notify,
      shared,
      setShared,
      config,
      platform: window()?.platform,
      now: () => Date.now(),
      log: (m) => console.log(`fleet-resources: ${m}`),
    });

    this.timer = cx.timer.every(config.intervalSec * 1000, (tickCx) => this.runTick(tickCx));
    this.runTick(cx);
  }

  runTick(cx) {
    cx.spawn(async () => {
      try {
        await this.daemon?.tick();
      } catch (e) {
        console.log(`fleet-resources: tick failed: ${e?.message ?? e}`);
      }
    });
  }

  render() {
    return div().id("fleet-resources").size(0);
  }

  close() {
    this.timer?.cancel();
    this.timer = null;
    this.daemon?.close();
    this.daemon = null;
  }
}
