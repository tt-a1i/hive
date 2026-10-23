import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const script = resolve('scripts/ci-plan.mjs')
const roots: string[] = []
const manifest = { name: 'ci-fixture', version: '1.0.0', dependencies: { example: '1.0.0' } }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const planChange = (
  files: Record<string, string | null>,
  extraEnv: Record<string, string> = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-ci-plan-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: root, encoding: 'utf8' }
    )
  git('init', '-q')
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  for (const [file, contents] of Object.entries(files)) {
    if (contents !== null) continue
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'export {}')
  }
  git('add', '.')
  git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) {
      rmSync(join(root, file))
      continue
    }
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  git('add', '.')
  git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'change')
  return JSON.parse(
    execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', CI_FULL: 'false', CI_BASE_SHA: base, ...extraEnv },
    })
  )
}

test('documentation and gateway-only changes do not install the desktop runtime', () => {
  expect(
    planChange({ 'docs/guide.md': 'text', 'gateway/src/index.ts': 'export {}' })
  ).toMatchObject({
    code: false,
    full: false,
    native: false,
    extended: false,
    tests: false,
    legacy: false,
    shards: [1],
    inputs: [],
  })
})

test('UI changes only need static checks and build', () => {
  expect(planChange({ 'web/src/example.tsx': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: false,
    extended: false,
    tests: false,
    legacy: false,
    shards: [1],
    inputs: [],
  })
})

test('ordinary backend changes retain related tests plus real subprocess coverage', () => {
  expect(planChange({ 'src/server/settings-store.ts': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: false,
    tests: true,
    legacy: true,
    shards: [1],
    inputs: [
      'src/server/settings-store.ts',
      'tests/cli/team-cli.test.ts',
      'tests/server/runtime-rehydration.test.ts',
    ],
  })
})

test.each([
  'src/server/sqlite-schema-v44.ts',
  'src/server/agent-manager.ts',
  'src/server/dispatch-ledger-store.ts',
  'src/server/remote-crypto.ts',
  'src/server/remote-pairing.ts',
  'src/server/remote-loopback-auth.ts',
  'src/server/team-authz.ts',
  'src/server/workflow-script-worker.ts',
  '.github/workflows/ci.yml',
])('high-risk %s changes keep full tests and platform validation', (file) => {
  expect(planChange({ [file]: 'export {}' })).toMatchObject({
    full: true,
    native: true,
    extended: false,
    tests: true,
    legacy: true,
    shards: [1, 2, 3],
  })
})

test('a version bump keeps version consistency checks without running the compatibility matrix', () => {
  expect(
    planChange({ 'package.json': JSON.stringify({ ...manifest, version: '1.0.1' }) })
  ).toMatchObject({
    full: false,
    native: false,
    inputs: ['tests/unit/whats-new-select.test.ts'],
  })
})

test('dependency changes require full tests and native package validation', () => {
  expect(
    planChange({
      'package.json': JSON.stringify({ ...manifest, dependencies: { example: '2.0.0' } }),
    })
  ).toMatchObject({ full: true, native: true })
})

test('packaging changes trigger platform checks without unrelated full tests', () => {
  expect(planChange({ 'scripts/pack-smoke.mjs': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: true,
  })
})

test('editing legacy compatibility tests retains the dedicated old-driver job', () => {
  expect(planChange({ 'tests/unit/sqlite.test.ts': 'export {}' })).toMatchObject({
    tests: true,
    legacy: true,
    full: false,
    native: false,
  })
  expect(planChange({ 'tests/unit/sqlite.test.ts': null })).toMatchObject({
    legacy: true,
    full: false,
  })
})

test('unclassified files fail closed to full validation', () => {
  expect(planChange({ 'new-build-config.json': '{}' })).toMatchObject({ full: true, native: true })
})

test('manual and nightly full mode selects the extended matrix even for documentation', () => {
  expect(planChange({ 'docs/a.md': 'text' }, { CI_FULL: 'true' })).toMatchObject({
    code: true,
    full: true,
    native: true,
    extended: true,
  })
})

test('missing comparison base is an error rather than silently skipping checks', () => {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, CI_FULL: 'false', CI_BASE_SHA: '', GITHUB_OUTPUT: '' },
  })
  expect(result.status).toBe(1)
})

test('source deletions force full validation, while removed test files are not executed', () => {
  expect(planChange({ 'src/server/old-store.ts': null })).toMatchObject({
    full: true,
    native: true,
  })
  expect(planChange({ 'tests/unit/removed.test.ts': null })).toMatchObject({
    code: true,
    full: false,
    inputs: [],
  })
})

test.each([
  'scripts/ci-plan.mjs',
  'scripts/run-tests.mjs',
  'scripts/ci-result.mjs',
])('%s selects its executable regression', (file) => {
  expect(planChange({ [file]: 'export {}' })).toMatchObject({
    full: false,
    native: true,
    inputs: ['tests/unit/ci-plan.test.ts'],
  })
})

test('unclassified scripts retain full validation', () => {
  expect(planChange({ 'scripts/new-release-step.mjs': 'export {}' })).toMatchObject({
    full: true,
    native: true,
  })
})

