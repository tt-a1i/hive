import { describe, expect, test } from 'vitest'

import { buildRecoverySummary } from '../../src/server/recovery-summary.js'

describe('recovery summary', () => {
  test('builds layer-b handoff text from messages tasks and workers', () => {
    const summary = buildRecoverySummary({
      workspaceName: 'my-app',
      agentRole: 'orchestrator',
      tasksContent: '- [ ] implement login\n',
      workers: [
        { id: 'alice', name: 'Alice', role: 'coder', status: 'working', pendingTaskCount: 1 },
        { id: 'bob', name: 'Bob', role: 'tester', status: 'idle', pendingTaskCount: 0 },
      ],
      messages: [
        { type: 'user_input', text: '帮我实现登录', createdAt: 1 },
        { type: 'send', to: 'alice', text: '实现登录接口', createdAt: 2 },
        { type: 'report', from: 'bob', text: '测试通过', status: 'success', createdAt: 3 },
      ],
    })

    expect(summary).toContain('你是 my-app 的 orchestrator')
    expect(summary).toContain('最近 1 小时与 user 的对话')
    expect(summary).toContain('帮我实现登录')
    expect(summary).toContain('实现登录接口')
    expect(summary).toContain('当前 tasks.md 状态')
    expect(summary).toContain('- [ ] implement login')
    expect(summary).toContain('Alice (coder, working)')
    expect(summary).toContain('Bob (tester, idle)')
  })
})
