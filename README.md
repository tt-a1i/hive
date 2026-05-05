# Hive

Hive is a local multi-agent CLI collaboration workspace. It runs a Node.js
runtime on `127.0.0.1`, serves the bundled web UI, and starts CLI agents such as
Claude Code, Codex, OpenCode, and Gemini inside PTYs.

The Orchestrator talks to the user, maintains each workspace task graph at
`.hive/tasks.md`, and dispatches work to team members through the internal
`team` command. Team members report back with `team report`.

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
