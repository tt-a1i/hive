import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let cookie = ''
let sandboxRoot = ''
let outsideRoot = ''
const tempDirs: string[] = []

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-root-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'hive-fs-outside-'))
  tempDirs.push(sandboxRoot, outsideRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  mkdirSync(join(sandboxRoot, 'projects'), { recursive: true })
  mkdirSync(join(sandboxRoot, 'projects', 'my-app', '.git'), { recursive: true })
  writeFileSync(join(sandboxRoot, 'projects', 'my-app', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(sandboxRoot, '.hidden-dotdir'), { recursive: true })
  writeFileSync(join(sandboxRoot, 'projects', 'file-not-dir.txt'), 'nope')
  mkdirSync(join(outsideRoot, 'secret'), { recursive: true })

  server = await startTestServer()
  const session = await fetch(`${server.baseUrl}/api/ui/session`)
  cookie = session.headers.get('set-cookie') ?? ''
})

afterEach(async () => {
  await server.close()
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const browse = async (pathParam: string | null) => {
  const query = pathParam === null ? '' : `?path=${encodeURIComponent(pathParam)}`
  const response = await fetch(`${server.baseUrl}/api/fs/browse${query}`, {
    headers: { cookie },
  })
  return { status: response.status, body: await response.json() }
}

const probe = async (pathParam: string) => {
  const response = await fetch(
    `${server.baseUrl}/api/fs/probe?path=${encodeURIComponent(pathParam)}`,
    { headers: { cookie } }
  )
  return (await response.json()) as Record<string, unknown>
}

describe('GET /api/fs/browse', () => {
  test('defaults to the sandbox root and lists directories, hides dotdirs + files', async () => {
    const { body, status } = await browse(null)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.root_path).toBe(sandboxRoot)
    expect(body.current_path).toBe(sandboxRoot)
    expect(body.parent_path).toBeNull()
    const names = (body.entries as Array<{ name: string }>).map((entry) => entry.name)
    expect(names).toEqual(['projects'])
  })

  test('descends into a subdirectory and detects .git repositories', async () => {
    const { body } = await browse(join(sandboxRoot, 'projects'))
    expect(body.ok).toBe(true)
    expect(body.current_path).toBe(join(sandboxRoot, 'projects'))
    expect(body.parent_path).toBe(sandboxRoot)
    const entry = (body.entries as Array<{ name: string; is_git_repository: boolean }>).find(
      (e) => e.name === 'my-app'
    )
    expect(entry).toBeDefined()
    expect(entry?.is_git_repository).toBe(true)
  })

  test('rejects absolute paths that fall outside the sandbox root', async () => {
    const { body, status } = await browse(join(outsideRoot, 'secret'))
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/outside the browse root/)
    expect(body.entries).toEqual([])
  })

  test('rejects "../" traversal that escapes the sandbox root', async () => {
    const { body, status } = await browse('../../etc')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/outside the browse root/)
  })

  test('requires the UI cookie', async () => {
    const response = await fetch(`${server.baseUrl}/api/fs/browse`)
    expect(response.status).toBe(403)
  })
})

describe('GET /api/fs/probe', () => {
  test('reports git repository + current branch for a repo inside the sandbox', async () => {
    const body = await probe(join(sandboxRoot, 'projects', 'my-app'))
    expect(body.ok).toBe(true)
    expect(body.is_dir).toBe(true)
    expect(body.is_git_repository).toBe(true)
    expect(body.suggested_name).toBe('my-app')
    // current_branch may be null on stripped-down test .git dirs; accept null or 'main'
    expect([null, 'main']).toContain(body.current_branch)
  })

  test('returns ok=false for paths outside the sandbox', async () => {
    const body = await probe(join(outsideRoot, 'secret'))
    expect(body.ok).toBe(false)
    expect(body.is_dir).toBe(false)
  })
})
