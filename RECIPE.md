# Herdr Layout Recipe — `omarchy-glass`

This repository packages the `omarchy-glass` and `omarchy-glass-insights` Herdr App layouts, themes, other layouts, and all the mods they use (original, forked and vendored third-party), following the `herdr-layout` layout-pack convention.

## Compatibility

- **Herdr App:** `>= 0.1.16` (relies on shipped mods `workspace-chrome`, `workspace-status`, `worktree`, `agents`, and `picker` — none of which are overwritten by this pack).
- **Platforms:** Linux and macOS.
- **Provenance:** See [`PROVENANCE.md`](./PROVENANCE.md) for forked mods, base commits, and the third-party mods shipped unchanged (commits in `vendor.json`).

## Contents

- `layouts/`
  - `omarchy-glass.json` — main translucent glass layout with sidebar rail, T3 inbox stack, right panel (`better-files`, `better-changes`, `markdown-browser`, `branch-pr`, `ci-dash`, `over9k-prompts`), `usage-limits` bar, and background daemons (`tui-prefix`, `agent-names`, `agent-resume`, `goto`).
  - `omarchy-glass-insights.json` — variant with compact sidebar footer height tuned for Insights workflows.
  - `omarchy.json`, `omarchy-next.json` — our other layouts.
  - `cockpit.json`, `herdr-t3.json` (+ `herdr-t3.svg`), `workspace.json` (+ `workspace.svg`) — third-party layouts shipped unchanged. The `.svg` files are layout previews and are copied with the `.json`.
- `themes/`
  - `omarchy.json`
  - `catppuccin.json`
- `mods/` — every mod the layouts use: original mods, forks, and third-party mods shipped unchanged (see `PROVENANCE.md`). The third-party content is copied by `scripts/vendor.mjs` from the commits in `vendor.json`.
- `keys.fragment.json` — recommended `layout:omarchy-glass*` and mod-scoped keybinding fragments.

## Installation

### Via `dotfiles-plugins` (recommended)

This pack is tracked under `config.plugins.herdr-omarchy-glass` in `mdiloreto/dotfiles`:

```bash
# Sync from remote main (cloned into ~/.local/share/dotfiles-plugins/herdr-omarchy-glass)
dotfiles-plugins sync --only herdr-omarchy-glass

# Or develop directly against a local clone
HERDR_LAYOUT_ROOT=~/vscode/herdr-omarchy-glass dotfiles-plugins sync --only herdr-omarchy-glass
```

`dotfiles-plugins` symlinks each mod listed in `modDirs` from the clone into `~/.config/herdr-app/mods/` (and runs `touch -h` on the links after a pull so Herdr reloads them). It still copies the listed layouts and themes, refusing to overwrite Herdr App shipped files (`layouts/main.json`, `layouts/.state/`, shipped mods, etc.). An existing mod directory is replaced by the link only when it is byte-identical to the clone's copy.

### Manual installation

1. Copy `layouts/*.json` and `layouts/*.svg` into `~/.config/herdr-app/layouts/`.
2. Copy `themes/*.json` into `~/.config/herdr-app/themes/`.
3. Symlink or copy each folder in `mods/` into `~/.config/herdr-app/mods/`. No separate third-party install is needed; `insights` and `fleet-quota` stay outside the pack (see `PROVENANCE.md`).
4. Merge the sections from `keys.fragment.json` into `~/.config/herdr-app/keys.json`.
5. Select `omarchy-glass` (or `omarchy-glass-insights`) via `layout.switch` in Herdr App.

## Optional Helpers

- **`branch-pr` Go helper (`mods/branch-pr/bin/herdr-pr`):** Built per OS from the pinned commit of `munza/herdr-mods` (managed automatically by `dotfiles`'s `run_after_install-herdr-pr-helper.sh.tmpl`).
- **`fleet-quota`:** Intentionally kept in `dotfiles` (not this repo) because it is tightly coupled to the Linux `herdr-fleet-quota-refresh` systemd producer.

## License

MIT, see [`LICENSE`](./LICENSE). Forked mods keep their upstream licenses: see [`NOTICE`](./NOTICE) and [`LICENSES/`](./LICENSES/).
