# Herdr Layout Recipe — `glass`

This repository packages the `glass` and `glass-insights` Herdr App layouts, themes, other layouts, and all the mods they use (original, forked and vendored third-party), following the `herdr-layout` layout-pack convention.

## Compatibility

- **Herdr App:** `>= 0.1.16` (relies on shipped mods `workspace-chrome`, `workspace-status`, `worktree`, `agents`, and `picker` — none of which are overwritten by this pack).
- **Platforms:** Linux and macOS.
- **Provenance:** See [`PROVENANCE.md`](./PROVENANCE.md) for forked mods, base commits, and the third-party mods shipped unchanged (commits in `vendor.json`).

## Contents

- `layouts/`
  - `glass.json` — main translucent glass layout with sidebar rail, T3 inbox stack, right panel (`better-files`, `better-changes`, `markdown-browser`, `web-browser`, `branch-pr`, `ci-dash`, `over9k-prompts`), `usage-limits` bar, and background daemons (`tui-prefix`, `agent-names`, `agent-resume`, `goto`).
  - `glass-insights.json` — variant with compact sidebar footer height tuned for Insights workflows.
  - `omarchy.json`, `omarchy-next.json` — our other layouts.
  - `cockpit.json`, `herdr-t3.json` (+ `herdr-t3.svg`), `workspace.json` (+ `workspace.svg`) — third-party layouts shipped unchanged. The `.svg` files are layout previews and are copied with the `.json`.
- `themes/`
  - `omarchy.json`
  - `catppuccin.json`
- `mods/` — every mod the layouts use: original mods, forks, and third-party mods shipped unchanged (see `PROVENANCE.md`). The third-party content is copied by `scripts/vendor.mjs` from the commits in `vendor.json`.
- `keys.fragment.json` — recommended `layout:glass*` and mod-scoped keybinding fragments, plus a `terminal` section that hands `ctrl-n` and `ctrl-left`/`ctrl-right` to the focused program, so Neovim keeps completion and stays in insert mode (Herdr App bindings cannot depend on the program, herdrdev/herdr-app#745). `ctrl-n` then no longer runs `agent.next` while a terminal has focus; bind `agent.next` to another key if you use it.

## Installation

### Via `dotfiles-plugins` (recommended)

This pack is tracked under `config.plugins.herdr-glass` in `mdiloreto/dotfiles`:

```bash
# Sync from remote main (cloned into ~/.local/share/dotfiles-plugins/herdr-glass)
dotfiles-plugins sync --only herdr-glass

# Or develop directly against a local clone
HERDR_LAYOUT_ROOT=~/vscode/herdr-glass dotfiles-plugins sync --only herdr-glass
```

`dotfiles-plugins` symlinks each mod listed in `modDirs` from the clone into `~/.config/herdr-app/mods/` (and runs `touch -h` on the links after a pull so Herdr reloads them). It still copies the listed layouts and themes, refusing to overwrite Herdr App shipped files (`layouts/main.json`, `layouts/.state/`, shipped mods, etc.). An existing mod directory is replaced by the link only when it is byte-identical to the clone's copy.

### Manual installation

1. Copy `layouts/*.json` and `layouts/*.svg` into `~/.config/herdr-app/layouts/`.
2. Copy `themes/*.json` into `~/.config/herdr-app/themes/`.
3. Symlink or copy each folder in `mods/` into `~/.config/herdr-app/mods/`. No separate third-party install is needed; `insights` and `fleet-quota` stay outside the pack (see `PROVENANCE.md`).
4. Merge the sections from `keys.fragment.json` into `~/.config/herdr-app/keys.json`. Add the keys into a section that already exists (such as `terminal`) instead of replacing it, so its other bindings survive.
5. Select `glass` (or `glass-insights`) via `layout.switch` in Herdr App.

## Optional Helpers

- **`branch-pr` Go helper (`mods/branch-pr/bin/herdr-pr`):** Built per OS from the pinned commit of `munza/herdr-mods` (managed automatically by `dotfiles`'s `run_after_install-herdr-pr-helper.sh.tmpl`).
- **`web-browser`:** Needs `terminal-browser` on each machine that opens pages (`brew install --cask terminal-browser` on macOS, `curl -fsSL https://terminal-browser.sh/install | bash` on Linux).
- **`fleet-quota`:** Intentionally kept in `dotfiles` (not this repo) because it is tightly coupled to the Linux `herdr-fleet-quota-refresh` systemd producer.

## License

MIT, see [`LICENSE`](./LICENSE). Forked mods keep their upstream licenses: see [`NOTICE`](./NOTICE) and [`LICENSES/`](./LICENSES/).
