import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

interface UploadResponse {
  id: string
  original_name: string
  size_bytes: number
  url: string
}

const cases = [
  { name: 'ASCII truncation', filename: 'a'.repeat(181), expected: 'a'.repeat(180) },
  {
    name: 'exactly fitting emoji',
    filename: `${'a'.repeat(178)}😀`,
    expected: `${'a'.repeat(178)}😀`,
  },
  {
    name: 'emoji crossing the stored-name limit',
    filename: `${'a'.repeat(179)}😀`,
    expected: 'a'.repeat(179),
  },
  {
    name: 'emoji crossing the input limit before basename sanitization',
    // All components are ordinary names; the leaf is short, but the relative
    // filename places its emoji across the route's 1024 UTF-16-unit cap.
    filename: `${'reports/'.repeat(126)}${'a'.repeat(15)}😀.txt`,
    expected: 'a'.repeat(15),
  },
]

test.each(cases)('$name survives HTTP, SQLite reload and download', async ({
  filename,
  expected,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-upload-name-'))
  const dataDir = join(root, 'data')
  const bytes = Buffer.from('unicode upload fixture\n', 'utf8')
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  try {
    server = await startTestServer({ dataDir })
    let cookie = await getUiCookie(server.baseUrl)
    const workspace = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Uploads', path: root, autostart_orchestrator: false }),
    })
    expect(workspace.status).toBe(201)
    const { id: workspaceId } = (await workspace.json()) as { id: string }
    const uploadPath = `/api/workspaces/${workspaceId}/uploads`
    const post = await fetch(`${server.baseUrl}${uploadPath}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ filename, data: bytes.toString('base64') }),
    })
    expect(post.status).toBe(201)
    const uploaded = (await post.json()) as UploadResponse

    for (const phase of ['initial', 'reloaded']) {
      if (phase === 'reloaded') {
        await server.close()
        server = undefined
        server = await startTestServer({ dataDir })
        cookie = await getUiCookie(server.baseUrl)
      }
      const list = await fetch(`${server.baseUrl}${uploadPath}`, { headers: { cookie } })
      expect(list.status).toBe(200)
      const rows = (await list.json()) as UploadResponse[]
      const persisted = rows.find((row) => row.id === uploaded.id)
      expect(persisted).toBeDefined()
      const download = await fetch(`${server.baseUrl}${uploaded.url}`, { headers: { cookie } })
      expect(download.status).toBe(200)
      const disposition = download.headers.get('content-disposition')
      expect(disposition).toContain("filename*=UTF-8''")
      const downloadName = decodeURIComponent(disposition?.split("filename*=UTF-8''")[1] ?? '')
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
      expect(uploaded.size_bytes).toBe(bytes.byteLength)
      expect.soft(uploaded.original_name, `${phase}: POST filename`).toBe(expected)
      expect.soft(persisted?.original_name, `${phase}: SQLite filename`).toBe(expected)
      expect.soft(downloadName, `${phase}: download filename`).toBe(expected)
      expect
        .soft(uploaded.original_name, `${phase}: POST/list consistency`)
        .toBe(persisted?.original_name)
      expect
        .soft(downloadName, `${phase}: list/download consistency`)
        .toBe(persisted?.original_name)
    }
  } finally {
    await server?.close()
    removeTestPath(root)
  }
})
