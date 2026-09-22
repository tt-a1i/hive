import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs, stripVTControlCharacters } from 'node:util'

const root = process.cwd()
const { values } = parseArgs({
  options: { 'default-install': { type: 'boolean' }, tarball: { type: 'string' } },
})
const defaultInstall = values['default-install']
const suppliedTarball = values.tarball ? resolve(values.tarball) : undefined
const tempDir = mkdtempSync(join(tmpdir(), 'hive-pack-smoke-'))
let packedFile
const binLinkName = (name) => (process.platform === 'win32' ? `${name}.cmd` : name)
const runtimeStartTimeoutMs = process.platform === 'win32' ? 60_000 : 30_000
const npmCommandTimeoutMs = 180_000

const escapeCmdToken = (value) => {
  if (value.length === 0) return '""'
  const escaped = value.replace(/%/g, '%%').replace(/"/g, '""')
  return /[\s"&<>|^()%]/u.test(value) ? `"${escaped}"` : escaped
}

const buildCmdCommand = (command, args = []) => [command, ...args].map(escapeCmdToken).join(' ')

const runNpm = (args, options = {}) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', `"${buildCmdCommand('npm', args)}"`] : args,
    { ...options, windowsVerbatimArguments: process.platform === 'win32' }
  )
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`npm ${args[0]} exited ${result.status}: ${result.stderr ?? ''}`)
  return result.stdout
}

const removePath = (path) => {
  rmSync(path, {
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    recursive: true,
    retryDelay: 100,
  })
}

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25))
  }
  throw new Error('Timed out waiting for packaged hive runtime to start')
}

const stopChild = async (child) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return

  await new Promise((resolveExit) => {
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000)

    child.once('exit', () => {
      clearTimeout(forceKill)
      resolveExit()
    })

    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          timeout: 3000,
        })
      } catch {
        child.kill('SIGKILL')
      }
      return
    }

    child.kill('SIGTERM')
  })
}

