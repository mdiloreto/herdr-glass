# Herdr Layout Recipe — `omarchy-glass`

This repository packages the `omarchy-glass` and `omarchy-glass-insights` Herdr App layouts, themes, and owned mods following the `herdr-layout` layout-pack convention.

## Compatibility

- **Herdr App:** `>= 0.1.16` (relies on shipped mods `workspace-chrome`, `workspace-status`, `worktree`, `agents`, and `picker` — none of which are overwritten by this pack).
- **Platforms:** Linux and macOS.
- **Visibility:** Private repository (see [`PROVENANCE.md`](./PROVENANCE.md) before considering public distribution).

## Contents

- `layouts/`
  - `omarchy-glass.json` — main translucent glass layout with sidebar rail, T3 inbox stack, right panel (`better-files`, `better-changes`, `markdown-browser`, `branch-pr`, `ci-dash`, `over9k-prompts`), `usage-limits` bar, and background daemons (`tui-prefix`, `agent-names`, `agent-resume`, `goto`).
  - `omarchy-glass-insights.json` — variant with compact sidebar footer height tuned for Insights workflows.
- `themes/`
  - `omarchy.json`
  - `catppuccin.json`
- `mods/` — 26 self-contained mods with zero chezmoi templates (see `PROVENANCE.md`).
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

`dotfiles-plugins` copies `layouts/`, `themes/`, and `mods/` into `~/.config/herdr-app/`, refusing to overwrite Herdr App shipped files (`layouts/main.json`, `layouts/.state/`, shipped mods, etc.) and preserving machine-generated files (`mods/branch-pr/bin/herdr-pr`, `mods/insights/runtime.json`).

### Manual installation

1. Copy `layouts/*.json` into `~/.config/herdr-app/layouts/`.
2. Copy `themes/*.json` into `~/.config/herdr-app/themes/`.
3. Copy each folder in `mods/` into `~/.config/herdr-app/mods/`.
4. Merge the sections from `keys.fragment.json` into `~/.config/herdr-app/keys.json`.
5. Select `omarchy-glass` (or `omarchy-glass-insights`) via `layout.switch` in Herdr App.

## Optional Helpers

- **`branch-pr` Go helper (`mods/branch-pr/bin/herdr-pr`):** Built per OS from the pinned commit of `munza/herdr-mods` (managed automatically by `dotfiles`'s `run_after_install-herdr-pr-helper.sh.tmpl`).
- **`insights` Node runtime (`mods/insights/runtime.json`):** `insights` defaults to `node` on `PATH`. If GUI launches do not inherit your Node path, drop `{"node": "/path/to/node"}` at `~/.config/herdr-app/mods/insights/runtime.json`.
- **`fleet-quota`:** Intentionally kept in `dotfiles` (not this repo) because it is tightly coupled to the Linux `herdr-fleet-quota-refresh` systemd producer.
