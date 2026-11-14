# Release guide

`tt-a1i/hive` is the development and release source for Hive, including unreleased
work and the separately deployed gateway. Build releases from a clean checkout of
this repository. The source consolidation does not change the BSL license, publish
a new npm version, or deploy the hosted gateway.

## Prepare a release

1. Review and merge the intended changes through a pull request.
2. Update `package.json`, `CHANGELOG.md`, and the bilingual top entry in
   `web/src/whats-new/changelog.ts` to the same release version.
3. Run the default fast gate:

   ```sh
   pnpm install --frozen-lockfile
   pnpm release:dry
   ```

   This runs `pnpm check`, `pnpm build`, `pnpm pack:check`, and `pnpm pack:smoke`.
   Also run the real integration tests for affected core behavior. Use
   `pnpm release:full` for broad runtime, protocol, schema, or security changes,
   stable major releases, or when explicitly requested, as specified in `AGENTS.md`.
4. Record the commands, results, omitted checks, and remaining platform/device
   acceptance in the release PR. Passing package checks does not establish phone
   or Windows acceptance.
5. Confirm the public repository's `NPM_TOKEN` secret is configured and valid for
   publishing `@tt-a1i/hive`. Secret presence alone does not prove authorization.
6. After the reviewed release commit reaches `main`, tag that exact commit and
   push only the new release tag:

   ```sh
   git tag v<version>
   git push origin v<version>
   ```

   Existing release tags and npm versions are immutable historical releases;
   source consolidation must not republish or move them.
7. Verify the release workflow and read back the published npm version:

   ```sh
   npm view @tt-a1i/hive@<version> version license
   ```

The workflow validates the tag/version/changelog and publishes the tarball from
its release smoke job. It does not rebuild in the publish job. If publishing is
blocked, resolve repository/authentication configuration here; do not return to
the retired private development workflow. A maintainer-authorized local publish
must use the same verified release artifact and receive the same npm readback.

## Upgrading to 3.0.0

Before starting 3.0.0, stop Hive and its agents gracefully, then copy the entire
Hive data directory to a separate backup. Copying the whole directory preserves
SQLite sidecar files and supporting state. Keep the backup private.

Use `HIVE_DATA_DIR` when set. Otherwise the default is `$XDG_CONFIG_HOME/hive`
or `~/.config/hive` on macOS/Linux, and `%APPDATA%\hive` on Windows. Older
Windows installations may still use `~/.config/hive`; back up the directory
used by the current installation.

The first launch applies v46/v47, including deletion of retired controller and
Memory/Dream tables. To roll back, stop the new runtime, restore the complete
pre-upgrade backup to its original data directory, and run the matching older
Hive version. Save the post-upgrade directory separately if it contains new work.
The in-app What's New dialog appears after startup and does not replace this
pre-upgrade backup notice. Include these steps in the public release announcement.

## CI and platform checks

Pull-request CI selects checks by risk. Documentation-only changes need the plan
and result jobs; UI changes need static checks and a Linux build. Core changes
use dependency-aware tests, with full Linux validation for shared runtime,
SQLite/schema, dispatch, PTY, workflow, protocol, remote security, dependencies,
and test/build configuration changes. Packaging changes also use the platform
installation matrix. The nightly/manual workflow runs the extended matrix.
`CI / result` is the aggregate check to require when configuring branch protection.

For a Windows release, verify installation, CLI help/version, runtime startup,
workspace creation, agent startup, and Enter/Shift+Enter on a real Windows host.
For remote changes, verify pairing, desktop approval, revocation, terminal input,
and reconnect on the affected real phone/browser combinations.

## Gateway deployment

`gateway/` is public source and remains excluded from the npm tarball. Its
`private: true` package flag prevents npm publication; it does not restrict
source visibility. See [the deployment runbook](deploy-runbook.md).

The hosted gateway uses the `gateway-production` GitHub environment. Configure
its Cloudflare credentials and any required approval rules in this repository
before deploying. OAuth/JWT secrets stay in Cloudflare or gitignored local
`.dev.vars` files. Self-hosters must use their own domain and D1 binding.

`RELEASE_GATEWAY_BUNDLE=true` opts a tagged release into building/deploying a
matching gateway bundle. That job is independent and allows failure: npm can
publish even if the gateway deployment fails. Confirm its result separately;
when a release requires a matching mobile bundle, deploy and verify it before
announcing remote availability. `gateway-deploy.yml` also supports an explicit
manual deployment. Source migration alone does not trigger either deployment.
