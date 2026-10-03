import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const runNode = async (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 20_000
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`child process timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      resolvePromise({ code, stderr, stdout })
    })
  })

describe('agent manager Windows PTY stop (real node-pty)', () => {
  test.runIf(process.platform === 'win32')(
    'stopping a real PTY does not leak node-pty AttachConsole helper stderr',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-real-pty-stop-'))
      tempDirs.push(root)
      const workspacePath = join(root, 'workspace')
      mkdirSync(workspacePath, { recursive: true })
      const agentScript = join(workspacePath, 'agent.js')
      writeFileSync(
        agentScript,
        [
          "process.stdout.write('started\\n')",
          "for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))",
          'setInterval(() => {}, 1000)',
        ].join('\n')
      )
      const runner = join(root, 'runner.mts')
      const nodePtyUrl = pathToFileURL(
        createRequire(import.meta.url).resolve('@lydell/node-pty')
      ).href
      const supportUrl = pathToFileURL(resolve('src/server/agent-manager-support.ts')).href
      const outputBusUrl = pathToFileURL(resolve('src/server/pty-output-bus.ts')).href
      writeFileSync(
        runner,
        [
          `import nodePty from ${JSON.stringify(nodePtyUrl)}`,
          `import { attachAgentPty } from ${JSON.stringify(supportUrl)}`,
          `import { createPtyOutputBus } from ${JSON.stringify(outputBusUrl)}`,
          'const { spawn } = nodePty',
          'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))',
          `const pty = spawn(process.execPath, [${JSON.stringify(agentScript)}], { cols: 80, rows: 24, cwd: ${JSON.stringify(workspacePath)}, env: process.env, name: 'xterm-256color', useConpty: true })`,
          'const run = {',
          "  agentId: 'agent-1',",
          '  exitCode: null,',
          "  output: '',",
          '  pid: pty.pid,',
          "  runId: 'run-1',",
          "  status: 'starting',",
          '  process: {',
          '    isStopped: () => false,',
          '    pause() {},',
          '    pid: pty.pid,',
          '    resize() {},',
          '    resume() {},',
          '    stop() {},',
          '    write() {},',
          '  },',
          '}',
          'const failingTaskkill = (_cmd, _args, done) => done(false)',
          "attachAgentPty(run, pty, createPtyOutputBus(), 'win32', failingTaskkill)",
          'const startDeadline = Date.now() + 10000',
          "while (!run.output.includes('started')) {",
          "  if (Date.now() > startDeadline) throw new Error('PTY did not start')",
          '  await sleep(25)',
          '}',
          'run.process.stop()',
          'const stopDeadline = Date.now() + 10000',
          "while (['starting', 'running'].includes(run.status)) {",
          "  if (Date.now() > stopDeadline) throw new Error('PTY did not stop')",
          '  await sleep(25)',
          '}',
          "console.log('stopped')",
        ].join('\n')
      )

      const tsxCli = join('node_modules', 'tsx', 'dist', 'cli.mjs')
      const result = await runNode(process.execPath, [tsxCli, runner], process.cwd())

      if (result.code !== 0) {
        throw new Error(
          [
            `real PTY stop runner exited with code ${result.code}`,
            '--- stdout ---',
            result.stdout,
            '--- stderr ---',
            result.stderr,
          ].join('\n')
        )
      }
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('stopped')
      expect(result.stderr).not.toContain('AttachConsole failed')
      expect(result.stderr).not.toContain('conpty_console_list_agent')
    },
    30_000
  )
})
