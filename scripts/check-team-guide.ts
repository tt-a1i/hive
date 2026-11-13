/** Real HTTP + SQLite + PTY + spawned CLI guide check; no paid models.
 * Run: pnpm exec tsx scripts/check-team-guide.ts [--receipt /tmp/guide-receipt.json]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHiveCommand } from '../src/cli/hive.js'

type Runtime = Awaited<ReturnType<typeof runHiveCommand>>
type Workspace = { id: string; path: string }
type Guide = { project_id: string; project_path: string; topic: string; guide: string }
const startedAt = Date.now()
const receiptPath =
  process.argv[2] === '--receipt' && process.argv[3]
    ? process.argv[3]
    : join(tmpdir(), `hive-guide-receipt-${startedAt}.json`)
await mkdir(dirname(receiptPath), { recursive: true })
const root = await realpath(await mkdtemp(join(tmpdir(), 'hive-guide-check-')))
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const loader = import.meta.resolve('tsx')
const hiveKeys = ['HIVE_PORT', 'HIVE_PROJECT_ID', 'HIVE_AGENT_ID', 'HIVE_AGENT_TOKEN'] as const
const oldDataDir = process.env.HIVE_DATA_DIR
const oldPath = process.env.PATH
process.env.HIVE_DATA_DIR = join(root, 'data')
let runtime: Runtime | undefined
let cookie = ''
const passed: string[] = []
const pass = (name: string) => {
  passed.push(name)
  console.log(`PASS ${name}`)
}
const base = () => `http://127.0.0.1:${runtime?.port}`
const request = (path: string, body?: object, method = body ? 'POST' : 'GET', headers = {}) =>
  fetch(`${base()}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
const status = async (response: Response, expected: number) => {
  assert.equal(response.status, expected, `${response.url}: ${await response.clone().text()}`)
  return response
}
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T
const subprocess = (args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Guide subprocess timed out: ${args.join(' ')}`))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
const cleanEnv = () => {
  const env = { ...process.env }
  for (const key of hiveKeys) delete env[key]
  return env
}
const identity = (workspace: Workspace, actor: string) => {
  const token = runtime?.store.peekAgentToken(actor)
  assert.ok(token, 'Real member startup must issue a CLI token')
  return {
    HIVE_PORT: String(runtime?.port),
    HIVE_PROJECT_ID: workspace.id,
    HIVE_AGENT_ID: actor,
    HIVE_AGENT_TOKEN: token,
  }
}
const cli = async (cwd: string, env: NodeJS.ProcessEnv, args: string[], expected = 0) => {
  const result = await subprocess([join(sourceRoot, 'bin/team'), ...args], cwd, env)
  assert.equal(result.code, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
const guide = async (workspace: Workspace, actor: string, topic: string, extra = {}) => {
  const env = identity(workspace, actor)
  return json<Guide>(
    await status(
      await request('/api/team/guide', {
        project_id: workspace.id,
        from_agent_id: actor,
        token: env.HIVE_AGENT_TOKEN,
        topic,
        ...extra,
      }),
      200
    )
  )
}
const createWorkspace = async (name: string) => {
  const path = join(root, name)
  await mkdir(path)
  return json<Workspace>(
    await status(
      await request('/api/workspaces', {
        name,
        path,
        autostart_orchestrator: false,
      }),
      201
    )
  )
}
const start = async (workspace: Workspace, actor: string) => {
  await status(
    await request(`/api/workspaces/${workspace.id}/agents/${actor}/config`, {
      command: process.execPath,
      args: [join(root, 'passive-agent.cjs')],
    }),
    204
  )
  await status(
    await request(`/api/workspaces/${workspace.id}/agents/${actor}/start`, {
      hive_port: String(runtime?.port),
    }),
    201
  )
}
const member = async (workspace: Workspace) => {
  const created = await json<{ id: string }>(
    await status(
      await request(`/api/workspaces/${workspace.id}/workers`, {
        name: 'GuideProbe',
        role: 'coder',
        autostart: false,
      }),
      201
    )
  )
  await start(workspace, created.id)
  return created.id
}
const staleMarker = 'UNTRUSTED_CWD_GUIDE_SENTINEL'
const poisonGuide = async (cwd: string) => {
  await mkdir(join(cwd, '.hive'), { recursive: true })
  await writeFile(join(cwd, '.hive/PROTOCOL.md'), `## Guide: workflow\n${staleMarker}\n`)
}
try {
  await writeFile(join(root, 'passive-agent.cjs'), 'process.stdin.resume();\n')
  // Never invoke the user's Codex CLI or send a real App notification.
  const bridgeBin = join(root, 'notification-bridge')
  await mkdir(bridgeBin)
  await writeFile(join(bridgeBin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.PATH = `${bridgeBin}${delimiter}${oldPath ?? ''}`
  runtime = await runHiveCommand(['--port', '0'])
  cookie = (await status(await request('/api/ui/session'), 200)).headers.get('set-cookie') ?? ''
  assert.ok(cookie)
  const workspace = await createWorkspace('workspace with spaces')
  const other = await createWorkspace('other workspace')
  const orchestrator = `${workspace.id}:orchestrator`
  await start(workspace, orchestrator)
  const worker = await member(workspace)
  const env = { ...cleanEnv(), ...identity(workspace, worker) }
  for (const actor of [orchestrator, worker]) {
    for (const topic of ['core', 'dispatch', 'tasks', 'memory', 'workflow', 'member']) {
      const result = await guide(workspace, actor, topic)
      assert.equal(result.project_id, workspace.id)
      assert.equal(result.project_path, workspace.path)
      assert.equal(result.topic, topic)
      assert.ok(result.guide.length > 100)
    }
  }
  pass('all six guide topics authenticate both real Orchestrator and member identities')

  const nested = join(workspace.path, 'nested')
  await mkdir(nested)
  for (const cwd of [workspace.path, nested, other.path]) {
    await poisonGuide(cwd)
    const output = await cli(cwd, env, ['guide', 'workflow'])
    assert.ok(output.includes(workspace.id))
    assert.ok(output.includes(JSON.stringify(workspace.path)))
    assert.match(output, /Workflow commands are disabled/u)
    assert.ok(!output.includes(staleMarker))
  }
  pass('online CLI binds the authenticated project across root, nested and unrelated cwd')

  await status(await request('/api/settings/workflow-feature', { enabled: true }, 'PUT'), 200)
  for (const selected of ['codex', 'gemini']) {
    await status(
      await request(
        '/api/settings/workflow-cli-policy',
        { default: selected, allowed: [selected] },
        'PUT'
      ),
      200
    )
    await poisonGuide(workspace.path)
    const output = await cli(workspace.path, env, ['guide', 'workflow'])
    assert.ok(output.includes('team workflow run --stdin'))
    assert.ok(output.includes(`Default CLI when \`cli\` is omitted: **${selected}**`))
    assert.ok(output.includes(`Allowed CLIs for \`cli\`: ${selected}`))
    assert.ok(!output.includes(staleMarker))
  }
  await status(await request('/api/settings/workflow-feature', { enabled: false }, 'PUT'), 200)
  const disabled = await cli(nested, env, ['guide', 'workflow'])
  assert.match(disabled, /Workflow commands are disabled/u)
  assert.ok(!disabled.includes('team workflow run --stdin'))
  pass('live feature toggles and CLI policy changes override stale protocol files immediately')

  const auth = {
    project_id: workspace.id,
    from_agent_id: worker,
    token: env.HIVE_AGENT_TOKEN,
    topic: 'core',
  }
  for (const extra of [{ token: 'invalid' }, { token: undefined }, { project_id: other.id }])
    await status(await request('/api/team/guide', { ...auth, ...extra }), 401)
  for (const extra of [{ topic: 'unknown' }, { unexpected: true }])
    await status(await request('/api/team/guide', { ...auth, ...extra }), 400)
  await poisonGuide(nested)
  assert.equal(
    await cli(nested, { ...env, HIVE_AGENT_TOKEN: 'invalid' }, ['guide', 'workflow'], 1),
    ''
  )
  for (const key of hiveKeys)
    assert.equal(
      await cli(nested, { ...cleanEnv(), [key]: env[key] }, ['guide', 'workflow'], 1),
      ''
    )
  pass(
    'bad tokens, cross-project identities and partial Hive environments cannot fall back offline'
  )

  // Real HTTP 404 exercises an older runtime's missing route without mocking fetch.
  const missingRoute = createServer((_request, response) => response.writeHead(404).end())
  missingRoute.listen(0, '127.0.0.1')
  await once(missingRoute, 'listening')
  try {
    const address = missingRoute.address()
    assert.ok(address && typeof address === 'object')
    assert.equal(
      await cli(nested, { ...env, HIVE_PORT: String(address.port) }, ['guide', 'workflow'], 1),
      ''
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      missingRoute.close((error) => (error ? reject(error) : resolve()))
    )
  }
  pass('an HTTP runtime without the guide endpoint fails explicitly despite a local snapshot')

  const saved = await cli(nested, cleanEnv(), ['guide', 'workflow'])
  assert.match(saved, /Saved reference only/u)
  assert.match(saved, /current capabilities are unknown/u)
  assert.ok(saved.includes(staleMarker))
  const offline = await cli(root, cleanEnv(), ['guide', 'workflow'])
  assert.match(offline, /Offline reference only/u)
  assert.match(offline, /availability and CLI policy are unknown/u)
  assert.ok(!offline.includes('Workflow commands are disabled'))
  pass('offline saved and generated guides explicitly leave current capabilities unknown')

  const receipt = {
    outcome: 'passed',
    checks: passed,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    node: process.version,
    command: 'pnpm exec tsx scripts/check-team-guide.ts',
    scope: 'real HTTP SQLite PTY CLI; guide reading/understanding by real models is not measured',
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2))
} catch (error) {
  await writeFile(
    receiptPath,
    `${JSON.stringify({ outcome: 'failed', checks: passed, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  )
  throw error
} finally {
  try {
    await runtime?.close()
  } finally {
    if (oldDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = oldDataDir
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await rm(root, { recursive: true, force: true })
  }
}
