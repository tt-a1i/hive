import { describe, expect, it } from 'vitest'

import {
  buildFullRecoveryBrief,
  buildMinimalDeltaBrief,
  buildTerminalNotice,
} from '../../src/server/discussion-recovery-templates.js'

describe('discussion-recovery-templates', () => {
  describe('buildFullRecoveryBrief', () => {
    it('includes topic, phase, round info', () => {
      const result = buildFullRecoveryBrief({
        topic: 'API 设计方案',
        phase: 'discussing',
        currentRound: 2,
        maxRounds: 3,
        ownSubmissions: [],
        visibleMessages: [],
        nextAction: '请用 team discuss --reply 提交你的第 2 轮回应',
      })
      expect(result).toContain('API 设计方案')
      expect(result).toContain('discussing')
      expect(result).toContain('2/3')
      expect(result).toContain('请用 team discuss --reply 提交你的第 2 轮回应')
    })

    it('includes own submissions when present', () => {
      const result = buildFullRecoveryBrief({
        topic: '测试讨论',
        phase: 'thinking',
        currentRound: 1,
        maxRounds: 3,
        ownSubmissions: ['我认为方案 A 更好', '补充：性能考虑'],
        visibleMessages: [],
        nextAction: '等待其他成员提交初始观点',
      })
      expect(result).toContain('你之前的提交')
      expect(result).toContain('我认为方案 A 更好')
      expect(result).toContain('补充：性能考虑')
    })

    it('includes visible messages when present', () => {
      const result = buildFullRecoveryBrief({
        topic: '架构讨论',
        phase: 'discussing',
        currentRound: 1,
        maxRounds: 2,
        ownSubmissions: [],
        visibleMessages: [
          { name: '米芾', text: '建议用事件驱动' },
          { name: '莫邪', text: '同意，但要考虑顺序' },
        ],
        nextAction: '请用 team discuss --reply 提交你的第 1 轮回应',
      })
      expect(result).toContain('最近讨论消息')
      expect(result).toContain('**米芾**: 建议用事件驱动')
      expect(result).toContain('**莫邪**: 同意，但要考虑顺序')
    })

    it('ends with the nextAction as final instruction', () => {
      const result = buildFullRecoveryBrief({
        topic: 'X',
        phase: 'concluding',
        currentRound: 3,
        maxRounds: 3,
        ownSubmissions: [],
        visibleMessages: [],
        nextAction: '请用 team discuss --final 提交最终结论',
      })
      const lines = result.split('\n').filter((l) => l.trim())
      expect(lines[lines.length - 1]).toBe('请用 team discuss --final 提交最终结论')
    })
  })

  describe('buildMinimalDeltaBrief', () => {
    it('outputs phase change with next action', () => {
      const result = buildMinimalDeltaBrief({
        topic: '方案评审',
        phase: 'concluding',
        currentRound: 3,
        nextAction: '请用 team discuss --final 提交最终结论',
      })
      expect(result).toContain('方案评审')
      expect(result).toContain('concluding')
      expect(result).toContain('轮次 3')
      expect(result).toContain('请用 team discuss --final 提交最终结论')
    })

    it('ends with the nextAction', () => {
      const result = buildMinimalDeltaBrief({
        topic: 'T',
        phase: 'discussing',
        currentRound: 2,
        nextAction: '请用 team discuss --reply 提交回应',
      })
      const lines = result.split('\n').filter((l) => l.trim())
      expect(lines[lines.length - 1]).toBe('请用 team discuss --reply 提交回应')
    })
  })

  describe('buildTerminalNotice', () => {
    it('handles concluded status', () => {
      const result = buildTerminalNotice({
        topic: '设计讨论',
        finalStatus: 'concluded',
        synthesisSnippet: '共识：采用方案 B',
      })
      expect(result).toContain('结束')
      expect(result).toContain('达成结论')
      expect(result).toContain('结论摘要')
      expect(result).toContain('共识：采用方案 B')
      expect(result).toContain('你可以继续执行其他任务')
    })

    it('handles cancelled status', () => {
      const result = buildTerminalNotice({
        topic: '风险评审',
        finalStatus: 'cancelled',
      })
      expect(result).toContain('取消')
      expect(result).toContain('被取消')
      expect(result).not.toContain('结论摘要')
      expect(result).toContain('你可以继续执行其他任务')
    })

    it('omits synthesis section when no snippet', () => {
      const result = buildTerminalNotice({
        topic: 'X',
        finalStatus: 'concluded',
      })
      expect(result).not.toContain('结论摘要')
    })
  })
})
