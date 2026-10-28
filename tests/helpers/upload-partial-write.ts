import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createWorkspaceUploadStore } from '../../src/server/workspace-upload-store.js'

process.on('SIGXFSZ', () => {})
const root = process.argv[2]
assert(root)
const limit = readFileSync('/proc/self/limits', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('Max file size'))
assert.match(limit ?? '', /65536\s+65536/)
const db = openRuntimeDatabase()
db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
  'fixture',
  'Fixture',
  root,
  0
)
const store = createWorkspaceUploadStore(db, join(root, 'uploads'))
try {
  const small = await store.saveUpload({
    workspaceId: 'fixture',
    originalName: 'small.bin',
    data: Buffer.from('success'),
  })
  const dir = join(root, 'uploads', 'fixture')
  const before = readdirSync(dir)
  await assert.rejects(
    writeFile(join(root, 'native.bin'), Buffer.alloc(1024 * 1024), { flag: 'wx' }),
    { code: 'EFBIG' }
  )
  assert.equal(statSync(join(root, 'native.bin')).size, 65536)
  await assert.rejects(
    store.saveUpload({
      workspaceId: 'fixture',
      originalName: 'large.bin',
      data: Buffer.alloc(1024 * 1024),
    }),
    { statusCode: 500, message: 'Upload could not be saved' }
  )
  assert.equal(store.listUploads('fixture').length, 1)
  assert.equal((await store.readUpload('fixture', small.id))?.data.toString(), 'success')
  db.close()
  const after = readdirSync(dir)
  console.log(
    JSON.stringify({
      nativeError: 'EFBIG',
      nativePartialBytes: 65536,
      mappedStoreStatus: 500,
      rows: 1,
      before,
      after,
      databaseClosed: !db.isOpen,
    })
  )
  assert.deepEqual(after, before, 'failed upload must leave no unrecorded file after close')
} finally {
  if (db.isOpen) db.close()
}
