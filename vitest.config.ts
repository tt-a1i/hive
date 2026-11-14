import { defineConfig } from 'vitest/config'

// These UI workflows start the real runtime. Keep them with PTY/server tests;
// component and state tests can use the bounded parallel pool.
const runtimeWebTests = [
  'app-shell',
  'app-shell-terminal-flow',
  'demo-mode',
  'first-run-wizard',
  'mobile-add-workspace-no-pick-folder',
  'mobile-parity-reachability',
  'mobile-shell',
  'sidebar-workspace-flow',
  'tasks-flow',
  'whats-new-dialog',
  'worker-flow',
  'workflow-schedules-flow',
  'workflows-flow',
  'workspace-create-initial-state',
  'workspace-flow',
  'workspace-notifications',
].map((name) => `tests/web/${name}.test.tsx`)
const setupFiles = ['./tests/setup/vitest.setup.ts']

export default defineConfig({
  test: {
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'fast',
          pool: 'threads',
          include: [
            'tests/unit/**/*.test.{js,ts,tsx}',
            'tests/web/**/*.test.{js,ts,tsx}',
            'tests/shared/**/*.test.ts',
          ],
          exclude: runtimeWebTests,
          setupFiles,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'runtime',
          include: [
            'tests/server/**/*.test.ts',
            'tests/cli/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            ...runtimeWebTests,
          ],
          setupFiles,
          pool: 'forks',
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
