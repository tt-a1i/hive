# Hive

<p align="center">
  <img src="./assets/hive-hero.png" alt="Hive local-first multi-agent coding workspace hero image" />
</p>

**Hive is a browser-native hive-mind for CLI coding agents.** The orchestrator
is a real `claude` / `codex` / `opencode` / `gemini` process — not you, and
not a script — and so are the workers it dispatches to. Every agent runs as
a real PTY on your machine, talks through a small `team` protocol that Hive
injects into each agent's shell, and shares a markdown task graph at
`<workspace>/.hive/tasks.md`.

[![npm](https://img.shields.io/npm/v/@tt-a1i/hive.svg)](https://www.npmjs.com/package/@tt-a1i/hive)
[![ci](https://img.shields.io/github/actions/workflow/status/tt-a1i/hive/release.yml?branch=main&label=ci)](https://github.com/tt-a1i/hive/actions/workflows/release.yml)
[![Website](https://img.shields.io/badge/website-hive--site.pages.dev-5a8a8a.svg)](https://hive-site.pages.dev)
[![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows%20(best--effort)-lightgrey.svg)](#platform-support)

🌐 **Website**: [hive-site.pages.dev/en/](https://hive-site.pages.dev/en/) · [中文](https://hive-site.pages.dev/)

English · [简体中文](./README.md)

> Public preview. Hive is local-first, runs on `127.0.0.1`, and is intended
> for developers who already use CLI coding agents. The latest published
> version is on [npm](https://www.npmjs.com/package/@tt-a1i/hive) and the
> badge above resolves to it.

## Why Hive

CLI coding agents are powerful, but coordinating several of them manually is
awkward:

- Long-running sessions are spread across terminals.
- It is hard to split a task into implementation, review, and testing without a
  routing layer.
- Worker progress disappears into scrollback.
- Restart recovery depends on each CLI's native session behavior.

Hive adds that coordination layer without replacing the CLIs. The agents remain
real terminal processes running on your machine; Hive manages the team shell
around them.

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

Open the printed local URL, usually `http://127.0.0.1:3000/`. Use
`hive --port 4010` when you need a specific local port.

First-run flow:

1. Create a workspace from a project folder.
2. Choose an Orchestrator preset.
3. Hive creates `<workspace>/.hive/tasks.md`, starts the Orchestrator PTY, and
   injects the internal `team` command into the agent session.
4. Add workers from the Team Members panel.
5. Ask the Orchestrator to delegate work. It sends tasks with
   `team send <worker-name> "<task>"`; workers report back with `team report`.

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
| Claude Code | `claude` | `--dangerously-skip-permissions`, `--permission-mode=bypassPermissions` | `--resume <session_id>` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` | `resume <session_id>` |
| OpenCode | `opencode` | Config-driven in `~/.config/opencode/opencode.json` | `--session <session_id>` |
| Gemini | `gemini` | `--yolo` | `--resume <session_id>` |
| Custom | Any executable | User configured | User configured |

Hive does not install these CLIs for you. Install and authenticate them in the
same shell environment you use to start Hive.

## What Hive Provides

- Workspace sidebar for switching between local projects.
- Orchestrator and worker terminals backed by real PTYs.
- Add Worker flow with role presets for coder, reviewer, tester, and custom
  members.
- `.hive/tasks.md` editor with external-file conflict handling.
- Background PTY preservation and best-effort native session resume.
- Local SQLite metadata under `~/.config/hive` by default, or `$HIVE_DATA_DIR`
  when set.

Hive does not provide sandboxing, multi-user auth, cloud hosting, or its own
coding model. It coordinates tools you already run locally.

## Platform Support

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Tier 1 | Main development and release verification target. |
| Linux | Tier 1 | CI verified. Native folder picking expects `zenity`; manual path entry works without it. |
| Windows | Tier 2 | CI runs a Windows test subset and a packaged-install smoke. Folder picking uses Windows PowerShell and the package includes `team.cmd`. Treat as best-effort — full Windows verification before each release is manual. |

All platforms require Node.js 22+. Hive depends on native packages
(`node-pty` and `better-sqlite3`), so native install tooling may be required
when prebuilt binaries are unavailable.

## Safety Model

Hive is a local development tool, not a hosted service.

- The runtime binds to `127.0.0.1`. Do not expose the Hive port through a public
  tunnel, reverse proxy, or shared network interface.
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
| Runtime metadata | `~/.config/hive` or `$HIVE_DATA_DIR` |
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

**Native package install fails**

Hive depends on `node-pty` and `better-sqlite3`, which use native binaries. Use
Node.js 22+, keep your package manager cache clean, and verify your platform
build tools are available.

**Folder picker does not open on Linux**

Install `zenity`, or paste the workspace path manually.

**Folder picker does not open on Windows**

Verify Windows PowerShell is available as `powershell.exe`, or paste the
workspace path manually.

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

## Release

Maintainer dry run:

```bash
pnpm release:dry
```

See [docs/release.md](docs/release.md) for the full tagged release checklist,
including manual Windows smoke steps.

Tag pushes matching `v*` run the GitHub Actions release workflow. The workflow
verifies macOS, Ubuntu, and Windows, then publishes to npm with `NPM_TOKEN`.

## Status

Hive is in alpha public preview. Expect UI and protocol details to keep moving
while the core local orchestration model hardens.

## License

Apache-2.0. See [LICENSE](LICENSE).