test('the real runner isolates user data, selects tests, and covers full-suite shards once', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-ci-run-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'tests'))
  for (const file of ['ci-plan.mjs', 'run-tests.mjs'])
    copyFileSync(resolve('scripts', file), join(root, 'scripts', file))
  symlinkSync(
    resolve('node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    "export default { test: { include: ['tests/*.test.js'] } }"
  )
  writeFileSync(join(root, 'src/value.js'), 'export const value = 42')
  writeFileSync(
    join(root, 'tests/selected.test.js'),
    `import { test, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { value } from '../src/value.js';
test('selected', () => { expect(value).toBe(42); writeFileSync('selected.json', JSON.stringify({ data:process.env.HIVE_DATA_DIR, home:process.env.HOME, codex:process.env.CODEX_HOME, profile:process.env.USERPROFILE })); });`
  )
  writeFileSync(
    join(root, 'tests/unrelated.test.js'),
    "import { test, expect } from 'vitest'; import { writeFileSync } from 'node:fs'; test('unrelated failure', () => { writeFileSync('unrelated.json','true'); expect(1).toBe(2) });"
  )
  const run = (inputs: unknown, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/ci-plan.mjs', '--run'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI_FULL: 'false',
        CI_TEST_INPUTS: JSON.stringify(inputs),
        CI_TEST_SHARD: '',
        HIVE_DATA_DIR: join(root, 'user-data'),
        HOME: join(root, 'user-home'),
        CODEX_HOME: join(root, 'user-codex'),
        ...env,
      },
    })
  const selected = run(['src/value.js'])
  expect(selected.status, selected.stdout + selected.stderr).toBe(0)
  const first = JSON.parse(readFileSync(join(root, 'selected.json'), 'utf8'))
  expect(first.data).not.toBe(join(root, 'user-data'))
  expect(first.home).toBe(join(first.data, 'home'))
  expect(first.codex).toBe(join(first.home, '.codex'))
  expect(first.profile).toBe(first.home)
  expect(existsSync(first.data)).toBe(false)
  const mixed = run(['src/value.js', 'tests/unrelated.test.js'])
  expect(mixed.status, mixed.stdout + mixed.stderr).toBe(1)
  const failed = run(['tests/unrelated.test.js'])
  expect(failed.status, failed.stdout + failed.stderr).toBe(1)
  const inventory: string[] = []
  const statuses: Array<number | null> = []
  for (const shard of ['1/2', '2/2']) {
    for (const file of ['selected.json', 'unrelated.json'])
      rmSync(join(root, file), { force: true })
    const result = run([], { CI_FULL: 'true', CI_TEST_SHARD: shard })
    statuses.push(result.status)
    const ran = ['selected.json', 'unrelated.json'].filter((file) => existsSync(join(root, file)))
    expect(ran).toHaveLength(1)
    inventory.push(...ran)
  }
  expect(inventory.sort()).toEqual(['selected.json', 'unrelated.json'])
  expect(statuses.sort()).toEqual([0, 1])
  for (const file of ['selected.json', 'unrelated.json']) rmSync(join(root, file), { force: true })
  for (const env of [
    { CI_FULL: 'true', CI_TEST_SHARD: '0/2' },
    { CI_FULL: 'true', CI_TEST_SHARD: '3/2' },
    { CI_FULL: 'false', CI_TEST_SHARD: '1/2' },
  ])
    expect(run([], env).status).toBe(1)
  expect(run({ wrong: 'shape' }).status).toBe(1)
  expect(existsSync(join(root, 'selected.json'))).toBe(false)
  expect(existsSync(join(root, 'unrelated.json'))).toBe(false)
}, 30000)

test('CI result requires all selected jobs and accepts only intentional skips', () => {
  const names = ['verify', 'tests', 'platforms', 'extended', 'legacy-sqlite']
  const status = (results: Record<string, unknown>) =>
    spawnSync(process.execPath, [resolve('scripts/ci-result.mjs')], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
    }).status
  const full = {
    plan: {
      result: 'success',
      outputs: {
        code: 'true',
        tests: 'true',
        full: 'true',
        native: 'true',
        extended: 'true',
        legacy: 'true',
      },
    },
    ...Object.fromEntries(names.map((name) => [name, { result: 'success' }])),
  }
  expect(status(full)).toBe(0)
  for (const name of names) {
    for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
      expect(status({ ...full, [name]: result ? { result } : undefined })).toBe(1)
    }
  }
  const docs = {
    plan: {
      result: 'success',
      outputs: {
        code: 'false',
        tests: 'false',
        full: 'false',
        native: 'false',
        extended: 'false',
        legacy: 'false',
      },
    },
    ...Object.fromEntries(names.map((name) => [name, { result: 'skipped' }])),
  }
  expect(status(docs)).toBe(0)
  const backend = {
    ...docs,
    plan: {
      ...docs.plan,
      outputs: { ...docs.plan.outputs, code: 'true', tests: 'true', legacy: 'true' },
    },
    verify: { result: 'success' },
    tests: { result: 'success' },
    'legacy-sqlite': { result: 'success' },
  }
  expect(status(backend)).toBe(0)
  expect(status({ ...backend, 'legacy-sqlite': { result: 'skipped' } })).toBe(1)
  expect(status({ ...docs, plan: { ...docs.plan, result: 'failure' } })).toBe(1)
  expect(
    status({ ...docs, plan: { ...docs.plan, outputs: { ...docs.plan.outputs, tests: '' } } })
  ).toBe(1)
  expect(
    status({ ...docs, plan: { ...docs.plan, outputs: { ...docs.plan.outputs, tests: 'true' } } })
  ).toBe(1)
})
