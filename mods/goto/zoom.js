import { panes, run } from "herdr";

// As t3-picker: a tab draws its zoomed pane whichever pane is focused, so a zoomed sibling is unzoomed first,
// in the focus's tick. pane.zoom toggles, so never on the pane already zoomed.
export function focusPane(pane) {
  const ps = panes(), p = ps.find((q) => q.pane === pane);
  if (p && !p.zoomed && ps.some((q) => q.tab === p.tab && q.zoomed)) run("pane.zoom", { pane });
  run("pane.focus", { pane });
}
