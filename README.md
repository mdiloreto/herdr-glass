# herdr-glass

A translucent [Herdr App](https://github.com/herdrdev/herdr-app) layout for working with coding agents: spaces and agents on the left, files, diffs, pull requests and CI on the right, usage limits along the bottom.

![The glass layout: spaces and agents in the sidebar, an agent and a shell side by side, the Changes panel open](docs/images/hero.webp)

The screenshots show made-up demo data in an isolated Herdr App on Linux, with the translucent window placed over a sample wallpaper. Blur behind the window depends on your system.

## Features

### Spaces, agents and Inbox

Group spaces into colored folders. Below them, agents are sorted into Needs you, Done, Working and Idle, with sub-agents nested under the agent that started them. `ctrl-space i` swaps the sidebar for an Inbox where you can settle or snooze agents.

<img src="docs/images/sidebar.webp" alt="Sidebar with space folders and grouped agents, next to the Inbox view" width="556">

### Changes

Stage, commit and amend, browse commit history, and open diffs inline or side by side. It does not fetch, pull, push or discard.

![A diff in the middle tab with staged and unstaged files in the Changes panel](docs/images/changes.webp)

### Files

A read-only tree of the focused pane's folder with git status marks and a file viewer. Right-click a file to send its path and a prompt to an agent.

![The Files panel with a source file open in the viewer](docs/images/files.webp)

### Markdown

Lists the repository's Markdown files (outside a repository, those up to four folders deep) and the ones your terminal mentioned. Opens a rendered preview beside the pane, with a source view that can edit and save files on this machine.

![A rendered README beside an agent, with the Markdown file list](docs/images/markdown.webp)

### Web

Lists listening ports, leaving out those of agents and some other apps. Pick one, type a URL, or click a localhost link in a terminal to open it with [terminal-browser](https://terminal-browser.sh) in a pane beside your agent.

<img src="docs/images/web.webp" alt="Web panel listing a local development server on port 5173" width="380">

### Pull requests and CI

For GitHub, through `gh`. Read a pull request's description, comments and checks, then comment or merge. Watch Actions runs, rerun, cancel or dispatch them, and download artifacts.

<img src="docs/images/github.webp" alt="A pull request with its reviewers next to a list of GitHub Actions runs" width="800">

### Timeline

Your prompts to the focused Claude Code agent, each with its duration, output tokens, files changed and commands run.

<img src="docs/images/timeline.webp" alt="Timeline panel listing four prompts with their duration and tokens" width="380">

### Usage limits

Claude and Codex rate-limit windows in the bottom bar; hover for reset times. OpenCode and Pi show token spend instead. Every five minutes the bar asks the `claude` and `codex` command line tools for these numbers, so install and sign in to the ones you want shown.

<img src="docs/images/usage.webp" alt="Usage card with five-hour and weekly limits above the bottom bar" width="720">

### Insights

A token dashboard built from Claude Code, Codex, OpenCode, Pi and Antigravity logs: daily history, streaks and top models. It counts tokens, not cost. With other machines connected, it also shows the Insights results cached on them.

![Insights tab with token totals and a daily heatmap](docs/images/insights.webp)

### Go to anything

`ctrl-space space` (or `ctrl-shift-k`) searches agents, panes, tabs and spaces, with a preview of the highlighted terminal.

<img src="docs/images/goto.webp" alt="Search popup listing agents and tabs with a terminal preview" width="800">

### More

- `ctrl-space w` picks a space and `ctrl-space alt-t` shows the session tree.
- `ctrl-space ?` shows a cheat sheet of prefix keys. It does not list the keys specific to `glass`; see [`keys.fragment.json`](./keys.fragment.json).
- `ctrl-space r` shows every agent grouped by stage, with recaps for Claude Code sessions. Opening it downloads [herdr-recap](https://github.com/mrolafsson/herdr-recap) (with `curl`, from its GitHub releases) onto each machine running Claude Code, and has it write out-of-date recaps by asking Claude under your account.
- On Linux, a desktop notification tells you when an agent needs you or finishes.
- When a terminal on this machine comes back as a bare shell, for example after a restart, the pack types the command that resumes its Claude Code session. This needs the `claude.session` terminal label, set by a statusline or hook that the pack does not ship.
- Tabs name themselves after what runs in them. Read [what that sends](#what-tab-naming-does-and-sends).

<img src="docs/images/tree.webp" alt="Session tree listing spaces, tabs and agents with a terminal preview" width="720">

<img src="docs/images/spaces.webp" alt="Space picker showing each space's branch, folder and agent states" width="480">

## What tab naming does and sends

The `agent-names` mod runs in the background of the `glass`, `glass-insights`, `omarchy` and `omarchy-next` layouts.

**It also renames tabs you named.** Your name is passed along as a hint and may be replaced: right away for names that existed before the layout first loaded, after 10 minutes for names you type later. Tabs holding only idle shells keep your name.

**What it sends.** When a tab's panes change, usually at most once every 10 minutes per tab: the space name, any name you typed, and for each pane the program, status, session or terminal title (a shell's title can include your user name, host and path), current step, folder and branch. For up to two panes per tab that run an agent or report a status, and have no title or step, it also reads the last 40 lines on screen and sends up to 480 characters of each.

**Where it goes.** It tries these command line tools in order until one gives a usable name:

1. `agy` (a Gemini model)
2. `opencode`, with up to two of the free models listed in `~/.local/state/hierarchical-implementation/free-models.json`; skipped without that file
3. `claude` (Haiku)
4. for a tab on another machine, `claude` on that machine

Every tool it tries receives the text, even if its answer is not used, and passes it to that tool's provider under your account. If none gives a name, a local rule does. After an `agy` call the mod deletes the conversation files that call created; `agy` keeps a summary entry.

**Tab cleanup.** The mod marks unused shell tabs on this machine `· stale` and closes them after 24 hours of the app running, never the focused tab or a space's last one. It logs closed tabs to `~/.local/state/herdr-tab-cleanup.log`.

**To turn it off**, which also stops the cleanup and the session titles in pane headers, run this with the layout shown, then restart Herdr App:

```bash
herdr-app do layout.hide --id agent-names-daemon
```

Repeat it in each layout you use (`glass`, `glass-insights`, `omarchy`, `omarchy-next`). `layout.show` with the same `--id` turns it back on.

## Install

Start Herdr App once, then:

```bash
git clone https://github.com/mdiloreto/herdr-glass.git && herdr-glass/scripts/install.sh --apply
```

Then switch to the layout:

```bash
herdr-app do layout.switch --name glass
```

On macOS, if `herdr-app` is not on your PATH, use `/Applications/Herdr.app/Contents/MacOS/Herdr`.

`--apply` installs the mods, layouts and themes, builds the pull request helper from source it fetches from `munza/herdr-mods` on GitHub at a pinned commit, and adds keybindings to `keys.json`: a `ctrl-space` prefix (press it twice to send it to the terminal) and a few others. It only adds bindings, keeps yours where they clash, and backs the file up first. It never installs programs, and never overwrites a mod, layout or theme that it did not install or that you edited. It lists what is missing or skipped and exits with status 1 while anything is.

| Option | Effect |
| --- | --- |
| none | Report only, write nothing |
| `--apply` | Install or update the pack |
| `--yes` | `--apply`, then install missing programs (uses sudo on Linux and may run terminal-browser's installer) |
| `--apply --no-keys` | Install and leave `keys.json` alone |
| `--apply --link` | Install the mods as symlinks to the checkout |

To update, run `git -C herdr-glass pull`, then `herdr-glass/scripts/install.sh --apply`. [`RECIPE.md`](./RECIPE.md) covers the other options and manual installation.

## Requirements

Herdr App 0.1.16 or later, on Linux or macOS. The installer reports most missing programs and how to get them. On Linux, check `lsof`, `notify-send` and `setsid` yourself.

| Program | Used for |
| --- | --- |
| `git` | Branches, changes and files |
| `gh`, signed in | Pull requests and CI |
| Node.js 22.15 or later | Installer and Insights |
| `python3` | Timeline, Codex session figures in the usage bar, image previews on Linux |
| `hc` | Usage limits (ships with Herdr App) |
| `claude`, `codex`, `opencode` (optional) | Usage bar, for the tools you use |
| `terminal-browser` | Web pages, on the machine that opens them. On Linux its installer may ask for extra system libraries |
| `lsof` on this machine, `ss` on remote Linux machines | The Web panel's port list |
| `notify-send`, `setsid` | Desktop notifications on Linux |
| Go | Building the pull request helper once |

## Customize

- **Layouts.** `glass-insights` is `glass` with a shorter sidebar footer.
- **Themes.** The pack adds `omarchy` and `catppuccin`: `herdr-app do app.theme --name catppuccin`.
- **Your own copy.** `herdr-app do layout.clone --name glass --as my-glass`, then edit `layouts/my-glass.json` in `~/.config/herdr-app`: colors, gradient, `window_blur`, panel buttons. To keep the layout's own keys, copy the `layout:glass` section of `keys.json` to `layout:my-glass`.
- **Hide a block.** `herdr-app do layout.hide --id usage-limits`.
- **Keys.** [`keys.fragment.json`](./keys.fragment.json) lists every binding the pack adds. It also hands `ctrl-n`, `ctrl-left` and `ctrl-right` to the terminal program (your own bindings win), so `ctrl-n` no longer jumps to the next agent while a terminal has focus.

Other layouts in the pack:

| Layout | What it is |
| --- | --- |
| `omarchy`, `omarchy-next` | Our opaque layouts. `omarchy` also needs the `fleet-quota` mod, which is not in the pack |
| `cockpit` | From [quaresc/cockpit](https://github.com/quaresc/cockpit), unchanged |
| `herdr-t3` | From [JinJieBeWater/herdr-t3](https://github.com/JinJieBeWater/herdr-t3), unchanged |
| `workspace` | From [tahadx/workspace](https://github.com/tahadx/workspace), unchanged |

## Develop

Check a mod with Herdr App, and run the pack's tests, including the check that `requirements.json` lists every program the mods run:

```bash
herdr-app check mods/<mod-name>
node --test tests/*.test.cjs
```

## Credits

Much of this pack is other people's work. [`PROVENANCE.md`](./PROVENANCE.md) records the sources, commits and changes.

| Source | What comes from it | License |
| --- | --- | --- |
| [munza/herdr-mods](https://github.com/munza/herdr-mods) | `better-alerts`, `better-changes`, `better-files`; our forks `better-tabs`, `branch-pr`, `better-sidebar-rail`, `rail-next` | Apache-2.0 |
| [JinJieBeWater/herdr-t3](https://github.com/JinJieBeWater/herdr-t3) | The `t3-*` mods, including the Inbox, and the `herdr-t3` layout | Apache-2.0 |
| [tahadx/workspace](https://github.com/tahadx/workspace) | `agents-list`, `footer`, `hoverfocus`, `icons`, `shortcuts`, `sidebar-menu`, `terminals-list`, `worktrees`, and the `workspace` layout | MIT |
| [quaresc/cockpit](https://github.com/quaresc/cockpit) | The `cockpit` mod and layout, which bundle Apache-2.0 and MIT code and ISC [Lucide](https://github.com/lucide-icons/lucide) icons ([notices](./LICENSES/quaresc-cockpit.THIRD_PARTY_NOTICES.md)) | MIT and bundled licenses |
| [linziyanleo/herdr-mods](https://github.com/linziyanleo/herdr-mods) | `preview-plus` ([notices](./mods/preview-plus/THIRD_PARTY.md)) | MIT and bundled licenses |
| [nozikov/herdr-usage-limits](https://github.com/nozikov/herdr-usage-limits) | `usage-limits` | MIT |
| [mdiloreto/usage-insights](https://github.com/mdiloreto/usage-insights), a fork of [harshcurious/usage-insights](https://github.com/harshcurious/usage-insights) | `insights` | MIT |
| [dougcunha/herdr-mods](https://github.com/dougcunha/herdr-mods) | `ci-dash`, which bundles the ISC `yaml` library ([notice](./mods/ci-dash/yaml.LICENSE)) | MIT and ISC |
| [mrolafsson/herdr-recap](https://github.com/mrolafsson/herdr-recap) | `recap` | MIT |
| [herunan/herdr-over9k](https://github.com/herunan/herdr-over9k) | Our fork `over9k-prompts` (Timeline) | MIT |
| [ohneda/herdr-markdown-browser](https://github.com/ohneda/herdr-markdown-browser) | Our fork `markdown-browser` | MIT |
| [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app) | Our forks `space-folders`, `space-folders-next` | Apache-2.0 |

## License

Original work is MIT, see [`LICENSE`](./LICENSE). Forked and vendored mods keep their upstream licenses: see [`NOTICE`](./NOTICE) and [`LICENSES/`](./LICENSES/).
