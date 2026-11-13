import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { WORKFLOW_ENABLED_KEY } from '../../src/server/workflow-feature.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

test('a scheduled real PTY receives the actual ephemeral HTTP port and reports through it', async () => {
  const previousDataDir = process.env.HIVE_DATA_DIR
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-scheduled-port-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const receiver = join(dataDir, 'receiver.cjs')
  writeFileSync(
    receiver,
    `
const { readFileSync } = require('node:fs')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let buffer = ''
let reported = false
process.stdin.on('data', chunk => {
  buffer += chunk
  const file = buffer.match(/Read ("[^"\\r\\n]+") for the complete Hive system message/)
  const text = file ? readFileSync(JSON.parse(file[1]), 'utf8') : buffer
  if (file) buffer = ''
  const dispatch = text.match(/dispatch_id: ([a-f0-9-]{36})/)
  if (!dispatch || reported) return
  reported = true
  fetch('http://127.0.0.1:' + process.env.HIVE_PORT + '/api/team/report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: process.env.HIVE_PROJECT_ID,
      from_agent_id: process.env.HIVE_AGENT_ID, token: process.env.HIVE_AGENT_TOKEN,
      dispatch_id: dispatch[1], result: 'observed-port=' + process.env.HIVE_PORT })
  }).then(async response => { if (!response.ok) throw new Error(await response.text()) })
    .catch(error => { process.stderr.write(String(error)); process.exit(1) })
  buffer = ''
})
process.stdout.write('SCHEDULED_RECEIVER_READY\\r\\n')
`
  )
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  try {
    const workspace = hive.store.createWorkspace(workspacePath, 'Scheduled')
    hive.store.settings.createRoleTemplate({
      name: 'port-reporter',
      roleType: 'custom',
      description: 'Report the runtime port',
      defaultCommand: process.execPath,
      defaultArgs: [receiver],
      defaultEnv: {},
    })
    const source = join(workspacePath, 'scheduled.ts')
    writeFileSync(
      source,
      "export const meta = { name: 'port', description: 'port check' }\nreturn await agent('Report your port', { agentType: 'port-reporter' })"
    )
    hive.store.settings.setAppState(WORKFLOW_ENABLED_KEY, 'true')
    hive.store.createWorkflowSchedule({
      workspaceId: workspace.id,
      scriptPath: source,
      cron: '* * * * *',
      nextRunAt: Date.now() - 1,
    })
    await expect
      .poll(() => hive.store.listWorkspaceWorkflowRuns(workspace.id)[0]?.status, {
        timeout: 45000,
        interval: 100,
      })
      .toBe('completed')
    expect(hive.store.listWorkspaceWorkflowRuns(workspace.id)[0]?.result).toBe(
      `observed-port=${hive.port}`
    )
  } finally {
    await hive.close()
    if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousDataDir
    removeTestPath(dataDir)
  }
}, 50000)
