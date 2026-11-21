// The focused pane's space as a small pill in the tab row: its avatar, drawn like
// the spaces sidebar draws it, and its name, which gives way with an ellipsis.
// Click it to open the spaces picker.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, focused, theme, shared, run } from "herdr";
import { where } from "./where.js";

// The sidebar's avatar colors: space-folders gives each space one and shares the choice under this key.
const WADA_KEY = "better-sidebar-rail.space-wada";
const WADA_FIRST = "#dda8c8";

// Same letters as the sidebar's avatars (space-folders-next's monogram).
function monogram(name) {
  if (name === "~") return "~";
  const words = name.trim().replace(/^\[(.*)\]$/, "$1").replace(/^\s*(repo|init)\s*:\s*/i, "").replace(/^\[(.*)\]$/, "$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s\-_.:]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const chars = [...words[0]];
  const consonant = chars.slice(1).find((c) => /[b-df-hj-np-tv-z]/i.test(c));
  return (chars[0] + (consonant ?? chars[1] ?? "")).toUpperCase();
}

// A hex color moved a fraction of the way to white.
function lighten(hex, amount) {
  const mix = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  };
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

export default class Where extends View {
  render() {
    const t = theme(), here = focused();
    const w = where({ spaces: spaces(), panes: panes(), folders: shared("space-folders"), focused: here, agents: agents(), order: shared("agents.order")?.order });
    const root = h_flex().id("where").size_full().min_w(0).overflow_hidden().pl(10).pr(4).items_center();
    if (!w) return root;
    const hex = (shared(WADA_KEY) ?? {})[here?.space] ?? WADA_FIRST;
    return root.child(h_flex().id("where-place").min_w(0).flex_shrink(1).h(24).pl(4).pr(9).gap(6).items_center()
      .rounded(7).border(1).border_color(t.border).bg(t.foreground + "08").cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("mod.open", { name: "tui-spaces" }))
      .child(h_flex().size(16).flex_none().rounded(4).items_center().justify_center()
        .bg(hex + "29").text_size(9).font_semibold().text_color(lighten(hex, 0.12)).child(monogram(w.space)))
      .child(div().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(w.space)));
  }
}
