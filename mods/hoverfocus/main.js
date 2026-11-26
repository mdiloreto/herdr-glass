// Focus the terminal under the pointer, the way a tiling window manager does.
//
// Herdr has no pane mouse-enter event for mods. This mod is installed as each
// pane's header with `reveal: "hover"` and a height taller than any pane: the
// header is invisible, drawn only while the pointer is on its pane, and lets
// clicks and text selection through to the terminal beneath it. Entering it
// runs the same `pane.focus` a click runs, so the keyboard follows the mouse.
//
// Only terminals: a mod pane renders nothing (its pane has no terminal).
// The window must be active, or a click into another window would focus a
// pane behind it.

import { View, div } from "gpui-kit";
import { panes, props, run, window } from "herdr";

export default class HoverFocus extends View {
  render() {
    const p = panes().find((pane) => pane.pane === props()?.pane);
    if (!p?.terminal) return div();
    return div()
      .id(`hover-focus-${p.pane}`)
      .size_full()
      .on_hover((hovered) => {
        if (!hovered || p.focused || !window().active) return;
        run("pane.focus", { pane: p.pane });
      });
  }
}
