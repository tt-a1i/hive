import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let cookie = ''
let vendorRoot = ''
const tempDirs: string[] = []

const writeFixtureAgent = (
  langDir: string,
  relativePath: string,
  frontmatter: Record<string, string>,
  body: string
) => {
  const filePath = join(langDir, relativePath)
  mkdirSync(join(langDir, relativePath, '..'), { recursive: true })
  const fmLines = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  writeFileSync(filePath, `---\n${fmLines}\n---\n${body}`)
}

beforeEach(async () => {
  vendorRoot = mkdtempSync(join(tmpdir(), 'hive-marketplace-root-'))
  tempDirs.push(vendorRoot)
  process.env.HIVE_MARKETPLACE_VENDOR_ROOT = vendorRoot

  const enDir = join(vendorRoot, 'en')
  mkdirSync(enDir, { recursive: true })
  writeFixtureAgent(
    enDir,
    'engineering/code-reviewer.md',
    { name: 'Code Reviewer', description: 'Reviews code', emoji: '👁️', color: 'purple' },
    '# Code Reviewer\n\nReview every diff.\n'
  )
  writeFixtureAgent(
    enDir,
    'design/ui-designer.md',
    { name: 'UI Designer', description: 'Designs UI', emoji: '🎨', color: 'pink' },
    '# UI Designer\n'
  )
  writeFileSync(
    join(enDir, 'manifest.json'),
    JSON.stringify({
      source: {
        repo: 'msitarzewski/agency-agents',
        commit: 'abc123',
        fetched_at: '2026-05-22T00:00:00Z',
      },
      language: 'en',
      categories: ['design', 'engineering'],
      agents: [
        {
          path: 'engineering/code-reviewer.md',
          category: 'engineering',
          name: 'Code Reviewer',
          description: 'Reviews code',
          emoji: '👁️',
          color: 'purple',
        },
        {
          path: 'design/ui-designer.md',
          category: 'design',
          name: 'UI Designer',
          description: 'Designs UI',
          emoji: '🎨',
          color: 'pink',
        },
      ],
    })
  )

  const zhDir = join(vendorRoot, 'zh')
  mkdirSync(zhDir, { recursive: true })
  writeFixtureAgent(
    zhDir,
    'engineering/code-reviewer.md',
    { name: '代码审查员', description: '代码审查', emoji: '👀', color: 'purple' },
    '# 代码审查员\n'
  )
  writeFileSync(
    join(zhDir, 'manifest.json'),
    JSON.stringify({
      source: {
        repo: 'jnMetaCode/agency-agents-zh',
        commit: 'def456',
        fetched_at: '2026-05-22T00:00:00Z',
      },
      language: 'zh',
      categories: ['engineering'],
      agents: [
        {
          path: 'engineering/code-reviewer.md',
          category: 'engineering',
          name: '代码审查员',
          description: '代码审查',
          emoji: '👀',
          color: 'purple',
        },
      ],
    })
  )

  server = await startTestServer()
  const session = await fetch(`${server.baseUrl}/api/ui/session`)
  cookie = session.headers.get('set-cookie') ?? ''
})

afterEach(async () => {
  await server.close()
  delete process.env.HIVE_MARKETPLACE_VENDOR_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const getManifest = async (lang: string | null) => {
  const query = lang === null ? '' : `?lang=${encodeURIComponent(lang)}`
  const response = await fetch(`${server.baseUrl}/api/marketplace/manifest${query}`, {
    headers: { cookie },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const getAgent = async (lang: string | null, path: string | null) => {
  const params = new URLSearchParams()
  if (lang !== null) params.set('lang', lang)
  if (path !== null) params.set('path', path)
  const query = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${server.baseUrl}/api/marketplace/agent${query}`, {
    headers: { cookie },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('GET /api/marketplace/manifest', () => {
  test('returns the EN manifest with categories and agents', async () => {
    const { status, body } = await getManifest('en')
    expect(status).toBe(200)
    expect(body.language).toBe('en')
    expect(body.categories).toEqual(['design', 'engineering'])
    expect((body.agents as unknown[]).length).toBe(2)
  })

  test('returns the ZH manifest when lang=zh', async () => {
    const { status, body } = await getManifest('zh')
    expect(status).toBe(200)
    expect(body.language).toBe('zh')
    expect((body.agents as Array<{ name: string }>)[0]?.name).toBe('代码审查员')
  })

  test('rejects unknown language with 400', async () => {
    const { status, body } = await getManifest('fr')
    expect(status).toBe(400)
    expect(String(body.error)).toContain('lang')
  })

  test('rejects missing language with 400', async () => {
    const { status } = await getManifest(null)
    expect(status).toBe(400)
  })
})

describe('GET /api/marketplace/agent', () => {
  test('returns frontmatter and body for a valid path', async () => {
    const { status, body } = await getAgent('en', 'engineering/code-reviewer.md')
    expect(status).toBe(200)
    expect(body.path).toBe('engineering/code-reviewer.md')
    expect((body.frontmatter as Record<string, string>).name).toBe('Code Reviewer')
    expect(String(body.body)).toContain('Review every diff.')
  })

  test('serves the ZH agent independently of EN', async () => {
    const { status, body } = await getAgent('zh', 'engineering/code-reviewer.md')
    expect(status).toBe(200)
    expect((body.frontmatter as Record<string, string>).name).toBe('代码审查员')
  })

  test('rejects path traversal attempts with 404', async () => {
    const { status } = await getAgent('en', '../zh/engineering/code-reviewer.md')
    expect(status).toBe(404)
  })

  test('rejects absolute paths with 404', async () => {
    const { status } = await getAgent('en', '/etc/passwd')
    expect(status).toBe(404)
  })

  test('rejects non-.md paths with 404', async () => {
    const { status } = await getAgent('en', 'manifest.json')
    expect(status).toBe(404)
  })

  test('returns 404 for an agent that does not exist', async () => {
    const { status } = await getAgent('en', 'engineering/nonexistent.md')
    expect(status).toBe(404)
  })

  test('rejects unknown language with 400', async () => {
    const { status } = await getAgent('xx', 'engineering/code-reviewer.md')
    expect(status).toBe(400)
  })

  test('rejects missing path with 400', async () => {
    const { status } = await getAgent('en', null)
    expect(status).toBe(400)
  })
})
