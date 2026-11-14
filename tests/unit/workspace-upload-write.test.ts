import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createWorkspaceUploadStore } from '../../src/server/workspace-upload-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

// Deterministic ID injection only for collision coverage; native child imports are unmocked.
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
}))
const dirs: string[] = []
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-upload-write-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTestPath(dir)
})

test.skipIf(process.platform !== 'linux')(
  'native partial write removes only its created upload',
  (ctx) => {
    const available = spawnSync('prlimit', ['--version'], { timeout: 5_000 })
    if ((available.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      ctx.skip()
      return
    }
    expect(available.error).toBeUndefined()
    expect(available.status).toBe(0)
    const result = spawnSync(
      'prlimit',
      [
        '--fsize=65536:65536',
        '--',
        process.execPath,
        '--import',
        'tsx',
        'tests/helpers/upload-partial-write.ts',
        fixture(),
      ],
      {
        timeout: 15_000,
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
        encoding: 'utf8',
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  },
  20_000
)

test('injected ID collision preserves existing file and inserts no metadata', async () => {
  const root = fixture()
  const db = openRuntimeDatabase()
  try {
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      'fixture',
      'Fixture',
      root,
      0
    )
    const store = createWorkspaceUploadStore(db, root)
    const dir = join(root, 'fixture')
    mkdirSync(dir)
    const path = join(dir, '11111111-1111-4111-8111-111111111111.bin')
    writeFileSync(path, 'existing bytes')
    await expect(
      store.saveUpload({
        workspaceId: 'fixture',
        originalName: 'collision.bin',
        data: Buffer.from('replacement'),
      })
    ).rejects.toMatchObject({ statusCode: 500, message: 'Upload could not be saved' })
    expect(readFileSync(path, 'utf8')).toBe('existing bytes')
    expect(readdirSync(dir)).toEqual(['11111111-1111-4111-8111-111111111111.bin'])
    expect(store.listUploads('fixture')).toEqual([])
  } finally {
    db.close()
  }
})
