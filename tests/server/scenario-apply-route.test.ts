import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { applyScenario as applyScenarioDirect } from '../../src/server/routes-scenarios.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getScenarioPreset } from '../../src/server/scenario-presets.js'
import { createTasksFileService } from '../../src/server/tasks-file.js'
import { WORKER_NAME_POOL } from '../../src/shared/random-worker-name.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      force: true,
      maxRetries: process.platform === 'win32' ? 20 : 0,
      recursive: true,
    })
  }
})

const startServer = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-scenario-api-'))
  tempDirs.push(dataDir)

  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })

  const store = createRuntimeStore({ dataDir })
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const app = createApp({ store, tasksFileService: createTasksFileService() })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push({
    async close() {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  })

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    workspace,
  }
}

const applyScenario = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  scenarioId: string,
  body: unknown
) =>
  fetch(`${baseUrl}/api/workspaces/${workspaceId}/scenarios/${scenarioId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })

describe('scenario apply route', () => {
  test('409 when the orchestrator is not RUNNING — a saved launch config alone is not enough', async () => {
    const { baseUrl, store, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    // Configured but stopped: the kickoff would be silently lost (it is only
    // delivered to a live terminal), so the route must refuse up front.
    store.configureAgentLaunch(workspace.id, `${workspace.id}:orchestrator`, {
      command: 'claude',
      args: [],
    })

    const response = await applyScenario(baseUrl, cookie, workspace.id, 'build_review_test', {
      goal: 'Ship something',
    })

    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('Orchestrator')
    // Nothing was created on the failure path.
    expect(store.listWorkers(workspace.id)).toHaveLength(0)
  })

  test('404 for an unknown scenario and 400 for a missing goal', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const unknown = await applyScenario(baseUrl, cookie, workspace.id, 'nope', { goal: 'x' })
    expect(unknown.status).toBe(404)

    const missingWorkspace = await applyScenario(baseUrl, cookie, 'no-such-ws', 'docs_pipeline', {
      goal: 'x',
    })
    expect(missingWorkspace.status).toBe(404)

    const noGoal = await applyScenario(baseUrl, cookie, workspace.id, 'docs_pipeline', {
      goal: '   ',
    })
    expect(noGoal.status).toBe(400)
  })

  // The HTTP route gates on a LIVE orchestrator run and starts real PTYs, which
  // this harness does not provide — so team assembly is exercised directly via
  // the exported applyScenario. Startup ordering has its own unit coverage.
  test('creates the preset workers with a config DERIVED from the orchestrator CLI and injects the kickoff', async () => {
    const { store, workspace } = await startServer()
    // Orchestrator launched via a session-resume command line: workers must NOT
    // clone these args, or every worker would resume the orchestrator session.
    store.configureAgentLaunch(workspace.id, `${workspace.id}:orchestrator`, {
      command: 'claude',
      args: ['--resume', 'orch-session-id', '--permission-mode', 'bypassPermissions'],
    })
    const scenario = getScenarioPreset('build_review_test')
    if (!scenario) throw new Error('missing scenario preset')

    const created = await applyScenarioDirect(
      store,
      workspace.id,
      scenario,
      'Ship the CSV export',
      () => true // every CLI "installed" — keeps the resolver off the real PATH
    )

    expect(created.map((worker) => worker.role)).toEqual(['coder', 'reviewer', 'tester'])
    for (const worker of created) {
      expect(WORKER_NAME_POOL).toContain(worker.name)
      expect(worker.name).not.toMatch(/^(coder|reviewer|tester)-[0-9a-z]{4}$/)
      const config = store.peekAgentLaunchConfig(workspace.id, worker.id)
      // Derived from the claude preset — same brand, FRESH args (no --resume).
      expect(config?.command).toBe('claude')
      expect(config?.args ?? []).not.toContain('--resume')
      expect(config?.args ?? []).not.toContain('orch-session-id')
    }
    expect(store.listWorkers(workspace.id)).toHaveLength(3)

    // The kickoff landed in the message log as USER input for the orchestrator
    // (dispatching itself stays with the orchestrator — no dispatches exist).
    const userInputs = store
      .listMessagesForRecovery(workspace.id, 0)
      .filter((message) => message.type === 'user_input')
    expect(userInputs).toHaveLength(1)
    expect(userInputs[0]?.text).toContain('Ship the CSV export')
    for (const worker of created) {
      expect(userInputs[0]?.text).toContain(worker.name)
    }
    expect(store.listDispatches(workspace.id)).toHaveLength(0)
  })

  test('custom-role scenarios persist the preset role contract as the worker description', async () => {
    const { store, workspace } = await startServer()
    store.configureAgentLaunch(workspace.id, `${workspace.id}:orchestrator`, {
      command: 'codex',
      args: [],
    })
    const scenario = getScenarioPreset('research_factcheck')
    if (!scenario) throw new Error('missing scenario preset')

    const created = await applyScenarioDirect(
      store,
      workspace.id,
      scenario,
      'Research the watcher regression',
      () => true
    )

    expect(created.map((worker) => worker.role)).toEqual(['custom', 'custom'])
    for (const [index, worker] of created.entries()) {
      const description = store.getWorker(workspace.id, worker.id).description
      expect(description).toBe(scenario.workers[index]?.descriptionOverride?.en)
      // Derived from the codex preset, not cloned from the orchestrator config.
      expect(store.peekAgentLaunchConfig(workspace.id, worker.id)?.command).toBe('codex')
    }
  })
})
