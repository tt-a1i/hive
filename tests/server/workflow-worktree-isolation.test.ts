import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createWorkflowWorktree, workflowWorktreeDir } from '../../src/server/workflow-worktree.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { inboxReaderCommonJsSource } from '../helpers/inbox.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const leftoverWorktrees: Array<{ branch: string; path: string; workspacePath: string }> = []
const originalPath = process.env.PATH

const removeLeftoverWorktree = (item: { branch: string; path: string; workspacePath: string }) => {
  if (existsSync(item.workspacePath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', item.path], {
        cwd: item.workspacePath,
        encoding: 'utf8',
      })
    } catch {
      // already detached or removed
    }
    try {
      execFileSync('git', ['branch', '-D', item.branch], {
        cwd: item.workspacePath,
        encoding: 'utf8',
      })
    } catch {
      // already deleted
    }
  }
  if (existsSync(item.path)) removeTestPath(item.path)
}

afterEach(async () => {
  process.env.PATH = originalPath
  delete process.env.HIVE_DATA_DIR
  for (const leftover of leftoverWorktrees.splice(0)) removeLeftoverWorktree(leftover)
  for (const d of dirs.splice(0)) removeTestPath(d)
})

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const initGitWorkspace = (workspacePath: string) => {
  mkdirSync(workspacePath, { recursive: true })
  git(['init'], workspacePath)
  git(['config', 'user.email', 'hive-worktree@test.local'], workspacePath)
  git(['config', 'user.name', 'hive-worktree-test'], workspacePath)
  writeFileSync(join(workspacePath, '.gitignore'), '.hive/\n')
  writeFileSync(join(workspacePath, 'README.md'), 'base\n')
  git(['add', 'README.md', '.gitignore'], workspacePath)
  git(['commit', '-m', 'init'], workspacePath)
}

const writeReportingWorker = (binDir: string, mode: 'commit' | 'dirty' | 'noop') => {
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, 'claude-worktree-worker.js')
  writeFileSync(
    scriptPath,
    [
      inboxReaderCommonJsSource,
      "const { spawnSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      "let buf = ''",
      'let done = false',
      `const mode = ${JSON.stringify(mode)}`,
      'const finish = (dispatchId) => {',
      '  if (done) return',
      '  done = true',
      '  const cwd = process.cwd()',
      "  if (mode === 'commit') {",
      "    writeFileSync(join(cwd, 'isolated.txt'), 'from-worktree\\n')",
      "    spawnSync('git', ['add', 'isolated.txt'], { cwd, encoding: 'utf8' })",
      "    spawnSync('git', ['commit', '-m', 'isolated work'], { cwd, encoding: 'utf8' })",
      "  } else if (mode === 'dirty') {",
      "    writeFileSync(join(cwd, 'dirty.txt'), 'uncommitted\\n')",
      '  }',
      '  const port = process.env.HIVE_PORT',
      '  const body = JSON.stringify({',
      '    artifacts: [],',
      '    dispatch_id: dispatchId,',
      '    from_agent_id: process.env.HIVE_AGENT_ID,',
      '    project_id: process.env.HIVE_PROJECT_ID,',
      "    result: 'cwd=' + cwd,",
      '    token: process.env.HIVE_AGENT_TOKEN,',
      '  })',
      '  fetch("http://127.0.0.1:" + port + "/api/team/report", {',
      '    body,',
      "    headers: { 'content-type': 'application/json' },",
      "    method: 'POST',",
      '  }).then(async (res) => {',
      '    if (!res.ok) {',
      '      process.stderr.write(await res.text())',
      '      process.exit(1)',
      '    }',
      '  }).catch((err) => {',
      '    process.stderr.write(String(err))',
      '    process.exit(1)',
      '  })',
      '}',
      "process.stdin.on('data', (chunk) => {",
      '  buf += chunk',
      '  buf = expandReceivedInbox(buf)',
      '  const match = buf.match(/dispatch_id: ([^\\s|<]+)/)',
      '  if (match) finish(match[1].trim())',
      '})',
      'process.stdin.resume()',
    ].join('\n')
  )
  const unixCli = join(binDir, 'claude')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  writeFileSync(
    join(binDir, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
  )
}

const waitForRun = async (
  store: Awaited<ReturnType<typeof runHiveCommand>>['store'],
  runId: string,
  timeoutMs = 30_000
) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const run = store.getWorkflowRun(runId)
    if (run && run.status !== 'running') return run
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`workflow run ${runId} did not finish`)
}

