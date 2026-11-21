// Moving a tab to another space. Herdr has no command for it, so each terminal is parked (the pane goes, the
// terminal keeps running) and then re-labelled into the target: Herdr adopts a terminal by its herdr.space and
// herdr.tab labels, and an unknown tab id becomes a new tab there. Labelling before the park has applied is
// overwritten, so the park is waited for. Pure: the host functions are injected (see test/move.test.mjs).
// Mod panes in the tab have no terminal and stay behind.
const STEP = 100;
const LIMIT = 5000;
const RESTORE_LIMIT = 10000;

const newTabId = () => "tb" + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

async function until(host, ready, limit = LIMIT) {
  for (let waited = 0; waited <= limit; waited += STEP) {
    if (await ready()) return true;
    await host.sleep(STEP);
  }
  return false;
}

async function parked(host, terminal) {
  try {
    const r = await host.hc(["get", terminal]);
    return r.code === 0 && !("herdr.space" in (JSON.parse(r.stdout).labels ?? {}));
  } catch { return false; }
}

// Puts every terminal this move touched back in its original tab, by its current state. A second park is never
// sent to a terminal whose own park may still be pending: the core may land both and strand it.
//  - still in its original tab: its park may be pending, so it is waited for (longer), then relabelled;
//  - adopted into the target with a pane: parked once, waited for, relabelled;
//  - already parked: relabelled.
// Success is the terminal showing in panes() in its tab, not a label. When that fails, or anything threw, the
// core's keep is tried. A terminal whose park never landed is still where it was: reported as left in place.
async function restore(host, terminals, space, tab) {
  const restored = [], left = [], stuck = [];
  for (const t of terminals) {
    const back = () => host.panes().some((p) => p.terminal === t && p.tab === tab);
    let ok = false, waited = false;
    try {
      const labels = JSON.parse((await host.hc(["get", t])).stdout).labels ?? {};
      if (labels["herdr.space"] && labels["herdr.tab"] === tab) {
        if (!(await until(host, () => parked(host, t), RESTORE_LIMIT))) waited = true;
      } else if (labels["herdr.space"]) {
        await host.run("terminal.park", { terminal: t });
        await until(host, () => parked(host, t));
      }
      if (!waited) await host.hc(["label", t, `herdr.space=${space}`, `herdr.tab=${tab}`]);
      ok = await until(host, back);
    } catch {}
    if (!ok) {
      try {
        await host.run("terminal.keep", { terminal: t });
        ok = await until(host, back);
      } catch {}
    }
    (ok ? (waited ? left : restored) : stuck).push(t);
  }
  return { restored, left, stuck };
}

// { tab, target } -> { ok: true, tab } | { error }. Never throws.
export async function moveTab({ tab, target }, host) {
  try {
    const sp = host.spaces();
    const from = sp.find((s) => s.tabs.some((c) => c.id === tab));
    const to = sp.find((s) => s.id === target);
    const src = from?.tabs.find((c) => c.id === tab);
    if (!from || !src) return { error: "That tab is gone." };
    if (!to) return { error: "That space is gone." };
    if (from.id === to.id) return { error: "The tab is already in that space." };
    if (from.machine !== null || to.machine !== null) return { error: "Only tabs on this computer can move." };
    const terminals = host.panes().filter((p) => p.tab === tab && p.terminal).map((p) => p.terminal);
    if (!terminals.length) return { error: "That tab has no terminal to move." };

    const next = newTabId();
    const attempted = [];
    const fail = async (message) => {
      const { restored, left, stuck } = await restore(host, attempted, from.id, tab);
      // Parking the last pane may have closed the tab, and a relabel brings it back unnamed.
      if (src.named && restored.length) { try { await host.run("tab.rename", { id: tab, name: src.name }); } catch {} }
      let tail = "";
      if (restored.length) tail += ` Put back: ${restored.join(", ")}.`;
      if (left.length) tail += ` Left in place: ${left.join(", ")}.`;
      if (stuck.length) tail += ` Could not put back: ${stuck.join(", ")}.`;
      return { error: message + tail };
    };
    try {
      for (const t of terminals) {
        attempted.push(t);
        await host.run("terminal.park", { terminal: t });
        if (!(await until(host, () => parked(host, t)))) return await fail(`Terminal ${t} did not detach.`);
        const r = await host.hc(["label", t, `herdr.space=${to.id}`, `herdr.tab=${next}`]);
        if (r.code !== 0) return await fail(`Could not move terminal ${t}: ${(r.stderr ?? "").trim()}`);
      }
      const arrived = await until(host, () => host.spaces().find((s) => s.id === to.id)?.tabs.some((c) => c.id === next));
      if (!arrived) return await fail("The tab did not show up in the space.");
    } catch (e) {
      return await fail(String(e?.message ?? e));
    }

    if (src.named) await host.run("tab.rename", { id: next, name: src.name });
    await host.run("space.select", { id: to.id });
    await host.run("tab.select", { id: next });
    return { ok: true, tab: next };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}
