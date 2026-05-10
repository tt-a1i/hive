# Hive

Hive 是一个本地多 Agent 协作工作台，用来把 Claude Code、Codex、OpenCode、
Gemini 等 CLI Agent 组织成一个可视化团队。它会在本机启动一个 Node.js
runtime，提供 Web UI，并把每个 Agent 放在独立 PTY 里运行。

每个 workspace 都有一个 Orchestrator 负责和用户对话、拆解任务、维护
`.hive/tasks.md` 任务图，并通过内部 `team` 命令把工作派给团队成员。团队成员
在自己的 CLI 会话里执行任务，完成或遇到阻塞后用 `team report` 回报。

核心目标是把“一个人同时管理多个 AI 编码助手”的过程产品化：任务可见、成员可见、
终端可恢复、上下文可接力，并尽量保留各家 CLI Agent 自己的原生能力。

## English Overview

Hive is a local multi-agent CLI collaboration workspace. It turns CLI agents
such as Claude Code, Codex, OpenCode, and Gemini into a visible team running on
your machine. Hive starts a Node.js runtime on `127.0.0.1`, serves a bundled web
UI, and runs each agent inside its own PTY.

Each workspace has an Orchestrator that talks to the user, breaks work down,
maintains the workspace task graph at `.hive/tasks.md`, and dispatches tasks to
team members through the internal `team` command. Team members work in their own
CLI sessions and report progress or blockers with `team report`.

The goal is to make multi-agent coding work manageable: visible tasks, visible
members, recoverable terminals, handoff-friendly context, and minimal
interference with each agent CLI's native behavior.

## Requirements

- Node.js 22+
- pnpm 10.30.3 for local development
- At least one supported agent CLI installed on the machine

## Development

```bash
pnpm install
pnpm dev
```

The development runtime uses `127.0.0.1:4010`; the Vite web server uses
`127.0.0.1:5180`.

Useful commands:

```bash
pnpm check
pnpm build
pnpm test
```

## Production Build

```bash
pnpm build
node dist/src/cli/hive.js --port 4010
```

The production server serves `web/dist` directly. No separate Vite server is
needed after `pnpm build`.

## Package Release

Hive is prepared to publish as the scoped npm package `@tt-a1i/hive`.

Before publishing, run:

```bash
pnpm release:dry
```

That command runs linting, the production build, the full test suite, npm
packlist validation, and a tarball install smoke test.

Manual publish flow:

```bash
pnpm release:dry
git tag v0.6.0-alpha.0
git push origin v0.6.0-alpha.0
```

Tag pushes matching `v*` run the GitHub Actions release workflow. The publish
job expects an npm token in `NPM_TOKEN` and publishes with provenance:

```bash
npm publish --provenance --access public
```

## Installation After Publish

```bash
npm i -g @tt-a1i/hive
hive --port 4010
```

or:

```bash
npx @tt-a1i/hive --port 4010
```

Only the `hive` command is exposed globally. The `team` command is intentionally
bundled inside the package and injected into agent PTYs through `PATH`, so it
does not pollute the user's global shell.

## Updates

For global installs:

```bash
npm i -g @tt-a1i/hive@latest
```

For `npx` usage, rerun the command and let the package manager resolve the
latest version according to its cache policy.

The runtime stores global metadata under `~/.config/hive` by default, or under
`HIVE_DATA_DIR` when that environment variable is set. Workspace task graphs are
stored at `<workspace>/.hive/tasks.md`.
