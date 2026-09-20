import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const root = fileURLToPath(new URL('../', import.meta.url))

test('MCP exposes the bounded Jev integration surface', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src', 'server.js')],
    cwd: root,
  })
  const client = new Client({ name: 'hive-jev-test', version: '0.1.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'hive_jev_browser_run',
      'hive_jev_compact_messages',
      'hive_jev_review_action',
      'hive_jev_route_task',
      'hive_jev_status',
    ])
    const status = await client.callTool({ name: 'hive_jev_status', arguments: {} })
    assert.equal(status.isError, undefined)
    const content = status.content[0]
    assert.equal(content?.type, 'text')
    if (!content || content.type !== 'text') throw new Error('Expected text status content.')
    const parsed = JSON.parse(content.text) as { hive_compatibility: string }
    assert.equal(parsed.hive_compatibility.includes('2.2.1'), true)
  } finally {
    await client.close()
  }
})
