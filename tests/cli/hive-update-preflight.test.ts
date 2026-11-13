import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
const require = createRequire(import.meta.url)
const updateUrl = new URL('../../src/cli/hive-update.ts', import.meta.url).href

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = (userConfig: string, projectConfig: string) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-preflight-'))
  roots.push(root)
  const prefix = join(root, 'custom prefix')
  const packageRoot = join(prefix, 'lib/node_modules/@tt-a1i/hive')
  mkdirSync(join(packageRoot, 'dist/src/cli'), { recursive: true })
  mkdirSync(join(prefix, 'etc'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tt-a1i/hive' }))
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, '.npmrc'), projectConfig)
  writeFileSync(join(root, 'user.npmrc'), userConfig)
  writeFileSync(join(prefix, 'etc/npmrc'), '')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))
  )
  env.npm_config_userconfig = join(root, 'user.npmrc')
  const marker = join(root, 'install-invoked')
  const moduleUrl = pathToFileURL(join(packageRoot, 'dist/src/cli/hive-update.js')).href
  const run = (source: string) =>
    spawnSync(
      process.execPath,
      ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '-e', source],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      }
    )
  const update = () =>
    run(`
    import {writeFileSync} from 'node:fs';
    import {runHiveUpdateCommand} from ${JSON.stringify(updateUrl)};
    process.exitCode = await runHiveUpdateCommand([], {
      env: {}, moduleUrl: ${JSON.stringify(moduleUrl)},
      runUpdate: async (command, args) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args)); return {exitCode: 42}; }
    });
  `)
  return { root, prefix, marker, env, moduleUrl, run, update }
}

test.each([
  'true',
  'false',
])('updates without lifecycle scripts when npm ignore-scripts is %s', (setting) => {
  const f = fixture(
    `ignore-scripts=${setting}\n`,
    `ignore-scripts=${setting === 'true' ? 'false' : 'true'}\n`
  )
  const result = f.update()
  expect(result.status).toBe(42)
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual([
    'install',
    '-g',
    '@tt-a1i/hive@latest',
    '--ignore-scripts',
    '--prefix',
    f.prefix,
  ])
  expect(result.stderr).toContain('npm install exited with code 42')
  expect(result.stderr).toContain(
    `--prefix ${process.platform === 'win32' ? `"${f.prefix}"` : `'${f.prefix}'`}`
  )
})

test.skipIf(process.platform !== 'win32')(
  'Windows hive update passes a space-bearing prefix intact through npm.cmd',
  () => {
    const f = fixture('', '')
    const shim = join(f.root, 'npm.cmd')
    const probe = join(f.root, 'record-args.cjs')
    const output = join(f.root, 'received-args.json')
    writeFileSync(
      probe,
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); process.exit(42)`
    )
    writeFileSync(shim, `@"${process.execPath}" "${probe}" %*\r\n`)
    const result = f.run(`
      import {runHiveUpdateCommand} from ${JSON.stringify(updateUrl)};
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
      process.env[pathKey] = ${JSON.stringify(f.root)} + ';' + (process.env[pathKey] ?? '');
      process.exitCode = await runHiveUpdateCommand([], {env: {}, moduleUrl: ${JSON.stringify(f.moduleUrl)}});
    `)

    expect(result.status).toBe(42)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([
      'install',
      '-g',
      '@tt-a1i/hive@latest',
      '--ignore-scripts',
      '--prefix',
      f.prefix,
    ])
  }
)

test.skipIf(process.platform === 'win32')(
  'executable upgrade failure recommends the version before npm changed it',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-upgrade-version-'))
    roots.push(root)
    const prefix = join(root, 'prefix')
    const packageRoot = join(prefix, 'lib/node_modules/@tt-a1i/hive')
    const bin = join(root, 'bin')
    mkdirSync(packageRoot, { recursive: true })
    mkdirSync(bin, { recursive: true })
    cpSync(new URL('../../src', import.meta.url), join(packageRoot, 'src'), { recursive: true })
    symlinkSync(join(process.cwd(), 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
    const packageJson = join(packageRoot, 'package.json')
    writeFileSync(
      packageJson,
      JSON.stringify({ name: '@tt-a1i/hive', version: '1.2.3', type: 'module' })
    )
    const npm = join(bin, 'npm')
    writeFileSync(
      npm,
      `#!/bin/sh\n'${process.execPath}' -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({name:"@tt-a1i/hive",version:"9.9.9",type:"module"}))' '${packageJson}'\n`,
      { mode: 0o755 }
    )
    const source = `
    import { spawnSync } from 'node:child_process';
    import { runHiveUpdateCommand } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'src/cli/hive-update.ts')).href)};
    process.exitCode = await runHiveUpdateCommand([], {
      runUpdate: async (_command, args) => ({ exitCode: spawnSync(${JSON.stringify(npm)}, args).status ?? 1 })
    });
  `
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '-e', source],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
      }
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(readFileSync(packageJson, 'utf8')).version).toBe('9.9.9')
    expect(result.stderr).toContain('failed native verification')
    expect(result.stderr).toContain('@tt-a1i/hive@1.2.3')
    expect(result.stderr).not.toContain('@tt-a1i/hive@9.9.9')
  }
)