const parseWorktreeLine = (text: string) => {
  const match = text.match(
    /<hive-worktree branch="([^"]+)" base="([^"]+)" kept="(true|false)" path="([^"]*)"\/>/
  )
  if (!match) throw new Error(`missing hive-worktree line in:\n${text}`)
  return {
    branch: match[1] ?? '',
    base: match[2] ?? '',
    kept: match[3] === 'true',
    path: match[4] ?? '',
  }
}

const setupHiveWorkspace = async (gitRepo: boolean) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-worktree-'))
  dirs.push(dataDir)
  const workspacePath = join(dataDir, 'ws')
  if (gitRepo) initGitWorkspace(workspacePath)
  else mkdirSync(workspacePath, { recursive: true })
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const cookie = await getUiCookie(baseUrl)
  const wsResp = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
  })
  const ws = (await wsResp.json()) as { id: string }
  return { dataDir, hive, workspaceId: ws.id, workspacePath }
}

describe('workflow agent isolation: worktree', () => {
  test('commits stay on hive/wf-* and the workspace root stays clean', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(true)
    const binDir = join(dataDir, 'bin')
    writeReportingWorker(binDir, 'commit')
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, '.hive/workflows/iso-commit.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'iso-commit', description: 'd' }",
        "return await agent('write isolated.txt and commit', { isolation: 'worktree', label: 'iso' })",
      ].join('\n')
    )
    try {
      const started = await hive.store.startWorkflow({
        hivePort: String(hive.port),
        scriptPath,
        workspaceId,
      })
      const run = await waitForRun(hive.store, started.id)
      expect(run.status).toBe('completed')
      expect(typeof run.result).toBe('string')
      const report = String(run.result)
      expect(report.startsWith('cwd=')).toBe(true)
      const cwdLine = report.split('\n')[0] ?? ''
      const workerCwd = cwdLine.slice('cwd='.length)
      expect(workerCwd).not.toBe(workspacePath)
      expect(workerCwd).toContain(join('hive-worktrees', workspaceId))

      const meta = parseWorktreeLine(report)
      expect(meta.branch).toMatch(/^hive\/wf-/)
      expect(meta.kept).toBe(true)
      expect(meta.path).toBe('')
      expect(existsSync(workflowWorktreeDir(workspaceId, meta.branch))).toBe(false)
      expect(existsSync(join(workspacePath, 'isolated.txt'))).toBe(false)
      expect(git(['status', '--porcelain'], workspacePath)).toBe('')
      expect(git(['rev-list', '--count', `${meta.base}..${meta.branch}`], workspacePath)).toBe('1')
      expect(git(['show', `${meta.branch}:isolated.txt`], workspacePath)).toContain('from-worktree')
    } finally {
      await hive.close()
    }
  }, 60_000)

  test('unchanged worktree deletes the branch and removes the directory', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(true)
    const binDir = join(dataDir, 'bin')
    writeReportingWorker(binDir, 'noop')
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, '.hive/workflows/iso-noop.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'iso-noop', description: 'd' }",
        "return await agent('report only', { isolation: 'worktree', label: 'noop' })",
      ].join('\n')
    )
    try {
      const started = await hive.store.startWorkflow({
        hivePort: String(hive.port),
        scriptPath,
        workspaceId,
      })
      const run = await waitForRun(hive.store, started.id)
      expect(run.status).toBe('completed')
      const meta = parseWorktreeLine(String(run.result))
      expect(meta.kept).toBe(false)
      expect(meta.path).toBe('')
      expect(git(['branch', '--list', meta.branch], workspacePath)).toBe('')
      expect(existsSync(workflowWorktreeDir(workspaceId, meta.branch))).toBe(false)
      expect(git(['status', '--porcelain'], workspacePath)).toBe('')
    } finally {
      await hive.close()
    }
  }, 60_000)

  test('uncommitted worktree keeps the directory and branch', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(true)
    const binDir = join(dataDir, 'bin')
    writeReportingWorker(binDir, 'dirty')
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, '.hive/workflows/iso-dirty.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'iso-dirty', description: 'd' }",
        "return await agent('write dirty.txt without commit', { isolation: 'worktree', label: 'dirty' })",
      ].join('\n')
    )
    try {
      const started = await hive.store.startWorkflow({
        hivePort: String(hive.port),
        scriptPath,
        workspaceId,
      })
      const run = await waitForRun(hive.store, started.id)
      expect(run.status).toBe('completed')
      const meta = parseWorktreeLine(String(run.result))
      leftoverWorktrees.push({
        branch: meta.branch,
        path: meta.path,
        workspacePath,
      })
      expect(meta.kept).toBe(true)
      expect(meta.path.length).toBeGreaterThan(0)
      expect(existsSync(meta.path)).toBe(true)
      expect(existsSync(join(meta.path, 'dirty.txt'))).toBe(true)
      expect(git(['branch', '--list', meta.branch], workspacePath).length).toBeGreaterThan(0)
      expect(git(['status', '--porcelain'], workspacePath)).toBe('')
    } finally {
      await hive.close()
    }
  }, 60_000)

  test('non-git workspace fails the agent call without falling back to shared', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(false)
    const binDir = join(dataDir, 'bin')
    writeReportingWorker(binDir, 'noop')
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, '.hive/workflows/iso-nongit.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'iso-nongit', description: 'd' }",
        "return await agent('should fail', { isolation: 'worktree' })",
      ].join('\n')
    )
    try {
      const started = await hive.store.startWorkflow({
        hivePort: String(hive.port),
        scriptPath,
        workspaceId,
      })
      const run = await waitForRun(hive.store, started.id)
      expect(run.status).toBe('failed')
      expect(existsSync(join(tmpdir(), 'hive-worktrees', workspaceId))).toBe(false)
      expect(hive.store.listWorkers(workspaceId).filter((item) => item.ephemeral === true)).toEqual(
        []
      )
      expect(hive.store.listOpenDispatches(workspaceId)).toEqual([])
    } finally {
      await hive.close()
    }
  }, 60_000)

  test('abort mid-run with worktree isolation cleans the dir and hive/wf-* branch', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(true)
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, '.hive/workflows/iso-abort.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'iso-abort', description: 'd' }",
        "return await agent('hang until stopped', { isolation: 'worktree', label: 'abortme' })",
      ].join('\n')
    )
    try {
      const started = await hive.store.startWorkflow({
        hivePort: String(hive.port),
        scriptPath,
        workspaceId,
      })
      const deadline = Date.now() + 20_000
      while (Date.now() <= deadline) {
        if (existsSync(join(tmpdir(), 'hive-worktrees', workspaceId))) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(existsSync(join(tmpdir(), 'hive-worktrees', workspaceId))).toBe(true)
      expect(hive.store.stopWorkflowRun(started.id)).toBe(true)
      const run = await waitForRun(hive.store, started.id)
      expect(run.status).toBe('stopped')
      const wtRoot = join(tmpdir(), 'hive-worktrees', workspaceId)
      const leftoverWorktreeDirs = () =>
        existsSync(wtRoot) ? readdirSync(wtRoot).filter((name) => name.startsWith('hive-wf-')) : []
      const cleanupDeadline = Date.now() + 10_000
      while (Date.now() <= cleanupDeadline) {
        if (
          git(['branch', '--list', 'hive/wf-*'], workspacePath) === '' &&
          leftoverWorktreeDirs().length === 0
        ) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(leftoverWorktreeDirs()).toEqual([])
      expect(git(['branch', '--list', 'hive/wf-*'], workspacePath)).toBe('')
    } finally {
      await hive.close()
    }
  }, 60_000)

  test('runtime restart orphan cleanup removes a clean worktree dir and hive/wf-* branch', async () => {
    const { dataDir, hive, workspaceId, workspacePath } = await setupHiveWorkspace(true)
    const handle = await createWorkflowWorktree({
      label: 'orphan',
      runId: randomUUID(),
      step: 1,
      workspaceId,
      workspacePath,
    })
    leftoverWorktrees.push({
      branch: handle.branch,
      path: handle.dir,
      workspacePath,
    })
    hive.store.addWorkerWithLaunch(
      workspaceId,
      { ephemeral: true, name: 'wf-orphan', role: 'coder', spawnedBy: 'workflow' },
      { args: [], command: 'claude', cwd: handle.dir }
    )
    await hive.close()

    const store2 = createRuntimeStore({ dataDir })
    try {
      const deadline = Date.now() + 10_000
      while (Date.now() <= deadline) {
        if (
          !existsSync(handle.dir) &&
          git(['branch', '--list', handle.branch], workspacePath) === ''
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(store2.listWorkers(workspaceId).some((item) => item.name === 'wf-orphan')).toBe(false)
      expect(existsSync(handle.dir)).toBe(false)
      expect(git(['branch', '--list', handle.branch], workspacePath)).toBe('')
    } finally {
      await store2.close()
    }
  }, 60_000)
})
