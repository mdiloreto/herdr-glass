// Which toolbar actions show, and in what order, saved per layout and toolbar.
import { shared, setShared, openOverlay, window } from "herdr";
import { toolbarPreferences, toolbarPartition, placeToolbarAction } from "../actions/toolbar.js";

const PREFERENCES_KEY = "better-tabs.toolbar";
// Each row is 32px, with 2px gaps and 5px padding on each edge.
const menuHeight = (count) => Math.min(420, Math.max(1, count) * 34 + 8);
const BAR_SIDE_PADDING = 20;
const toolbarWidth = (visible) =>
  visible.reduce((sum, entry, i) => sum + 36 + (i && entry.group !== visible[i - 1].group ? 15 : 0), 0);

export const arrangementMethods = {
  toolbarScope() {
    return this.config().toolbarScope ?? JSON.stringify([shared("layout") ?? "default", "main"]);
  },

  preferences() {
    return toolbarPreferences(shared(PREFERENCES_KEY)?.[this.toolbarScope()]);
  },

  savePreferences(value) {
    setShared(PREFERENCES_KEY, {
      ...(shared(PREFERENCES_KEY) ?? {}),
      [this.toolbarScope()]: value,
    });
  },

  toolbar() {
    // The tabs keep at least 350px. What tab-bar.js draws around them comes off the rest: the
    // bar's padding and the gap before the toolbar, the ⋮, the window buttons when the system
    // draws none. An icon button and its gap take 36px, and a break between groups 15px.
    const room =
      (this.width ?? 1200) - 350 - (BAR_SIDE_PADDING + 6) - 36 - (window()?.buttons ? 3 * 36 : 0);
    const entries = this.entries();
    const preferences = this.preferences();
    let limit = Math.max(0, Math.floor(room / 36));
    let partition = toolbarPartition(entries, preferences, limit);
    while (limit > 0 && toolbarWidth(partition.visible) > room)
      partition = toolbarPartition(entries, preferences, --limit);
    return partition;
  },

  pinAction(entry, target = null, after = false) {
    const entries =
      this.config().mode === "overflow"
        ? (this.config().allButtons ?? this.entries())
        : this.entries();
    this.savePreferences(placeToolbarAction(entries, this.preferences(), entry.id, target, after));
  },

  openActions(entries) {
    const bounds = this.moreBounds;
    // A popup is another copy of this mod. Pass its originating scope and full
    // action list so pinning can update the toolbar after the popup closes.
    openOverlay({
      ...(bounds
        ? {
            at: {
              x: Math.max(0, bounds.x + bounds.width - this.settings.menu.width),
              y: bounds.y + bounds.height + 6,
            },
          }
        : {}),
      mod: "better-tabs",
      kind: "popup",
      width: this.settings.menu.width,
      height: menuHeight(entries.length),
      props: {
        ...this.config(),
        mode: "overflow",
        toolbarScope: this.toolbarScope(),
        allButtons: this.entries(),
        buttons: entries,
        rememberPanels: false,
      },
    });
  },
};

export { menuHeight };
