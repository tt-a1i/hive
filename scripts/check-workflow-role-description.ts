/** Real SQLite + PTY + HTTP check; the recording CLI never calls a model.
 * Run: pnpm exec tsx scripts/check-workflow-role-description.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentManager } from '../src/server/agent-manager.js'
import { createApp } from '../src/server/app.js'
import { getDefaultRoleDescription } from '../src/server/role-templates.js'
import { createRuntimeStore } from '../src/server/runtime-store.js'
import { inboxReaderCommonJsSource } from '../tests/helpers/inbox.js'

const root = await mkdtemp(join(tmpdir(), 'hive-workflow-role-check-'))
const bin = join(root, 'bin')
const originalPath = process.env.PATH
await mkdir(bin)
const recorder = join(bin, 'recorder.cjs')
await writeFile(
  recorder,
  String.raw`
${inboxReaderCommonJsSource}
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let buffer = ''
process.stdout.write('› \n')
process.stdin.on('data', chunk => {
  buffer += chunk
  buffer = expandReceivedInbox(buffer)
  if (buffer.includes('\u001b[201~')) {
    if (buffer.includes('<hive-message kind="startup">')) {
      process.stdout.write('\nCHECK_STARTUP:' + Buffer.from(buffer).toString('base64') + '\n')
    }
    process.stdout.write('\n[Pasted text #1]\n› \n')
    buffer = ''
  } else if (/^[\r\n]+$/.test(chunk)) {
    buffer = ''
    process.stdout.write('\nSUBMITTED\n› \n')
  }
})
process.stdin.resume()
`
)
for (const name of ['grok', 'pi']) {
  const shim = join(bin, name)
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`)
  await chmod(shim, 0o755)
  await writeFile(
    join(bin, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`
  )
}
process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
const store = createRuntimeStore({ dataDir: root, agentManager: createAgentManager() })
const app = createApp({ store })
const waitFor = async <T>(read: () => T | undefined): Promise<T> => {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    assert.ok(Date.now() < deadline, 'workflow did not produce a submitted dispatch')
    await delay(25)
  }
}
try {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const workspace = store.createWorkspace(workspacePath, 'Role check')
  const description = 'Audit permission boundaries.\nDo not change application code.'
  store.settings.createRoleTemplate({
    name: 'security-reader',
    roleType: 'reviewer',
    description,
    defaultCommand: 'grok',
    defaultArgs: [],
    defaultEnv: {},
  })
  for (const scenario of [
    { label: 'custom', agentType: 'security-reader', cli: undefined, description },
    { label: 'override', agentType: 'SECURITY-READER', cli: 'pi', description },
    {
      label: 'builtin',
      agentType: 'reviewer',
      cli: 'pi',
      description: getDefaultRoleDescription('reviewer'),
    },
  ]) {
    const scriptPath = join(workspacePath, `${scenario.label}.ts`)
    await writeFile(
      scriptPath,
      `export const meta = { name: '${scenario.label}', description: 'check role delivery' }\n` +
        `return await agent('Check the assigned profile only.', ${JSON.stringify({
          agentType: scenario.agentType,
          cli: scenario.cli,
          label: scenario.label,
        })})\n`
    )
    type WorkflowResult = Awaited<ReturnType<typeof store.runWorkflow>>
    let finished: WorkflowResult | undefined
    const pending: Promise<WorkflowResult> = store
      .runWorkflow({
        workspaceId: workspace.id,
        scriptPath,
        hivePort: String(address.port),
      })
      .then((run) => {
        finished = run
        return run
      })
    const dispatch = await waitFor(() => {
      assert.equal(finished, undefined, finished?.error ?? 'workflow ended before dispatch')
      return store.listOpenDispatches(workspace.id).find((item) => item.status === 'submitted')
    })
    assert.equal(
      store.getWorker(workspace.id, dispatch.toAgentId).description,
      scenario.description
    )
    const live = store.getActiveRunByAgentId(workspace.id, dispatch.toAgentId)
    assert.ok(live)
    const startup = /CHECK_STARTUP:([A-Za-z0-9+/=]+)/u.exec(live.output)?.[1]
    assert.ok(startup, 'recording CLI did not receive a startup envelope through its PTY')
    assert.ok(
      Buffer.from(startup, 'base64')
        .toString('utf8')
        .includes(`Your role: ${scenario.description}`),
      `${scenario.label}: startup envelope did not contain the configured role description`
    )
    const result = `profile-check:${scenario.label}`
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: dispatch.toAgentId,
        token: store.peekAgentToken(dispatch.toAgentId),
        dispatch_id: dispatch.id,
        result,
      }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 202, await response.text())
    const completed = await pending
    assert.equal(completed.status, 'completed', completed.error ?? '')
    assert.equal(completed.result, result)
    console.log(`PASS ${scenario.label}: persisted role -> PTY startup -> HTTP report`)
  }
} finally {
  app.closeWebSockets()
  await store.close()
  await new Promise<void>((resolve, reject) =>
    app.server.close((error) => (error ? reject(error) : resolve()))
  )
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await rm(root, { recursive: true, force: true })
}
