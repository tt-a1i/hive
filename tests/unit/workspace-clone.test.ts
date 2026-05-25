import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  buildWorktreePath,
  cloneWorkspaceWorkers,
  isGitRepo,
} from '../../src/server/workspace-clone.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'

const makeTmpDir = () => {
  const dir = join(tmpdir(), `hive-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('isGitRepo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns true for a git repository', () => {
    execFileSync('git', ['init', tmpDir], { stdio: 'pipe' })
    expect(isGitRepo(tmpDir)).toBe(true)
  })

  it('returns false for a non-repo directory', () => {
    expect(isGitRepo(tmpDir)).toBe(false)
  })
})

describe('buildWorktreePath', () => {
  let tmpDir: string
  let basePath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    basePath = join(tmpDir, 'my-project')
    mkdirSync(basePath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('slugifies branch name (feature/auth → feature-auth)', () => {
    const result = buildWorktreePath(basePath, 'feature/auth')
    expect(result).toBe(join(tmpDir, 'my-project-feature-auth'))
  })

  it('handles special characters in branch names', () => {
    const result = buildWorktreePath(basePath, 'fix:bug*"test"')
    expect(result).toBe(join(tmpDir, 'my-project-fix-bug-test'))
  })

  it('appends suffix when path already exists', () => {
    const conflicting = join(tmpDir, 'my-project-feature-auth')
    mkdirSync(conflicting)

    const result = buildWorktreePath(basePath, 'feature/auth')
    expect(result).toBe(join(tmpDir, 'my-project-feature-auth-2'))
  })

  it('increments suffix on multiple conflicts', () => {
    mkdirSync(join(tmpDir, 'my-project-main'))
    mkdirSync(join(tmpDir, 'my-project-main-2'))

    const result = buildWorktreePath(basePath, 'main')
    expect(result).toBe(join(tmpDir, 'my-project-main-3'))
  })
})

describe('cloneWorkspaceWorkers', () => {
  const makeStore = () => {
    const workers: Array<{ id: string; name: string; role: string }> = []
    const launches: Array<{ workspaceId: string; agentId: string; config: any }> = []

    const store = {
      getWorkspaceSnapshot: vi.fn().mockReturnValue({
        agents: [
          { id: 'orch-1', name: 'Orchestrator', role: 'orchestrator', description: 'Main orch', pendingTaskCount: 0, status: 'idle', workspaceId: 'ws-source' },
          { id: 'worker-1', name: '米芾', role: 'coder', description: 'Coder worker', pendingTaskCount: 2, status: 'working', workspaceId: 'ws-source', roleTemplateName: 'fast-coder' },
          { id: 'worker-2', name: '莫邪', role: 'reviewer', description: 'Reviewer', pendingTaskCount: 0, status: 'idle', workspaceId: 'ws-source' },
        ],
        summary: { id: 'ws-source', name: 'Test', path: '/tmp/test' },
      }),
      addWorker: vi.fn().mockImplementation((_wsId: string, input: any) => {
        const worker = { id: `new-${workers.length}`, ...input }
        workers.push(worker)
        return worker
      }),
      peekAgentLaunchConfig: vi.fn().mockImplementation((_wsId: string, agentId: string) => {
        if (agentId === 'worker-1') {
          return { command: 'claude', args: ['--model', 'sonnet'], commandPresetId: 'claude' }
        }
        return undefined
      }),
      configureAgentLaunch: vi.fn(),
    } as unknown as RuntimeStore

    return { store, workers, launches }
  }

  it('copies worker configurations (not orchestrator)', () => {
    const { store } = makeStore()

    const count = cloneWorkspaceWorkers(store, 'ws-source', 'ws-target')

    expect(count).toBe(2)
    expect(store.addWorker).toHaveBeenCalledTimes(2)
    expect(store.addWorker).toHaveBeenCalledWith('ws-target', {
      name: '米芾',
      role: 'coder',
      description: 'Coder worker',
      roleTemplateName: 'fast-coder',
    })
    expect(store.addWorker).toHaveBeenCalledWith('ws-target', {
      name: '莫邪',
      role: 'reviewer',
      description: 'Reviewer',
    })
  })

  it('copies launch config when available', () => {
    const { store } = makeStore()

    cloneWorkspaceWorkers(store, 'ws-source', 'ws-target')

    expect(store.configureAgentLaunch).toHaveBeenCalledTimes(1)
    expect(store.configureAgentLaunch).toHaveBeenCalledWith('ws-target', 'new-0', {
      command: 'claude',
      args: ['--model', 'sonnet'],
      commandPresetId: 'claude',
    })
  })

  it('does not copy session, dispatch, or history data', () => {
    const { store } = makeStore()

    cloneWorkspaceWorkers(store, 'ws-source', 'ws-target')

    const addWorkerCalls = (store.addWorker as ReturnType<typeof vi.fn>).mock.calls
    for (const [, input] of addWorkerCalls) {
      expect(input).not.toHaveProperty('pendingTaskCount')
      expect(input).not.toHaveProperty('status')
      expect(input).not.toHaveProperty('workspaceId')
      expect(input).not.toHaveProperty('id')
    }
  })
})
