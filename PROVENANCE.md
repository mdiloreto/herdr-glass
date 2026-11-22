# Mod provenance

Licenses and attribution: [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), [`LICENSES/`](./LICENSES/).

## Original mods (MIT)

| Mod | What it does |
| --- | --- |
| `agent-names` | Zero-size daemon syncing agent names. |
| `agent-resume` | Runtime `${HERDR_CLAUDE_BIN:-claude}` resume daemon (portable, no templates). |
| `goto` | Workspace/tab jump and move daemon plus overlay. |
| `tui-goto` | Tree session navigator overlay. |
| `tui-prefix` | Ctrl+Space TUI prefix daemon and cheatsheet overlay. |
| `tui-spaces` | Spaces picker overlay. |
| `where` | Active machine/space breadcrumb. |

## Forked mods shipped here

The base commit is the closest match found, not a recorded fork point.

| Mod | Upstream (repo:path) | Base commit | License | What we changed |
| --- | --- | --- | --- | --- |
| `better-tabs` | `munza/herdr-mods:better-tabs/mods/better-tabs` | `00fedb71cfb0151a790febbafe7ebbafd90b1dd5` | Apache-2.0 | Added a `mod-tab` toolbar action, width-aware toolbar overflow, and publishing of tab drags so the spaces sidebar can take a drop. |
| `branch-pr` | `munza/herdr-mods:branch-pr/mods/branch-pr` | `02b4a5cc4aef67bd5340d1e92eef934a18f10b5a` | Apache-2.0 (`main.js` only; its Go helper is built from `munza/herdr-mods` `9bd1f7e9a55a264563bfd82d2552502fda1cca6d`) | A Claude Code pane's folder follows its statusline `claude.cwd` label instead of the process folder. |
| `better-sidebar-rail` | `munza/herdr-mods:better-sidebar/mods/better-sidebar` | `aa4e6115c70f08b17848d37647ccd4752abe1257` | Apache-2.0 | Added `bot`/`home` icons, fixed agent-to-pane title matching, publishes the agent order, restyled space avatars. |
| `rail-next` | `munza/herdr-mods:better-sidebar/mods/better-sidebar` | `aa4e6115c70f08b17848d37647ccd4752abe1257` | Apache-2.0 | Same base as `better-sidebar-rail` with further agent-view and avatar changes and a `ring-gap` icon. |
| `over9k-prompts` | `herunan/herdr-over9k:over9k-timeline/mods/over9k-prompts` | `6c595d3e16d9706026b3bc42c854f83755d8d7e2` | MIT | `mod.json` only: panel placement changed to `none`. |
| `markdown-browser` | `ohneda/herdr-markdown-browser:mods/markdown-browser` | `bb1f3c76882266837662b2f253a241c3ee94463a` | MIT | Added terminal-mention discovery (`mentions.js`), a quick-picker overlay, and opening files in `preview-plus`. |
| `space-folders` | `herdrdev/herdr-app:defaults/mods/spaces` | `8672b99da5b8e33c0f69a35e7a3e500777f1b8aa` | Apache-2.0 | Added space folders with drag-and-drop, rule-based collection and per-machine storage, and new avatar tints. |
| `space-folders-next` | `herdrdev/herdr-app:defaults/mods/spaces` | `8672b99da5b8e33c0f69a35e7a3e500777f1b8aa` | Apache-2.0 | `space-folders` plus follow-the-front-space folding, `goto` move requests and tab-drag drops. |

## Third-party mods used unchanged, not shipped here

`dotfiles` installs these from upstream at the pinned commits. Mods marked `*` are referenced by `layouts/omarchy-glass.json` and `layouts/omarchy-glass-insights.json`.

| Repo | Commit | Mods (path) |
| --- | --- | --- |
| `tahadx/workspace` | `069b5bf7d4be3158c121a0da719bba45db1ee830` | `agents-list`, `footer`, `hoverfocus`, `icons`, `shortcuts`, `sidebar-menu`, `terminals-list`, `worktrees` (`mods/<name>`) |
| `munza/herdr-mods` | `1abf4870adb4c3f7a71739db1e0c29493f5e3f95` | `better-alerts`* (`better-alerts/mods/better-alerts`) |
| `munza/herdr-mods` | `9bd1f7e9a55a264563bfd82d2552502fda1cca6d` | `better-changes`* (`better-changes/mods/better-changes`), `better-files`* (`better-files/mods/better-files`) |
| `dougcunha/herdr-mods` | `9e0b6e7126a7db608471acb9497159c7bd2fae53` | `ci-dash`* (`ci-dash-app/mods/ci-dash`) |
| `quaresc/cockpit` | `02c0ad112383a252db054ef471d6baa21ba8091c` | `cockpit` (`app/mods/cockpit`) |
| `linziyanleo/herdr-mods` | `9d8e0172da18902b18650951fe3f187e19964334` | `preview-plus` (`preview-plus/mods/preview-plus`) |
| `mrolafsson/herdr-recap` | `b2e25a779ad1b0260e3dcce3e39ee1974ad01382` | `recap` (`app/mods/recap`) |
| `JinJieBeWater/herdr-t3` | `17bbad1f7206ce4c5fb165059976887fde6a0fbc` | `t3-actions`, `t3-agents`, `t3-chrome`, `t3-home`, `t3-inbox`*, `t3-menu`, `t3-new-menu`, `t3-pane`, `t3-picker`, `t3-spaces`, `t3-tabs` (`mods/<name>`) |
| `nozikov/herdr-usage-limits` | `7ea49bbe49bef99786e965f88b5ca6b124bdd941` | `usage-limits`* (`mods/usage-limits`) |

`insights`* comes from `mdiloreto/usage-insights` (`mods/insights`) and is installed separately.
`fleet-quota` stays in `dotfiles`.
