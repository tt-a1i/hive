import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  buildVersionLockedInstallCommand,
  createUpdateInstallPlan,
} from '../../src/server/update-install-plan.js'

const tempRoots: string[] = []

const createTempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

const writeHivePackage = (packageRoot: string): string => {
  const cliDir = join(packageRoot, 'dist/src/cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tt-a1i/hive' }))
  return pathToFileURL(join(cliDir, 'hive-update.js')).href
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('update install planner', () => {
  test.each([
    'unknown',
    '',
    '   ',
  ])('does not produce an unversioned recovery for %j', (version) => {
    const root = createTempRoot('hive-recovery-version-')
    const moduleUrl = writeHivePackage(join(root, 'node_modules/@tt-a1i/hive'))
    const plan = createUpdateInstallPlan({ env: {}, moduleUrl })
    expect(buildVersionLockedInstallCommand(version, plan)).toBe('')
  })

  test.each([
    {
      command: 'pnpm dlx @tt-a1i/hive@latest',
      env: {},
      packagePath: 'pnpm-store/v3/dlx-123/node_modules/@tt-a1i/hive',
      source: 'pnpm-dlx',
    },
    {
      command: 'yarn dlx @tt-a1i/hive@latest',
      env: { npm_config_user_agent: 'yarn/4.12.0 npm/? node/v24.0.0 darwin arm64 dlx' },
      packagePath: 'node_modules/@tt-a1i/hive',
      source: 'yarn-dlx',
    },
    {
      command: 'bunx @tt-a1i/hive@latest',
      env: { _: '/usr/local/bin/bunx' },
      packagePath: 'node_modules/@tt-a1i/hive',
      source: 'bunx',
    },
    {
      command: 'bun add -g @tt-a1i/hive@latest',
      env: {},
      packagePath: '.bun/install/global/node_modules/@tt-a1i/hive',
      source: 'bun-global',
    },
    {
      command: 'yarn global add @tt-a1i/hive@latest',
      env: {},
      packagePath: '.config/yarn/global/node_modules/@tt-a1i/hive',
      source: 'yarn-global',
    },
  ])('uses $source update guidance', ({ command, env, packagePath, source }) => {
    const root = createTempRoot(`hive-update-${source}-`)
    const moduleUrl = writeHivePackage(join(root, packagePath))

    const plan = createUpdateInstallPlan({ env, moduleUrl })

    expect(plan.installSource).toBe(source)
    expect(plan.canRunHiveUpdate).toBe(false)
    expect(plan.installArgs).toEqual([])
    expect(plan.installCommand).toBe(command)
    expect(plan.manualCommand).toBe(command)
  })

  test('keeps Windows npm prefix installs with spaces on the hive update path', () => {
    const root = createTempRoot('hive-update-npm-prefix-')
    const prefix = join(root, 'custom prefix')
    const moduleUrl = writeHivePackage(join(prefix, 'lib/node_modules/@tt-a1i/hive'))

    const plan = createUpdateInstallPlan({ env: {}, moduleUrl, platform: 'win32' })

    expect(plan.installSource).toBe('npm-prefix')
    expect(plan.canRunHiveUpdate).toBe(true)
    expect(plan.installCommand).toBe('hive update')
    expect(plan.installArgs).toEqual([
      'install',
      '-g',
      '@tt-a1i/hive@latest',
      '--ignore-scripts',
      '--prefix',
      prefix,
    ])
    expect(plan.manualCommand).toBe(
      `npm install -g @tt-a1i/hive@latest --ignore-scripts --prefix "${prefix}"`
    )
    expect(buildVersionLockedInstallCommand('2.1.19', plan, 'win32')).toBe(
      `npm install -g @tt-a1i/hive@2.1.19 --ignore-scripts --prefix "${prefix}"`
    )
  })

  test('treats a source checkout as source even when pnpm launched the dev process', () => {
    const root = createTempRoot('hive-update-source-')
    const moduleUrl = writeHivePackage(join(root, 'hive'))

    const plan = createUpdateInstallPlan({
      env: { npm_config_user_agent: 'pnpm/10.30.3 node/v24.0.0 darwin arm64' },
      moduleUrl,
    })

    expect(plan.installSource).toBe('source-checkout')
    expect(plan.canRunHiveUpdate).toBe(false)
    expect(plan.installCommand).toContain('git pull && pnpm install && pnpm build')
  })

  test('uses pnpm for pnpm global store paths', () => {
    const root = createTempRoot('hive-update-pnpm-')
    const moduleUrl = writeHivePackage(
      join(root, 'global/5/node_modules/.pnpm/@tt-a1i+hive@2.1.2/node_modules/@tt-a1i/hive')
    )

    const plan = createUpdateInstallPlan({ env: {}, moduleUrl })

    expect(plan.installSource).toBe('pnpm-global')
    expect(plan.canRunHiveUpdate).toBe(false)
    expect(plan.installCommand).toBe('pnpm add -g @tt-a1i/hive@latest')
  })

  test('uses npx rerun guidance for npx cache paths', () => {
    const root = createTempRoot('hive-update-npx-')
    const moduleUrl = writeHivePackage(join(root, '_npx/abc123/node_modules/@tt-a1i/hive'))

    const plan = createUpdateInstallPlan({ moduleUrl })

    expect(plan.installSource).toBe('npx')
    expect(plan.canRunHiveUpdate).toBe(false)
    expect(plan.installCommand).toBe('npx @tt-a1i/hive@latest')
  })

  test('keeps unknown install sources off the hive update path', () => {
    const root = createTempRoot('hive-update-unknown-')
    const moduleUrl = pathToFileURL(join(root, 'dist/src/cli/hive-update.js')).href

    const plan = createUpdateInstallPlan({ env: {}, moduleUrl })

    expect(plan.installSource).toBe('unknown')
    expect(plan.canRunHiveUpdate).toBe(false)
    expect(plan.installArgs).toEqual([])
    expect(plan.installCommand).toBe('')
    expect(plan.manualCommand).toBe('')
    expect(plan.note).toContain('same package manager and install target')
  })
})
