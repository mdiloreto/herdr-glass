// The Web panel: a URL box and the target machine's listening ports, opened beside the agent
// in terminal-browser (see open.js).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, focused, exec, checking } from "herdr";
import { openUrl } from "./open.js";

const TIMEOUT = 5000;
const HIDDEN = [
  "terminal-browser", "electron", "herdr", "herdr-core", "rapportd", "controlcenter",
  "claude", "agy", "opencode", "opencode.exe", "codex", "basic-memory", "spotify",
];

// lsof truncates names to nine characters and ss to fifteen, so a hidden name also matches its
// prefix, but only one that long: a short name like "c" is its own process.
const hidden = (name) => {
  const n = String(name ?? "").toLowerCase();
  return Boolean(n) && HIDDEN.some((h) => n === h || (n.length >= 9 && h.startsWith(n)));
};

// A local address ("127.0.0.1:3000", "[::1]:3000", "*:3000") as the host a browser reachable
// from this machine would use. Wildcard and loopback listeners are localhost; another address is
// kept, bracketed for IPv6.
function addressOf(addr) {
  const s = String(addr ?? "");
  const cut = s.lastIndexOf(":");
  if (cut < 0) return null;
  const port = Number(s.slice(cut + 1));
  if (!Number.isInteger(port) || port < 1) return null;
  let raw = s.slice(0, cut);
  const bracketed = raw.startsWith("[") && raw.endsWith("]");
  if (bracketed) raw = raw.slice(1, -1);
  raw = raw.replace(/%.*$/, "");
  const local = /^(?:\*|0\.0\.0\.0|::|::1|127(?:\.\d{1,3}){3})$/i.test(raw);
  const host = local ? "localhost" : (bracketed || raw.includes(":") ? `[${raw}]` : raw);
  return { port, host };
}

// A port a hidden process holds stays hidden, whatever helper shares its socket. A port bound on
// a loopback and another address is shown as localhost.
function onePerPort(rows) {
  const skip = new Set(rows.filter((r) => hidden(r.name)).map((r) => r.port));
  const byPort = new Map();
  for (const { port, name, host } of rows) {
    if (!port || skip.has(port)) continue;
    const seen = byPort.get(port);
    if (!seen) byPort.set(port, { port, name: String(name), host });
    else if (seen.host !== "localhost" && host === "localhost") byPort.set(port, { port, name: String(name), host });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function parseLsof(out) {
  const rows = [];
  let name = "";
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line[0] === "c") name = line.slice(1);
    else if (line[0] === "n") {
      const addr = addressOf(line.slice(1));
      if (addr) rows.push({ name, ...addr });
    }
  }
  return rows;
}

// Only rows with a process of the user's: a socket another user owns has no users:(...) here.
function parseSs(out) {
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const user = /users:\(\("([^"]+)",pid=\d+/.exec(line);
    if (!user) continue;
    const local = line.trim().split(/\s+/)[3];
    const addr = addressOf(local);
    if (addr) rows.push({ name: user[1], ...addr });
  }
  return rows;
}

async function listeningPorts(machine) {
  if (!machine) {
    const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: TIMEOUT });
    // lsof exits 1 when nothing matches, but with a message when it couldn't look.
    if (r.code !== 0 && !r.stdout.trim() && r.stderr.trim()) throw new Error(r.stderr.trim());
    return onePerPort(parseLsof(r.stdout ?? ""));
  }
  const r = await exec("ss", ["-Hltnp"], { on: machine, timeout: TIMEOUT });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "ss failed");
  return onePerPort(parseSs(r.stdout ?? ""));
}

export default class WebBrowser extends View {
  init(_props, cx) {
    this.url = InputState.new({ placeholder: "URL or port: 3000, localhost:5173, example.com" });
    this.url.on("submit", (_e, cx) => {
      const input = this.url.value();
      if (!input.trim()) return;
      const { machine, pane, tab } = this.target();
      cx.spawn(() => openUrl({ url: input, machine, pane, tab }));
    });
    this.ports = [];
    this.error = null;
    this.loading = true;
    this.key = null;
    this.request = 0;
  }

  // The focused tab, its space's machine, and the tab's terminal to split beside. With the panel
  // focused there is no focused pane, only the tab.
  target() {
    const f = focused();
    const space = spaces().find((s) => s.active);
    const all = panes();
    const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
    const tab = f?.tab ?? pane?.tab ?? null;
    const term = pane?.terminal ? pane : (all.find((p) => p.tab === tab && p.terminal) ?? null);
    return { machine: space?.machine ?? null, pane: term?.pane ?? null, tab: term?.tab ?? tab };
  }

  refresh(cx) {
    // A check renders the panel once: no port query, which would outlive it.
    if (checking()) return void (this.loading = false);
    const { machine } = this.target();
    const request = ++this.request;
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      let ports = [], error = null;
      try {
        ports = await listeningPorts(machine);
      } catch (e) {
        error = String(e?.message ?? e);
      }
      if (request !== this.request) return;
      this.ports = ports;
      this.error = error;
      this.loading = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const { machine, tab } = this.target();
    const key = JSON.stringify([machine, tab]);
    if (key !== this.key) {
      this.key = key;
      this.refresh(cx);
    }
    const name = machine ?? "This computer";

    const body = this.error
      ? div().px(14).py(6).text_size(11.5).text_color(t.dim).child(this.error)
      : this.loading && !this.ports.length
        ? div().px(14).py(6).text_size(12).text_color(t.dim).child("Loading…")
        : !this.ports.length
          ? div().px(14).py(6).text_size(12).text_color(t.dim).child(`No listening ports on ${name}`)
          : v_flex().id("web-ports").flex_1().min_h(0).p(6).gap(1).overflow_y_scrollbar()
            .children(this.ports.map(({ port, name: proc, host }) =>
              h_flex().id(`web-port-${port}`).h(28).px(8).gap(8).items_center().rounded(7).cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  const now = this.target();
                  cx.spawn((cx) => openUrl({ url: `http://${host}:${port}/`, ...now }));
                })
                .child(div().w(52).flex_none().font_semibold().child(`:${port}`))
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(proc))
                .when(host !== "localhost", (el) => el.child(
                  div().flex_none().text_size(11).text_color(t.dim).child(host)))));

    return v_flex().id("web-browser").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Web"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(name))
        .child(div().id("web-refresh").flex_none().px(4).rounded(5).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx))
          .child("↻")))
      .child(div().id("web-url").flex_none().mx(8).mt(8).h(32).px(10).flex().items_center().rounded(8)
        .border_1().border_color(t.border).cursor_text()
        .child(Input.new(this.url).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().px(12).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child("Listening ports"))
      .child(body);
  }
}
