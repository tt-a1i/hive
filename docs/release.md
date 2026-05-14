# Release checklist

This checklist is for tagged npm releases of `@tt-a1i/hive`.

## Preconditions

- `package.json` version matches the intended tag, for example `v0.6.0-alpha.3`.
- `CHANGELOG.md` has an entry for that exact package version.
- `NPM_TOKEN` is configured as a GitHub Actions secret for the repository.
- The GitHub release workflow is green on macOS, Ubuntu, and Windows.

## Local verification

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm pack:check
pnpm pack:smoke
```

For Windows, also run:

```sh
pnpm test:windows
pnpm build
pnpm pack:check
pnpm pack:smoke
```

## Packaged install smoke

Before pushing a tag, install the packed artifact in a clean temporary prefix and
verify the executable metadata path:

```sh
npm pack
npm install -g ./tt-a1i-hive-<version>.tgz
hive --help
hive --version
```

Then start a runtime on a disposable port and verify the web app can load:

```sh
hive --port 0
```

## Manual Windows smoke

Windows is Tier 2. Before promoting a release, run a manual smoke on Windows:

- Install Node.js 22 and `pnpm`.
- Install the packed `.tgz` globally.
- Confirm `hive --help` and `hive --version` do not start the runtime.
- Confirm `team.cmd` is present in the installed package.
- Start `hive --port 0` and open the printed localhost URL.
- Create a workspace using both pasted path and folder picker.
- If a supported agent CLI is installed, start one orchestrator and one worker.
- Confirm Terminal input supports normal Enter and Shift+Enter behavior for that CLI.

## Publishing

Push a signed or reviewed tag:

```sh
git tag v<version>
git push origin v<version>
```

The release workflow rejects a tag when it does not match `package.json` or when
`CHANGELOG.md` does not contain the matching version entry.
