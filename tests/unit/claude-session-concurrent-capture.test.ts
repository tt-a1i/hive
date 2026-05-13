import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  captureClaudeSessionId,
  encodeClaudeProjectPath,
  resetClaudeSessionClaimsForTests,
} from '../../src/server/session-capture-claude.js'

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  resetClaudeSessionClaimsForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('claude session concurrent capture', () => {
  test('two concurrent captures in one workspace claim distinct session ids', async () => {
    const root = join(tmpdir(), `hive-concurrent-capture-${crypto.randomUUID()}`)
    const cwd = '/tmp/hive-concurrent-capture-workspace'
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    mkdirSync(projectDir, { recursive: true })
    tempDirs.push(root)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = root
    const firstId = '88888888-8888-4888-8888-888888888888'
    const secondId = '99999999-9999-4999-8999-999999999999'
    const firstWrite = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeFileSync(join(projectDir, `${firstId}.jsonl`), '{}\n')
        resolve()
      }, 5)
    })
    const secondWrite = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeFileSync(join(projectDir, `${secondId}.jsonl`), '{}\n')
        resolve()
      }, 15)
    })
    const alice: string[] = []
    const bob: string[] = []

    const aliceCapture = captureClaudeSessionId(
      cwd,
      new Set(),
      (sessionId) => alice.push(sessionId),
      200,
      2
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    const bobCapture = captureClaudeSessionId(
      cwd,
      new Set(),
      (sessionId) => bob.push(sessionId),
      200,
      2
    )

    await Promise.all([aliceCapture, bobCapture, firstWrite, secondWrite])

    expect(alice).toHaveLength(1)
    expect(bob).toHaveLength(1)
    expect(new Set([alice[0], bob[0]])).toEqual(new Set([firstId, secondId]))
  })

  test('two concurrent captures in one workspace bind ids to the matching worker prompt', async () => {
    const root = join(tmpdir(), `hive-concurrent-capture-owner-${crypto.randomUUID()}`)
    const cwd = '/tmp/hive-concurrent-capture-owner-workspace'
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    mkdirSync(projectDir, { recursive: true })
    tempDirs.push(root)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = root
    const bobSessionId = '11111111-1111-4111-8111-111111111111'
    const aliceSessionId = '22222222-2222-4222-8222-222222222222'
    const aliceNeedle = '你是 Demo 的 Alice（coder）。'
    const bobNeedle = '你是 Demo 的 Bob（coder）。'
    const alice: string[] = []
    const bob: string[] = []

    const aliceCapture = captureClaudeSessionId(
      cwd,
      new Set(),
      (sessionId) => alice.push(sessionId),
      200,
      2,
      root,
      { contentIncludes: aliceNeedle }
    )
    const bobCapture = captureClaudeSessionId(
      cwd,
      new Set(),
      (sessionId) => bob.push(sessionId),
      200,
      2,
      root,
      { contentIncludes: bobNeedle }
    )

    writeFileSync(join(projectDir, `${bobSessionId}.jsonl`), `${bobNeedle}\n`)
    writeFileSync(join(projectDir, `${aliceSessionId}.jsonl`), `${aliceNeedle}\n`)

    await Promise.all([aliceCapture, bobCapture])

    expect(alice).toEqual([aliceSessionId])
    expect(bob).toEqual([bobSessionId])
  })
})
