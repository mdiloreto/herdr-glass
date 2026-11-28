# Mod provenance

Licenses and attribution: [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), [`LICENSES/`](./LICENSES/).

## Original mods (MIT)

Parts of `goto`, `tui-goto`, `tui-prefix` and `tui-spaces` come from third parties and keep their license: see [Third-party code in these mods](#third-party-code-in-these-mods).

| Mod | What it does |
| --- | --- |
| `agent-names` | Zero-size daemon syncing agent names. |
| `agent-resume` | Runtime `${HERDR_CLAUDE_BIN:-claude}` resume daemon (portable, no templates). |
| `fleet-resources` | Zero-size daemon alerting on CPU, memory and disk spikes and unanswering machines, on every connected machine. Its hold and recovery state machine is modeled on [ananjaemin/herdr-health-watch](https://github.com/ananjaemin/herdr-health-watch) `mods/health-watch/engine.js` at `de41f5a1db48e46af0ae300b1b4cb5488758c601` (MIT, `LICENSES/ananjaemin-herdr-health-watch.txt`); no code is copied. Its macOS Memory Used formula follows `mods/vitals/stats.js` (Apache-2.0, see `mods/vitals/NOTICE`); no code is copied. |
| `goto` | Workspace/tab jump and move daemon plus overlay. |
| `quota-resume` | Zero-size daemon detecting rate-limited Claude Code, Codex, and OpenCode sessions on its own machine and resuming them after quota reset. Experimental, off by default. |
| `tui-goto` | Tree session navigator overlay. |
| `tui-prefix` | Ctrl+Space TUI prefix daemon and cheatsheet overlay. |
| `tui-spaces` | Spaces picker overlay. |
| `web-browser` | Web pages in a terminal pane beside the agent, via `terminal-browser`. |
| `where` | Active machine/space breadcrumb. |

## Third-party code in these mods

All Apache-2.0. Line ranges are those of this repository's files and of the upstream files compared: `JinJieBeWater/herdr-t3` at `17bbad1f7206ce4c5fb165059976887fde6a0fbc` and `herdrdev/herdr-app` at `v0.1.16` (`034f8b85f7e6bb71f8ff55cb4a80c548b2578c0f`). Neither is a recorded copy point. Short generic lines that only look alike, such as imports and closing the popup, are not listed.

| Our file and lines | Upstream file and lines | What it is |
| --- | --- | --- |
| `mods/goto/name.js` (whole file) | `herdr-t3:mods/t3-picker/name.js` | Pane namer; we put the agent's session label first |
| `mods/goto/zoom.js` 5-11 | `herdr-t3:mods/t3-picker/zoom.js` | Unzoom before focusing a pane |
| `mods/goto/main.js` 399-400, 403, 417-419, 427-428 | `herdr-t3:mods/t3-picker/main.js` 100-101, 102, 115-117, 123-124 | Key hints, popup frame, search row, footer |
| `mods/goto/rows.js` 47-50 | `herdr-t3:mods/t3-picker/main.js` 71 | Blocked mark |
| `mods/goto/rows.js` 61-62 | `herdr-t3:mods/t3-picker/main.js` 19-20 | Terminal icon and tinted program icon |
| `mods/goto/rows.js` 87-88, 97 | `herdr-t3:mods/t3-picker/main.js` 74-75, 92 | Row label for screen readers, selection, Back tag |
| `mods/goto/rows.js` 46 | `herdr-app:defaults/mods/agents/main.js` 211 | Working mark |
| `mods/goto/rows.js` 51-52 | `herdr-app:defaults/mods/agents/main.js` 215-216 | Idle and done marks |
| `mods/goto/rows.js` 66-80 | `herdr-app:defaults/frame/palette/main.js` 187-203 | Lit matched letters |
| `mods/goto/score.js` 17-33 | `herdr-app:defaults/frame/palette/main.js` 113-129 | `fuzzy()`, with `export` added |
| `mods/tui-goto/main.js` 30-64 | `herdr-app:defaults/mods/picker/main.js` 11-35 | Space colors |
| `mods/tui-goto/main.js` 143-162 | same file, 49-60 | Popup state and machine list |
| `mods/tui-goto/main.js` 311-323 | same file, 70-76 | Sub-agent count |
| `mods/tui-goto/main.js` 605-618 | same file, 120-123 | Status glyph |
| `mods/tui-goto/main.js` 945-970 | same file, 133-154 | Keeping the selection in view |
| `mods/tui-goto/main.js` 1006-1018 | same file, 189-202 | New tab and new space rows |
| `mods/tui-goto/main.js` 1055-1066 | same file, 167 | Space tile |
| `mods/tui-goto/main.js` 1119-1161 | same file, 208-224 | Tab row |
| `mods/tui-goto/main.js` 1234-1242 | same file, 227-235 | Popup frame |
| `mods/tui-goto/main.js` 1494-1528 | same file, 252-254 | Search box |
| `mods/tui-goto/main.js` 1562-1600 | same file, 258-274 | List and wheel scrolling |
| `mods/tui-prefix/main.js` 46, 48-51 | `herdr-app:defaults/mods/agents/main.js` 52, 55-58 | Status rank and a sub-agent's status |
| `mods/tui-spaces/main.js` 25-59 | `herdr-app:defaults/mods/picker/main.js` 11-35 | Space colors |
| `mods/tui-spaces/main.js` 86-112 | same file, 41-61 | Filter input and machine list |
| `mods/tui-spaces/main.js` 302-324 | same file, 141-154 | Keeping the selection in view |
| `mods/tui-spaces/main.js` 360-399 | same file, 187-219 | Row layout |
| `mods/tui-spaces/main.js` 408-420 | same file, 167 | Space tile |
| `mods/tui-spaces/main.js` 479-487 | same file, 227-235 | Popup frame |
| `mods/tui-spaces/main.js` 488-506 | same file, 236-249 | Keyboard handling |
| `mods/tui-spaces/main.js` 543-601 | same file, 251-275 | Search box and scrolling list |

## Icons in `goto`

`mods/goto/icons/git-branch.svg` and `layers.svg` are identical to icons Herdr App ships, and `search.svg` and `terminal.svg` to icons in `herdr-t3`'s picker. All four are [Lucide](https://github.com/lucide-icons/lucide) icons (ISC; `search.svg` and `terminal.svg` are also on its list of Feather-derived icons, under MIT). Both notices are in `LICENSES/nozikov-herdr-usage-limits.lucide.txt`. `home.svg` matched no third-party copy compared.

## Forked mods shipped here

The base commit is the closest match found, not a recorded fork point.

| Mod | Upstream (repo:path) | Base commit | License | What we changed |
| --- | --- | --- | --- | --- |
| `better-tabs` | `munza/herdr-mods:better-tabs/mods/better-tabs` | `00fedb71cfb0151a790febbafe7ebbafd90b1dd5` | Apache-2.0 | Added a `mod-tab` toolbar action, width-aware toolbar overflow, and publishing of tab drags so the spaces sidebar can take a drop. |
| `branch-pr` | `munza/herdr-mods:branch-pr/mods/branch-pr` | `02b4a5cc4aef67bd5340d1e92eef934a18f10b5a` | Apache-2.0 (`main.js` only; its Go helper is built from `munza/herdr-mods` `9bd1f7e9a55a264563bfd82d2552502fda1cca6d`) | A Claude Code pane's folder follows its statusline `claude.cwd` label instead of the process folder. |
| `better-sidebar-rail` | `munza/herdr-mods:better-sidebar/mods/better-sidebar` | `aa4e6115c70f08b17848d37647ccd4752abe1257` | Apache-2.0 | Added `bot`/`home` icons, fixed agent-to-pane title matching, publishes the agent order, restyled space avatars. |
| `rail-next` | `munza/herdr-mods:better-sidebar/mods/better-sidebar` | `aa4e6115c70f08b17848d37647ccd4752abe1257` | Apache-2.0 | Same base as `better-sidebar-rail` with further agent-view and avatar changes and a `ring-gap` icon. |
| `over9k-prompts` | `herunan/herdr-over9k:over9k-timeline/mods/over9k-prompts` | `6c595d3e16d9706026b3bc42c854f83755d8d7e2` | MIT | `mod.json` only: panel placement changed to `none`. |
| `markdown-browser` | `ohneda/herdr-markdown-browser:mods/markdown-browser` | `bb1f3c76882266837662b2f253a241c3ee94463a` | MIT | Added terminal-mention discovery (`mentions.js`), a quick-picker overlay, opening files in `preview-plus`, and a Cmd-click link handler (`link.js`) that opens `.md` links in `preview-plus` on this computer and on remote machines. |
| `preview-plus` | `linziyanleo/herdr-mods:preview-plus/mods/preview-plus` | `9d8e0172da18902b18650951fe3f187e19964334` | MIT; bundles Apache-2.0, EPL-2.0 and BSD-2-Clause components (see `mods/preview-plus/THIRD_PARTY.md`) | The 10 s poll of a remote file reloads it only when its content changed, its read failed or the view shows an error, so the reader keeps their place. |
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
| `mrolafsson/herdr-recap` | MIT | `recap` |
| `JinJieBeWater/herdr-t3` | Apache-2.0 | `t3-actions`, `t3-agents`, `t3-chrome`, `t3-home`, `t3-inbox`*, `t3-menu`, `t3-new-menu`, `t3-pane`, `t3-picker`, `t3-spaces`, `t3-tabs` |
| `nozikov/herdr-usage-limits` | MIT; its panel icons are credited upstream to Lucide (ISC), see `LICENSES/nozikov-herdr-usage-limits.lucide.txt` | `usage-limits`* |
| `mdiloreto/usage-insights` (fork of `harshcurious/usage-insights`) | MIT | `insights`*, `usage-limits-fleet-canary`* (derived from `nozikov/herdr-usage-limits`, MIT; see its `LICENSE-THIRD-PARTY.md`) |
| `l4ci/herdr-mods` | Apache-2.0; its panel design and macOS parsers come from `ozcberkay/herdr-coban` (Apache-2.0), see `mods/vitals/NOTICE` | `vitals`* |

`fleet-quota` stays in `dotfiles`.

## Layouts

| Layout | Origin |
| --- | --- |
| `glass`, `glass-insights`, `omarchy`, `omarchy-next` | Ours (MIT). No upstream has them. |
| `cockpit` | Third-party, shipped unchanged from `quaresc/cockpit` (`vendor.json`). |
| `herdr-t3` | Third-party, shipped unchanged from `JinJieBeWater/herdr-t3` (`vendor.json`). |
| `workspace` | Third-party, shipped unchanged from `tahadx/workspace` (`vendor.json`). |

`omarchy.json` came from a `dotfiles` template; this is its Linux and macOS rendering, which includes the `fleet-quota` block.
