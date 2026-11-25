// Terminal links to a dev server open in the Web pane; anything else stays with the app.
import { panes } from "herdr";
import { openUrl } from "./open.js";

export async function handleLink({ link, source }) {
  if (link?.kind !== "url") return "pass";
  if (!source?.pane || !panes().some((p) => p.pane === source.pane)) return "pass";
  await openUrl({ url: link.raw, machine: source.machine, pane: source.pane, tab: source.tab });
  return "handled";
}
