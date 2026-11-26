# Herdr Layout Recipe — `glass`

This repository packages the `glass` and `glass-insights` Herdr App layouts, themes, other layouts, and all the mods they use (original, forked and vendored third-party), following the `herdr-layout` layout-pack convention.

## Compatibility

- **Herdr App:** `>= 0.1.16` (relies on shipped mods `workspace-chrome`, `workspace-status`, `worktree`, `agents`, and `picker` — none of which are overwritten by this pack).
- **Platforms:** Linux and macOS.
- **Provenance:** See [`PROVENANCE.md`](./PROVENANCE.md) for forked mods, base commits, and the third-party mods shipped unchanged (commits in `vendor.json`).

## Contents

- `layouts/`
  - `glass.json` — main translucent glass layout with sidebar rail, T3 inbox stack, right panel (`better-files`, `better-changes`, `markdown-browser`, `web-browser`, `branch-pr`, `ci-dash`, `over9k-prompts`), `usage-limits` bar, and background daemons (`tui-prefix`, `agent-names`, `agent-resume`, `quota-resume`, `goto`).
  - `glass-insights.json` — variant with compact sidebar footer height tuned for Insights workflows.
  - `omarchy.json`, `omarchy-next.json` — our other layouts.
  - `cockpit.json`, `herdr-t3.json` (+ `herdr-t3.svg`), `workspace.json` (+ `workspace.svg`) — third-party layouts shipped unchanged. The `.svg` files are layout previews and are copied with the `.json`.
- `themes/`
  - `omarchy.json`
  - `catppuccin.json`
- `mods/` — every mod the layouts use: original mods, forks, and third-party mods shipped unchanged (see `PROVENANCE.md`). The third-party content is copied by `scripts/vendor.mjs` from the commits in `vendor.json`.
- `requirements.json` — the programs the mods run, with install hints, plus the pinned `branch-pr` helper. `scripts/install.sh` reads it.
- `scripts/install.sh` — installs the pack into the Herdr App home (see Installation).
- `keys.fragment.json` — the `ctrl-space` prefix map (`ctrl-space ?` opens the cheatsheet), recommended `layout:glass*` and mod-scoped keybinding fragments, plus a `terminal` section that hands `ctrl-n` to the focused program, so Neovim keeps completion (Herdr App bindings cannot depend on the program, herdrdev/herdr-app#745), and binds `ctrl-left`/`ctrl-right` everywhere to `tui-prefix.prev-subagent`/`next-subagent`, which cycle the focused coordinator and its sub-agents; programs no longer get those keys. The merge is add-only, so an existing keys.json keeps its own `ctrl-left`/`ctrl-right`. `ctrl-n` then no longer runs `agent.next` while a terminal has focus; bind `agent.next` to another key if you use it.

## Installation

### Script (recommended)

```bash
git clone https://github.com/mdiloreto/herdr-glass.git
cd herdr-glass
scripts/install.sh                 # report only, writes nothing
scripts/install.sh --apply         # install or update the pack
scripts/install.sh --yes           # optional: --apply, then install missing programs
herdr-app do layout.switch --name glass
```

Options:

- `--check`: the default. Reports what is missing or out of date. Exits 0 when nothing is, 1 otherwise.
- `--apply`: installs or updates the pack's mods, layouts and themes in the app home. Merges `keys.fragment.json` into `keys.json` add-only (backup `keys.json.bak-herdr-glass-<time>`). Builds the `branch-pr` helper at its pin, writes `mods/insights/runtime.json`, and runs `herdr-app check` on each mod it installed or updated. It never installs programs. It never overwrites Herdr App's shipped items, items it did not install, or files edited locally: it reports them. Ownership is recorded in `<app-home>/.herdr-glass.json`.
- `--yes`: `--apply`, then installs missing programs. It uses brew on macOS, and pacman, apt-get or dnf with sudo on Linux. For `terminal-browser` it runs the installer from `https://terminal-browser.sh/install` with `TERMINAL_BROWSER_SKIP_SETUP=1`, so it adds no agent skills.
- `--link`: symlinks mods to this checkout instead of copying them. Use it for a checkout kept current with `git pull`.
- `--no-keys`: leaves `keys.json` alone.
- `--app-home DIR`: the Herdr App home. Default: `$HERDR_APP_HOME` or `~/.config/herdr-app`.

For agents following Herdr's layout-sharing convention: run `scripts/install.sh` first and show the person the report. Get the person's yes before `--apply`, because it fetches and builds the `branch-pr` helper and adds global bindings to `keys.json`, and again before `--yes`, which implies `--apply` and also runs package managers with sudo and downloads terminal-browser's installer.

### Via `dotfiles-plugins`

This pack is tracked under `config.plugins.herdr-glass` in `mdiloreto/dotfiles`:

```bash
# Sync from remote main (cloned into ~/.local/share/dotfiles-plugins/herdr-glass)
dotfiles-plugins sync --only herdr-glass

# Or develop directly against a local clone
HERDR_LAYOUT_ROOT=~/vscode/herdr-glass dotfiles-plugins sync --only herdr-glass
```

`dotfiles-plugins` symlinks each mod listed in `modDirs` from the clone into `~/.config/herdr-app/mods/` (and runs `touch -h` on the links after a pull so Herdr reloads them). It still copies the listed layouts and themes, refusing to overwrite Herdr App shipped files (`layouts/main.json`, `layouts/.state/`, shipped mods, etc.). An existing mod directory is replaced by the link only when it is byte-identical to the clone's copy. After its sync, dotfiles now runs `scripts/install.sh --apply --link --no-keys`.

### Manual installation

1. Copy `layouts/*.json` and `layouts/*.svg` into `~/.config/herdr-app/layouts/`.
2. Copy `themes/*.json` into `~/.config/herdr-app/themes/`.
3. Symlink or copy each folder in `mods/` into `~/.config/herdr-app/mods/`. `fleet-quota` stays outside the pack (see `PROVENANCE.md`). `scripts/install.sh --apply` also builds the `branch-pr` helper and writes `mods/insights/runtime.json`. By hand, follow `helpers` in `requirements.json` for the helper and put this machine's absolute Node path in `mods/insights/runtime.json`.
4. Merge the sections from `keys.fragment.json` into `~/.config/herdr-app/keys.json`. Add the keys into a section that already exists (such as `terminal`) instead of replacing it, so its other bindings survive.
5. Select `glass` (or `glass-insights`) via `layout.switch` in Herdr App.

## Prerequisites

[`requirements.json`](./requirements.json) lists every program the mods run, which mods need it, and how to install it. `scripts/install.sh` reports the missing ones.

`fleet-quota` is intentionally kept in `dotfiles` (not this repo) because it is tightly coupled to the Linux `herdr-fleet-quota-refresh` systemd producer. Only `layouts/omarchy.json` references it, and the installer warns about it.

## License

MIT, see [`LICENSE`](./LICENSE). Forked mods keep their upstream licenses: see [`NOTICE`](./NOTICE) and [`LICENSES/`](./LICENSES/).
