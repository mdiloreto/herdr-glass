# Mod provenance

Licenses and attribution: [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), [`LICENSES/`](./LICENSES/).

## Original mods (MIT)

| Mod | What it does |
| --- | --- |
| `agent-names` | Zero-size daemon syncing agent names. |
| `agent-resume` | Runtime `${HERDR_CLAUDE_BIN:-claude}` resume daemon (portable, no templates). |
| `goto` | Workspace/tab jump and move daemon plus overlay. |
| `quota-resume` | Zero-size daemon detecting rate-limited Claude Code, Codex, and OpenCode sessions (local and fleet) and resuming them after quota reset. |
| `tui-goto` | Tree session navigator overlay. |
| `tui-prefix` | Ctrl+Space TUI prefix daemon and cheatsheet overlay. |
| `tui-spaces` | Spaces picker overlay. |
| `web-browser` | Web pages in a terminal pane beside the agent, via `terminal-browser`. |
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

## Third-party mods shipped unchanged

`scripts/vendor.mjs` copies these from upstream, unmodified, at the commits and paths recorded in [`vendor.json`](./vendor.json). Do not edit them here; change `vendor.json` and rerun the script. Mods marked `*` are referenced by `layouts/glass.json` and `layouts/glass-insights.json`.

| Repo | License | Mods |
| --- | --- | --- |
| `tahadx/workspace` | MIT | `agents-list`, `footer`, `hoverfocus`, `icons`, `shortcuts`, `sidebar-menu`, `terminals-list`, `worktrees` |
| `munza/herdr-mods` | Apache-2.0 | `better-alerts`*, `better-changes`*, `better-files`* |
| `dougcunha/herdr-mods` | MIT | `ci-dash`* |
| `quaresc/cockpit` | MIT; bundles Apache-2.0 and MIT code and ISC (Lucide) icons, see `LICENSES/quaresc-cockpit.THIRD_PARTY_NOTICES.md`. Its OFL-1.1 fonts are only in upstream `docs/` and test fixtures, not in `mods/cockpit`; the OFL text is kept in `LICENSES/` for completeness. | `cockpit` |
| `linziyanleo/herdr-mods` | MIT; bundles Apache-2.0, EPL-2.0 and BSD-2-Clause components (see `mods/preview-plus/THIRD_PARTY.md`) | `preview-plus` |
| `mrolafsson/herdr-recap` | MIT | `recap` |
| `JinJieBeWater/herdr-t3` | Apache-2.0 | `t3-actions`, `t3-agents`, `t3-chrome`, `t3-home`, `t3-inbox`*, `t3-menu`, `t3-new-menu`, `t3-pane`, `t3-picker`, `t3-spaces`, `t3-tabs` |
| `nozikov/herdr-usage-limits` | MIT | `usage-limits`* |
| `mdiloreto/usage-insights` (fork of `harshcurious/usage-insights`) | MIT | `insights`* |

`fleet-quota` stays in `dotfiles`.

## Layouts

| Layout | Origin |
| --- | --- |
| `glass`, `glass-insights`, `omarchy`, `omarchy-next` | Ours (MIT). No upstream has them. |
| `cockpit` | Third-party, shipped unchanged from `quaresc/cockpit` (`vendor.json`). |
| `herdr-t3` | Third-party, shipped unchanged from `JinJieBeWater/herdr-t3` (`vendor.json`). |
| `workspace` | Third-party, shipped unchanged from `tahadx/workspace` (`vendor.json`). |

`omarchy.json` came from a `dotfiles` template; this is its Linux and macOS rendering, which includes the `fleet-quota` block.
