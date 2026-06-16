<p align="center">
  <img src="./assets/logo.png" width="120" alt="Hive logo" />
</p>

# Hive

<p align="center">
  <img src="./assets/hive-hero.png" alt="Hive local-first multi-agent collaboration workspace hero image" />
</p>

**Run Claude Code, Codex, Gemini, OpenCode, Qwen, and other CLI agents as a visible local team.** Hive gives you one browser workbench where an
Orchestrator plans and delegates while workers implement, review, test,
research, and report back — all as real PTY processes on your laptop.

Use Hive when one agent is not enough, but a pile of terminal windows is not a workflow.

[![npm](https://img.shields.io/npm/v/@tt-a1i/hive.svg)](https://www.npmjs.com/package/@tt-a1i/hive)
[![ci](https://img.shields.io/github/actions/workflow/status/tt-a1i/hive/release.yml?branch=main&label=ci)](https://github.com/tt-a1i/hive/actions/workflows/release.yml)
[![Website](https://img.shields.io/badge/website-hivehq.dev-5a8a8a.svg)](https://hivehq.dev)
[![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-BUSL--1.1-orange.svg)](./LICENSE.BSL)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows%20(best--effort)-lightgrey.svg)](#platform-support)

🌐 **Website**: [hivehq.dev/en/](https://hivehq.dev/en/) · [中文](https://hivehq.dev/)

English · [简体中文](./README.zh.md)

> Hive is local-first, runs on `127.0.0.1`, and is intended for anyone who
> already runs CLI agents. The latest stable release is on
> [npm](https://www.npmjs.com/package/@tt-a1i/hive) and the badge above resolves
> to it.
>
> This repository is Hive's public source baseline. User-facing releases are
> distributed through npm; if you only want to install or upgrade Hive, prefer
> the npm commands below.

<p align="center">
  <img src="./assets/hive-team-view.png" alt="Hive workbench with a 4-agent team — orchestrator dispatching while workers run" />
</p>

## Why Hive

CLI agents are powerful, but coordinating several of them manually is
awkward:

- Long-running sessions are spread across terminals.
- Splitting work across agents — implementation/review/testing,
  research/drafting/fact-checking, or any other division of labor — needs a
  routing layer you don't have.
- Worker progress disappears into scrollback.
- Restart recovery depends on each CLI's native session behavior.

Hive adds the coordination layer without replacing the CLIs. The Orchestrator
is a real `agy` / `claude` / `codex` / `opencode` / `gemini` / `hermes` /
`qwen` process, not a scripted PM. Workers are real CLI agents too. Hive
injects a small `team` command into their shells, so they can dispatch,
report, and keep a shared markdown task graph at `<workspace>/.hive/tasks.md`.

## Use It For

**Ship a PR with a reviewer in the loop**

Ask the Orchestrator to implement a change, spawn a reviewer, and keep the
review feedback visible before you merge. The coder edits; the reviewer checks
the diff; the Orchestrator decides what still needs work.

```text
Ship the settings search bugfix. Use one worker to implement it and another to
review edge cases before the final report.
```

**Run a parallel bug hunt**

Give several workers separate slices of a flaky behavior: one reads the server
path, one checks the UI path, one looks for regressions in recent commits. You
watch the reports converge instead of juggling terminals.

```text
Find why mobile reconnect sometimes stalls. Split server transport, browser UI,
and recent commit history across separate workers.
```

**Research, draft, and fact-check without losing the thread**

Let one worker gather sources, another draft, and a reviewer check claims. The
task graph and reports stay in one workspace, so the handoff is inspectable
instead of trapped in chat scrollback.

```text
Write a technical note on our release flow. Have one worker collect evidence,
one draft, and one verify every command and file reference.
```

## Try the demo first

Don't have an agent CLI installed yet? Run `hive`, open the printed URL, and
click **Try Demo** in the first-run wizard. You get a fully client-side
preview — fake orchestrator + two workers, prerecorded scrollback, a
prefilled task list — without touching the server or any real CLI agent.
Useful for deciding whether to install a real CLI.

## Quick Start

Prerequisites:

- Node.js 22 or newer.
- At least one supported agent CLI installed, authenticated, and available on
  `PATH`.

Install and start Hive:

```bash
npm install -g @tt-a1i/hive
hive
```

If npm prints `npm warn allow-scripts` or `prebuild-install@7.1.3 deprecated`
during install, first check whether the command ends with `added ... packages`.
Those warnings usually come from npm's install-script review plus native
binary setup for `node-pty`, `better-sqlite3`, and `esbuild`; they do not mean
Hive failed to install. The troubleshooting section below breaks them down.

Open the printed local URL, usually `http://127.0.0.1:3000/`. Use
`hive --port 4010` when you need a specific local port.

To upgrade in place:

```bash
hive update
```

`hive update` runs `npm install -g @tt-a1i/hive@latest` in place. Restart any
in-flight Hive process to pick up the new version. If you installed Hive with
pnpm or yarn, upgrade through the same package manager — otherwise the new
npm copy will shadow your existing install.

If your npm mirror has not synced the latest release yet, use the official
registry directly:

```bash
npm install -g @tt-a1i/hive@latest --registry=https://registry.npmjs.org
```

Install Hive as an app (optional):

Open `http://127.0.0.1:3000/` in Chrome, Edge, or Brave and click the install
icon at the right edge of the browser's omnibox. The PWA launches in its own
dock-anchored window without browser chrome and shows **Add Workspace** /
**Try Demo** shortcuts from the dock right-click menu. Firefox and Safari
currently don't implement the install-prompt protocol, so the omnibox icon
only appears in Chromium-based browsers.

The Hive daemon must still be running for the PWA to do anything; if the
runtime isn't reachable when you launch the app, you'll see a "Hive runtime
is not running" page that auto-reloads once `hive` is back on `127.0.0.1`.
The PWA install scope is keyed by origin, so `hive --port 4011` installs as
a separate app from `hive --port 3000`. To uninstall, visit `chrome://apps`,
right-click the Hive tile, and choose **Remove from Chrome…**.

Hive asks the browser to confirm before closing the tab or PWA window so an
accidental close shortcut (Cmd-W on macOS, Ctrl-W on Windows/Linux) doesn't
drop your session. Modern browsers gate that prompt on prior page interaction
— if you open the PWA and immediately press the close shortcut without
clicking or typing anywhere first, it still closes cleanly. That's a browser
policy, not a Hive bug.

First-run flow:

1. Create a workspace from a project folder.
2. Choose an Orchestrator preset.
3. Hive creates `<workspace>/.hive/tasks.md`, starts the Orchestrator PTY, and
   injects the internal `team` command into the agent session.
4. Add workers from the Team Members panel.
5. Ask the Orchestrator to delegate work. It sends tasks with
   `team send <worker-name> "<task>"`; workers report back with `team report`.

If you want the Orchestrator to size the team itself, leave **Auto-staff**
enabled (it is on by default). It can `team spawn` the right temporary mix of
coders, testers, and reviewers for the task, then Hive dismisses those
temporary workers when their work is done.

For stronger automation, enable the experimental **Workflows** toggle in
settings. The Orchestrator can then author and run multi-agent workflows that
fan out across implementation, review, testing, or other stages. The topbar
**Workflows** panel shows runs, phase results, logs, schedules, and stop
controls. The same panel also lets you choose which CLI workflow-created
agents use by default and which CLIs they are allowed to use.

## How It Works

```text
Browser UI on 127.0.0.1
  tasks, team, terminals, reports
          |
          | HTTP + WebSocket
          v
Hive runtime
  SQLite metadata, PTY lifecycle, task dispatch
          |
          +-- Orchestrator PTY
          |     can call: team send, team list, team report
          |
          +-- Worker PTY
          |     can call: team report
          |
          +-- Worker PTY
                can call: team report

Workspace task graph:
  <workspace>/.hive/tasks.md
```

Three details matter:

- Agents are real CLI processes, not simulated subagents.
- `team` is injected only inside Hive-managed agent sessions by prepending the
  package's internal bin directory to `PATH`; it is not installed as a global
  command.
- The task graph is a markdown file in the workspace, so you can inspect or
  edit it outside the app.

## Agent Presets

| Preset | Command expected on `PATH` | Default bypass mode | Session resume |
| --- | --- | --- | --- |
| Antigravity CLI | `agy` | `--dangerously-skip-permissions` | `--conversation <session_id>` |
| Claude Code | `claude` | `--dangerously-skip-permissions`, `--permission-mode=bypassPermissions` | `--resume <session_id>` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` | `resume <session_id>` |
| OpenCode | `opencode` | Config-driven in `~/.config/opencode/opencode.json` | `--session <session_id>` |
| Gemini | `gemini` | `--yolo` | `--resume <session_id>` |
| Hermes | `hermes` | `--yolo` | `--resume <session_id>` |
| Qwen Code | `qwen` | `--approval-mode yolo` | `--resume <session_id>` |
| Cursor CLI | `cursor` | `--force` | Session id capture not wired yet |
| Grok Build | `grok` | `--always-approve` | Session id capture not wired yet |
| Custom | Any executable | User configured | User configured |

Hive does not install these CLIs for you. Install and authenticate them in the
same shell environment you use to start Hive.

## What Hive Provides

- Workspace sidebar for switching between local projects.
- Orchestrator and worker terminals backed by real PTYs.
- Add Worker flow with role presets for coder, reviewer, tester, and fully
  custom prompts and commands — wire any CLI agent into the role you need.
- Auto-staff (experimental, on by default): the Orchestrator can create
  temporary coders, testers, and reviewers based on the task, and Hive cleans
  them up after their dispatch reports back.
- Workflows (experimental, off by default): the Orchestrator can run
  multi-stage, multi-agent workflows while Hive shows runs, logs, results,
  schedules, and stop controls in the Workflows panel.
- Workflow CLI policy: choose the default CLI for workflow-created agents and
  restrict which CLIs workflow scripts may launch.
- Team memory: keep workspace constraints, long-running context, and team
  decisions in Hive so later dispatches can carry the right background.
- `.hive/tasks.md` editor with external-file conflict handling.
- Background PTY preservation and best-effort native session resume.
- A What's New dialog after upgrades with curated release highlights.
- Local SQLite metadata under `%APPDATA%\hive` on Windows and `~/.config/hive`
  on macOS / Linux by default, or `$HIVE_DATA_DIR` when set.

Hive does not provide sandboxing, multi-user auth, or any bundled agent model.
It coordinates the CLIs you already run locally.

## Remote Access (optional, off by default)

If you want to reach your running Hive from your phone while you're away,
enable optional **Remote access**. After the phone signs in and pairs with the
desktop, it reaches the Hive Web UI through an end-to-end encrypted tunnel.
A paired phone is a trusted device with the same authority as the local desktop
browser.

Important boundaries:

- **Off by default.** If you never enable Remote access, Hive remains
  local-first.
- **A gateway is required.** Hive relays the phone-to-daemon connection through
  a gateway; your machine connects outbound and does not require opening a
  public port.
- **Data and execution stay local.** The gateway routes authenticated
  connections; it does not run your agents or store workspace contents.
- **The desktop is the trust root.** New device pairing must be confirmed at
  the computer. A paired phone cannot approve another device by itself, and
  devices can be revoked at any time.

## Platform Support

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Tier 1 | Main development and release verification target. |
| Linux | Tier 1 | CI verified. Native folder picking expects `zenity`; manual path entry works without it. |
| Windows | Tier 2 | CI runs a Windows test subset and a packaged-install smoke. Folder picking uses the in-browser server filesystem browser and the package includes `team.cmd`. Treat as best-effort — full Windows verification before each release is manual. |

All platforms require Node.js 22+. Hive depends on native packages
(`node-pty` and `better-sqlite3`), so native install tooling may be required
when prebuilt binaries are unavailable.

## Safety Model

Hive is a local development tool, not a hosted service.

- When Remote access is off, the runtime binds to `127.0.0.1`. Do not expose
  the Hive port through a public tunnel, reverse proxy, or shared network
  interface.
- When Remote access is on, paired phones have the same authority as the local
  browser. Pair only devices you trust, and revoke or disable Remote access
  when you no longer need it.
- Built-in presets intentionally use each CLI's non-interactive or bypass mode
  where available. Treat workers as able to run arbitrary shell commands inside
  the selected workspace.
- Open only trusted workspaces. A worker has the same filesystem access as the
  shell account running Hive.
- Agent tokens are session scoped, generated by the local runtime, injected into
  agent process environments, and not intended as internet-facing credentials.
- Hive has no multi-user authentication boundary. Treat same-machine processes
  that can reach the local port as trusted local access.
- The browser UI token is a local session guard, not protection against other
  processes already running as your OS user.

Read [SECURITY.md](SECURITY.md) before using Hive with sensitive repositories.

## Data Locations

| Data | Location |
| --- | --- |
| Runtime metadata | Windows: `%APPDATA%\hive`; macOS / Linux: `~/.config/hive`; or `$HIVE_DATA_DIR` |
| Workspace tasks | `<workspace>/.hive/tasks.md` |
| Internal `team` command | Packaged under `dist/bin/`, injected into PTYs |
| Web UI assets | Served by the runtime from the packaged `web/dist` build |

## Troubleshooting

**Agent CLI not found**

Check that the selected command is installed, authenticated, executable from the
same shell, and available on `PATH`.

**Port already in use**

Start Hive with another local port:

```bash
hive --port 4020
```

**Version does not change after upgrading**

Check the latest version on the official npm registry:

```bash
npm view @tt-a1i/hive version --registry=https://registry.npmjs.org
```

If you use a mirror or private npm registry, it may lag behind the official
registry by minutes or hours. Upgrade directly from npmjs when you need the
freshest release:

```bash
npm install -g @tt-a1i/hive@latest --registry=https://registry.npmjs.org
```

After upgrading, stop the old `hive` process and run `hive --version` again.
If it still prints an older version, check `which hive` / `where hive`; PATH
usually points at another global install.

**Native package install fails**

Hive depends on `node-pty` and `better-sqlite3`, which use native binaries. Use
Node.js 22+, keep your package manager cache clean, and verify your platform
build tools are available.

If npm prints a deprecated warning for `prebuild-install@7.1.3`, it is safe to
ignore. The warning comes from `better-sqlite3`'s native binary download chain;
it is an upstream installer maintenance notice, not a Hive install failure, and
does not affect runtime behavior.

When installation succeeds but npm prints warnings, use the source to decide:

| warning | Source | What to do |
| --- | --- | --- |
| `allow-scripts @tt-a1i/hive` | Hive's postinstall fixes packaged native/PTY helper permissions. | Ignore after a successful install. |
| `allow-scripts better-sqlite3` | SQLite native bindings download a prebuilt binary or build locally. | Ignore after success; check build tools if install fails. |
| `allow-scripts node-pty` | Terminal PTY native bindings prepare the platform binary. | Ignore after success; check build tools if install fails. |
| `allow-scripts esbuild` | esbuild verifies/selects the current platform binary. | Ignore after success. |

This is npm 11's install-script review prompt. Today it is usually advisory;
future npm versions may require explicit approval. To inspect pending scripts,
run `npm approve-scripts --allow-scripts-pending`.

**Folder picker does not open on Linux**

Install `zenity`, or paste the workspace path manually.

**Folder picker on Windows**

Windows uses Hive's in-browser server filesystem browser when adding a
workspace. It starts from "This PC" and lets you enter drives such as `C:\` or
`D:\`. If the target folder is not listed, expand the advanced path entry and
paste the absolute path.

**`hive update` on Windows fails with `ENOENT mkdir ... C:\Program`**

Older Hive versions could quote a global npm prefix with spaces incorrectly
when running update. Upgrade manually:

```powershell
npm install -g @tt-a1i/hive@latest --registry=https://registry.npmjs.org
```

If your global npm directory is not on the default PATH, check the prefix:

```powershell
npm prefix -g
where hive
```

Then confirm `where hive` points at the copy you just upgraded.

**Codex terminal cannot scroll on Windows**

Upgrade to `2.0.2` or newer and restart Hive. Codex is a full-screen TUI, so it
usually will not show a browser-native scrollbar; Hive translates wheel,
PageUp, and PageDown input into terminal input Codex understands. Version
2.0.2 fixes saved Windows launch commands that still point at
`node.exe ...\@openai\codex\bin\codex.js`.

**Tasks file conflict banner appears**

Hive detected a newer `.hive/tasks.md` on disk. Use `Reload` to accept the file
from disk, or `Keep Local` to keep the editor contents and save again.

**Worker appears stuck in `working`**

Hive does not guess task completion from process activity. Workers move back to
`idle` when they call `team report`. If a worker is blocked, stop or restart it
from the UI.

## Development

```bash
pnpm install
pnpm dev
```

Development mode runs the runtime on `127.0.0.1:4010`; Vite runs on
`127.0.0.1:5180` and proxies API and WebSocket traffic to the runtime.

Useful checks:

```bash
pnpm check
pnpm build
pnpm test
```

Production-style local run:

```bash
pnpm build
node dist/src/cli/hive.js --port 4010
```

The production server serves the built web UI directly. No Vite server is
needed after `pnpm build`.

## Published Package

User installs and upgrades should follow
[`@tt-a1i/hive` on npm](https://www.npmjs.com/package/@tt-a1i/hive). The public
changelog records already-shipped user-facing changes; you do not need to build
from this repository just to use Hive.

## Status

Hive is in alpha. The current npm release includes multi-CLI agent presets,
Auto-staff, Workflows, team memory, PWA installation, and optional Remote
access. This public repository remains the stable source baseline; the latest
user-facing capability is reflected by the npm package and this README.

## A different form factor: squad

If you'd rather have **pure CLI, zero background process, and the ability to
run on a remote SSH box**, [squad](https://github.com/mco-org/squad) takes the
same idea down a different path — SQLite as the protocol layer, one terminal
per agent. The two projects don't replace each other; pick by workflow:

- **Hive** — visual workbench, one-click restart, workspace sidebar, easier to demo to a team
- **squad** — lives in tmux, SSH remote dev, no extra background process, Windows servers

## Acknowledgements

The built-in template marketplace ships snapshots of two community-maintained prompt libraries, both distributed under their upstream MIT licenses:

- English (used when the UI is set to EN): [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)
- Chinese (used when the UI is set to 中文): [`jnMetaCode/agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)

Upstream content is mirrored verbatim, license files are kept under `vendor/marketplace/<lang>/LICENSE`, and snapshots are refreshed by `pnpm sync:marketplace` before each Hive release.

## License

Hive is open source under the Business Source License 1.1. Personal use, internal deployment, embedding, and forks are permitted — see [LICENSE.BSL](LICENSE.BSL) for the exact boundary. Use of the Hive name, logo, and visual identity is covered by [TRADEMARK.md](TRADEMARK.md).
