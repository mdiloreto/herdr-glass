// What goto draws: a row, its marks, and the preview. Looks match better-sidebar-rail's agents list and
// space-folders' avatars, so a thing reads the same wherever it shows.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, settings } from "herdr";
import { tagOf } from "./index.js";

export const ROW_H = 42;
export const HEAD_H = 26;

// Avatar tints, dusty on purpose: the colors space-folders hands out, read from its shared key.
const WADA_KEY = "better-sidebar-rail.space-wada";
const WADA = ["#dda8c8", "#78b79e", "#d6a582", "#a5ae77", "#aa9fd3", "#8fc7c6", "#b39fbf", "#bab37c", "#95c9a4", "#caa1cc", "#78c1b6", "#e4ac92"];

function monogram(name) {
  if (name === "~") return null;
  const words = name.trim().replace(/^\[(.*)\]$/, "$1").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s\-_.:]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const chars = [...words[0]];
  const consonant = chars.slice(1).find((c) => /[b-df-hj-np-tv-z]/i.test(c));
  return (chars[0] + (consonant ?? chars[1] ?? "")).toUpperCase();
}

function lighten(hex, amount) {
  const mix = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  };
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

function avatar(it, t, size = 20) {
  const base = h_flex().size(size).flex_none().rounded(5).items_center().justify_center();
  const letters = monogram(it.spaceName);
  if (letters === null) return base.bg(t.hover).child(svg("mods/goto/icons/home.svg").size(Math.round(size / 2)).text_color(t.muted));
  const hex = (shared(WADA_KEY) ?? {})[it.space] ?? WADA[0];
  return base.bg(hex + "29").text_size(10.5).font_semibold().text_color(lighten(hex, 0.12)).child(letters);
}

// The agents list's marks: a spinner working, "!" blocked, a ring idle, a dot done.
function statusMark(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") {
    return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked)
      .flex().items_center().justify_center().child("!");
  }
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
  return null;
}

// The vendor icon from the program table: a one-color glyph or a picture. Tabs and plain terminals get a glyph.
function icon(it, t) {
  const p = it.program;
  if (it.kind === "tab" || it.kind === "folder") return svg("mods/goto/icons/layers.svg").size(14).flex_none().text_color(t.muted);
  if (it.kind === "space") return svg("mods/goto/icons/git-branch.svg").size(14).flex_none().text_color(t.muted);
  if (!p?.icon) return svg("mods/goto/icons/terminal.svg").size(14).flex_none().text_color(t.muted);
  return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.muted) : image(p.icon).w(14).h(14).flex_none();
}

// The label with the matched letters lit, as the palette lights them.
function title(t, text, hits) {
  const base = t.foreground;
  if (!hits?.length) return div().truncate().text_color(base).child(text);
  const parts = [];
  let cur = "", lit = false;
  [...text].forEach((ch, i) => {
    const h = hits.includes(i);
    if (h !== lit && cur) { parts.push([cur, lit]); cur = ""; }
    lit = h;
    cur += ch;
  });
  if (cur) parts.push([cur, lit]);
  return h_flex().min_w(0).overflow_hidden().whitespace_nowrap()
    .children(parts.map(([s, h]) => div().text_color(h ? t.accent : base).when(h, (d) => d.font_semibold()).child(s.replace(/ /g, " "))));
}

// `x`: { it, hits, on, armed, tagged, back }. Placed by the caller (absolute, at its y).
export function row(t, x) {
  const { it, hits, on, armed, tagged, back } = x;
  const mark = statusMark(t, it.status);
  return h_flex().h(ROW_H).mx(6).px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .role("button").accessibility_label(back ? `Back to ${it.label}` : it.label)
    .when(on, (el) => el.bg(t.selected))
    .when(armed, (el) => el.bg(t.blocked + "22"))
    .child(div().w(14).flex_none().text_size(11).text_color(t.dim).text_center().child(it.jump ? String(it.jump) : ""))
    .child(icon(it, t))
    .child(div().w(14).flex_none().flex().items_center().justify_center().when(Boolean(mark), (el) => el.child(mark)))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().min_w(0).text_size(13.5).line_height("18px").when(Boolean(it.here), (d) => d.font_medium()).child(title(t, it.label, hits)))
      .child(div().truncate().text_size(11.5).line_height("15px").text_color(t.dim).child(it.meta.join(" · "))))
    .when(armed, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(t.blocked).child("Ctrl+D again to close")))
    .when(!armed && back, (el) => el.child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child("↩ Back")))
    .when(!armed && !back && tagged, (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.foreground + "12").text_size(10.5).text_color(t.dim).child(tagOf(it))))
    .when(it.kind !== "folder", (el) => el.child(avatar(it, t)));
}

export function header(t, text) {
  return h_flex().h(HEAD_H).px(16).pb(4).items_end().text_size(11).font_semibold().text_color(t.dim).child(text);
}

// The right side: the selected pane's screen as `hc read` gave it, or why there is none.
export function preview(t, it, text) {
  const body = it?.kind === "pane" && it.terminal;
  const lines = (text ?? "").split("\n");
  return v_flex().w(380).flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.foreground + "05")
    .child(h_flex().flex_none().h(32).px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(div().truncate().child(it ? it.label : "Preview")))
    // Lines keep their height (shrunk, they clip to slivers); the newest stay in view at the bottom.
    .child(v_flex().flex_1().min_h(0).overflow_hidden().justify_end().p(10)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).line_height("14px").text_color(t.muted)
      .when(!body, (el) => el.child(div().text_color(t.dim).child(it ? "No preview for a tab or space." : "Nothing selected.")))
      .when(Boolean(body), (el) => el.children(lines.map((l) => div().flex_none().whitespace_nowrap().overflow_hidden().child(l === "" ? " " : l.replace(/ /g, " "))))));
}