try {
  if (suppliedTarball) {
    packedFile = suppliedTarball
  } else {
    const packJson = runNpm(['pack', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: npmCommandTimeoutMs,
    })
    const packOutput = JSON.parse(packJson)
    const packResults = Array.isArray(packOutput)
      ? packOutput
      : packOutput.filename
        ? [packOutput]
        : Object.values(packOutput)
    if (packResults.length !== 1 || packResults[0]?.name !== '@tt-a1i/hive') {
      throw new Error('Expected exactly one Hive package from npm pack')
    }
    const [packResult] = packResults
    packedFile = resolve(root, packResult.filename)
  }

  // A clean global install must work even when every lifecycle script is blocked.
  const userConfig = join(tempDir, 'user.npmrc')
  const globalConfig = join(tempDir, 'global.npmrc')
  writeFileSync(userConfig, '')
  writeFileSync(globalConfig, '')
  const installEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toLowerCase().startsWith('npm_config_') &&
        key !== 'NODE_PATH' &&
        key !== 'NODE_OPTIONS'
    )
  )
  Object.assign(installEnv, {
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  })
  runNpm(
    [
      'install',
      '--global',
      ...(defaultInstall ? [] : ['--ignore-scripts']),
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--prefer-offline',
      '--fetch-timeout=30000',
      '--fetch-retries=1',
      '--prefix',
      tempDir,
      packedFile,
    ],
    {
      cwd: tempDir,
      env: installEnv,
      stdio: 'inherit',
      timeout: npmCommandTimeoutMs,
    }
  )

  const modulesRoot =
    process.platform === 'win32'
      ? join(tempDir, 'node_modules')
      : join(tempDir, 'lib', 'node_modules')
  const binRoot = process.platform === 'win32' ? tempDir : join(tempDir, 'bin')
  const packageRoot = join(modulesRoot, '@tt-a1i', 'hive')
  const installedRequire = createRequire(join(packageRoot, 'package.json'))
  const xtermLicense = join(
    dirname(installedRequire.resolve('@xterm/xterm/package.json')),
    'LICENSE'
  )
  if (
    !readFileSync(join(packageRoot, 'web/dist/licenses/xterm-LICENSE.txt')).equals(
      readFileSync(xtermLicense)
    )
  ) {
    throw new Error('Packaged Web output must retain the complete xterm license')
  }
  const hiveBin = join(binRoot, binLinkName('hive'))
  const teamBin = join(binRoot, 'team')
  const teamCmdBin = join(binRoot, 'team.cmd')
  const internalTeam = join(packageRoot, 'dist', 'bin', 'team')
  const internalTeamCmd = join(packageRoot, 'dist', 'bin', 'team.cmd')
  const internalTeamLauncher = process.platform === 'win32' ? internalTeamCmd : internalTeam

  if (!existsSync(hiveBin)) throw new Error('Packaged hive bin was not linked')
  if (existsSync(teamBin) || existsSync(teamCmdBin)) {
    throw new Error('team must not be exposed as a global package bin')
  }
  if (!existsSync(internalTeam)) throw new Error('Internal dist/bin/team is missing')
  if (!existsSync(internalTeamCmd)) throw new Error('Internal dist/bin/team.cmd is missing')

  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { pathToFileURL } from 'node:url';
    const { verifyInstalledNativeRuntime } = await import(pathToFileURL(${JSON.stringify(join(packageRoot, 'dist/src/cli/hive-update.js'))}));
    await verifyInstalledNativeRuntime(${JSON.stringify(packageRoot)});
  `,
    ],
    { cwd: tempDir, env: installEnv, stdio: 'inherit', timeout: 30000 }
  )

  // Resolve from the installed archive, never from this checkout's node_modules.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(join(packageRoot, 'package.json'))});
    const pty = require(${JSON.stringify(join(packageRoot, 'dist/src/server/pty.js'))});
    let output = '';
    const terminal = pty.spawn(process.execPath, ['-e', 'console.log("hive-scriptless-pty-ok")'], {
      cwd: ${JSON.stringify(tempDir)}, env: process.env, cols: 80, rows: 24
    });
    const timer = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 10000);
    terminal.onData(chunk => { output += chunk; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      // Natural exit must release its own pipes and worker. Calling kill here
      // hides a dependency lifecycle leak in ordinary npm installations.
      if (exitCode !== 0 || !output.includes('hive-scriptless-pty-ok')) {
        console.error(output); process.exitCode = 1;
      }
    });
  `,
    ],
    { cwd: tempDir, env: installEnv, stdio: 'inherit', timeout: 15000 }
  )

  const child = spawn(
    process.platform === 'win32' ? 'cmd.exe' : hiveBin,
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `"${buildCmdCommand(hiveBin, ['--port', '0', '--no-open'])}"`]
      : ['--port', '0', '--no-open'],
    {
      env: {
        ...installEnv,
        HIVE_DATA_DIR: join(tempDir, 'data'),
        HIVE_ORCHESTRATOR_COMMAND: internalTeamLauncher,
        HIVE_ORCHESTRATOR_ARGS_JSON: JSON.stringify(['list']),
      },
      cwd: tempDir,
      windowsVerbatimArguments: process.platform === 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let spawnError
  child.on('error', (error) => {
    spawnError = error
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    const port = await waitFor(() => {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Packaged Hive exited before becoming ready')
      const match = stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)
      return match?.[1]
    }, runtimeStartTimeoutMs).catch((error) => {
      const childOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      throw new Error(`${error.message}${childOutput ? `\n${childOutput}` : ''}`)
    })
    const response = await fetch(`http://127.0.0.1:${port}/`)
    if (response.status !== 200) {
      throw new Error(`Packaged runtime root returned ${response.status}`)
    }
    const html = await response.text()
    if (!html.includes('<div id="root"></div>')) {
      throw new Error('Packaged runtime did not serve the bundled web UI')
    }

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/ui/session`)
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0]
    if (!sessionResponse.ok || !cookie) {
      throw new Error(`Packaged runtime session returned ${sessionResponse.status}`)
    }

    const workspaceResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      body: JSON.stringify({
        autostart_orchestrator: true,
        name: 'Pack Smoke',
        path: tempDir,
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      method: 'POST',
    })
    if (workspaceResponse.status !== 201) {
      throw new Error(`Packaged runtime workspace create returned ${workspaceResponse.status}`)
    }
    const workspace = await workspaceResponse.json()
    if (workspace.orchestrator_start?.ok !== true) {
      throw new Error(
        `Packaged internal team launcher failed: ${workspace.orchestrator_start?.error ?? 'unknown'}`
      )
    }
    const run = await waitFor(async () => {
      const result = await fetch(
        `http://127.0.0.1:${port}/api/runtime/runs/${workspace.orchestrator_start.run_id}`,
        { headers: { cookie } }
      )
      if (!result.ok) throw new Error(`Could not read internal team run: ${result.status}`)
      const current = await result.json()
      return current.status === 'exited' || current.status === 'error' ? current : undefined
    }, runtimeStartTimeoutMs)
    const protocolLines = stripVTControlCharacters(run.output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
    if (run.exit_code !== 0 || !protocolLines.includes('[]')) {
      throw new Error(
        `Internal team list did not complete its empty-team protocol response (exit ${run.exit_code}): ${run.output}`
      )
    }
  } finally {
    await stopChild(child)
  }

  const database = new DatabaseSync(join(tempDir, 'data', 'runtime.sqlite'), { readOnly: true })
  try {
    if (
      database.prepare('SELECT name FROM workspaces WHERE name = ?').get('Pack Smoke')?.name !==
      'Pack Smoke'
    ) {
      throw new Error('Packaged runtime did not persist its workspace in SQLite')
    }
  } finally {
    database.close()
  }
  console.log(
    `${defaultInstall ? 'Default' : 'Scriptless'} global install: HTTP, SQLite and internal team list protocol passed`
  )

  if (stderr) {
    console.warn(stderr.trim())
  }
} finally {
  // Cleanup diagnostics must not replace the original installation/startup failure.
  for (const path of [suppliedTarball ? undefined : packedFile, tempDir].filter(Boolean)) {
    try {
      removePath(path)
    } catch (error) {
      console.warn(`Could not clean ${path}: ${error.message}`)
    }
  }
}
