import { spawnSync } from 'node:child_process'

const vitestFlags = [
  '--no-file-parallelism',
  '--maxWorkers=1',
  '--testTimeout=60000',
  '--hookTimeout=60000',
]

const groups = [
  [
    'tests/cli/hive-cli.test.ts',
    'tests/cli/hive-update-preflight.test.ts',
    'tests/unit/update-install-plan.test.ts',
    'tests/unit/runtime-database.test.ts',
    'tests/unit/sqlite.test.ts',
    'tests/cli/team-cli-codex-paste-submit.test.ts',
    'tests/unit/agent-command-resolver.test.ts',
    'tests/unit/agent-launch-resolver.test.ts',
    'tests/unit/format-port-in-use.test.ts',
    'tests/unit/opencode-db-path.test.ts',
    'tests/unit/post-start-input-writer.test.ts',
    'tests/unit/session-capture-multi-cli.test.ts',
    'tests/unit/startup-command-parser.test.ts',
    'tests/unit/claude-session-support.test.ts',
    'tests/unit/taskkill-process-tree.test.ts',
    'tests/unit/team-cli-parse-args.test.ts',
    'tests/unit/terminal-input-profile.test.ts',
    'tests/unit/worker-name-generator.test.ts',
    'tests/unit/open-target-commands.test.ts',
    'tests/unit/windows-command-line.test.ts',
    'tests/unit/windows-filename.test.ts',
    'tests/unit/path-canonicalization.test.ts',
    'tests/unit/terminal-protocol.test.ts',
    'tests/unit/workspace-shell-runtime.test.ts',
    'tests/unit/tasks-watcher-options.test.ts',
    'tests/unit/sync-marketplace-tar.test.ts',
    'tests/unit/sw-template-substitution.test.ts',
    'tests/unit/build-sw-plugin.test.ts',
    // Remote-access (M6): pure-JS crypto/protocol/path-whitelist + the Windows-compat invariants
    // (numeric-loopback dial, backslash path rejection). No native dep beyond ws/@noble (pure JS).
    'tests/unit/remote-windows-compat.test.ts',
    'tests/unit/remote-bridge-routing.test.ts',
    'tests/unit/remote-tunnel-url.test.ts',
    'tests/unit/remote-loopback-auth.test.ts',
    'tests/unit/remote-crypto.test.ts',
    'tests/unit/remote-protocol.test.ts',
    'tests/unit/remote-tunnel-frame-guard.test.ts',
    'tests/unit/prepare-build-artifacts.test.js',
  ],
  [
    'tests/server/tasks-file-watcher-real.test.ts',
    'tests/server/team-workflow-schedule.test.ts',
    'tests/server/workflow-nesting.test.ts',
    'tests/server/terminal-ws.test.ts',
    // Remote tunnel over a real runtime + real ws + real PTY (no native dep beyond the pre-existing
    // node-pty); proves the single-daemon multi-device path holds on Windows too.
    'tests/server/remote-multi-device.test.ts',
  ],
  [
    'tests/server/fs-pick-folder.test.ts',
    'tests/server/fs-browse.test.ts',
    'tests/server/schema-version.test.ts',
    'tests/server/runtime-rehydration.test.ts',
    'tests/server/open-workspace-route.test.ts',
    'tests/server/static-pwa.test.ts',
  ],
  [
    'tests/web/is-standalone.test.ts',
    'tests/web/path-join.test.ts',
    'tests/web/workspace-picker.test.tsx',
    'tests/web/confirm-dialog.test.tsx',
    'tests/web/toast.test.tsx',
    'tests/web/open-workspace-button.test.tsx',
    'tests/web/register-service-worker.test.ts',
    'tests/web/use-shortcut-action.test.ts',
    'tests/web/update-available-toast.test.tsx',
    'tests/web/runtime-offline-page.test.tsx',
    'tests/web/use-terminal-panel-height.test.ts',
    'tests/web/use-terminal-panel-tabs.test.ts',
    'tests/web/terminal-tabs.test.tsx',
    'tests/web/terminal-bottom-panel.test.tsx',
  ],
]

for (const [index, files] of groups.entries()) {
  console.log(`\n[hive] Windows test group ${index + 1}/${groups.length}`)
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', ...files, ...vitestFlags], {
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
