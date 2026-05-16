import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import {
  type CommandPreset,
  listCommandPresets,
  listRoleTemplates,
  type RoleTemplate,
} from '../api.js'
import { useI18n } from '../i18n.js'
import type { UiLanguage } from '../uiLanguage.js'
import { generateWorkerName } from './randomWorkerName.js'
import type { WorkerActions } from './useWorkerActions.js'

interface UseWorkerComposerInput {
  createWorker: WorkerActions['createWorker']
  open: boolean
}

export interface WorkerComposerState {
  commandPresets: CommandPreset[]
  commandPresetId: string
  createWorkerError: string | null
  creating: boolean
  roleDescription: string
  roleDescriptionDefault: string
  startupCommand: string
  workerName: string
  workerRole: WorkerRole
  setCommandPresetId: (value: string) => void
  setRoleDescription: (value: string) => void
  setStartupCommand: (value: string) => void
  setWorkerName: (value: string) => void
  setWorkerRole: (value: WorkerRole) => void
  randomizeWorkerName: () => void
  resetRoleDescription: () => void
  resetError: () => void
  submit: (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => void
}

const fallbackRoleDescriptions: Record<UiLanguage, Record<WorkerRole, string>> = {
  en: {
    coder: [
      'You are a Coder. Turn clearly scoped tasks into the smallest correct code change.',
      'Working style:',
      '- Read the relevant files and local patterns before editing.',
      '- Prefer small changes; avoid unrelated refactors and scope creep.',
      '- Run validation that covers the risk. If you cannot validate, explain why.',
      'Report changed files, verification, remaining risk, and blockers.',
    ].join('\n'),
    custom: [
      "You are a custom team member. Rewrite this into the member's operating contract.",
      'Recommended shape:',
      '- Goal: what this member owns.',
      '- Boundaries: what to do and what to avoid.',
      '- Working style: how to inspect, edit, verify, or review.',
      '- Done means: what results, risks, and blockers to report.',
    ].join('\n'),
    reviewer: [
      'You are a Reviewer. Focus on quality review; do not replace the Orchestrator or edit by default.',
      'Working style:',
      '- Prioritize real bugs, regressions, edge cases, and test gaps.',
      '- For each issue, include severity, file/line, trigger condition, and minimal fix.',
      '- If no high-risk issue exists, state residual risk and unverified scope.',
      'Report blocking issues first, ordered by severity.',
    ].join('\n'),
    tester: [
      'You are a Tester. Reproduce, test, and produce concrete verification evidence.',
      'Working style:',
      '- Clarify the behavior, entry point, and failure condition under test.',
      '- Prefer real commands or real paths. Add a minimal test when useful.',
      '- Record commands, results, key output, and uncovered scenarios.',
      'Report pass/fail/unverified separately, then suggest the next step.',
    ].join('\n'),
  },
  zh: {
    coder: [
      '你是实现型 Coder，负责把明确任务落成最小正确代码改动。',
      '工作方式：',
      '- 先阅读相关文件和现有模式，再动手。',
      '- 优先小步修改，避免无关重构和范围扩张。',
      '- 改动后运行能覆盖风险的验证命令；不能验证时说明原因。',
      '交付说明要包含：改动文件、验证结果、剩余风险或阻塞。',
    ].join('\n'),
    custom: [
      '你是自定义成员。请把这段改成该成员的行为契约。',
      '建议包含：',
      '- 目标：这个成员主要负责什么。',
      '- 边界：哪些事可以做，哪些事不要做。',
      '- 工作方式：如何调查、修改、验证或审查。',
      '- 完成标准：交付时需要说明哪些结果、风险和阻塞。',
    ].join('\n'),
    reviewer: [
      '你是监工型 Reviewer，负责质量审查，不替代 Orchestrator，也不默认改代码。',
      '工作方式：',
      '- 优先找真实 bug、回归风险、边界条件和测试缺口。',
      '- 发现问题时给出严重度、文件/行号、触发条件和最小修复建议。',
      '- 没有高风险问题时明确说清剩余风险和未验证范围。',
      '交付说明按严重度排序，先列 blocking 问题。',
    ].join('\n'),
    tester: [
      '你是验证型 Tester，负责复现、测试和证据化验证。',
      '工作方式：',
      '- 先明确要验证的行为、入口和失败条件。',
      '- 优先跑真实命令或真实链路；必要时补充最小测试。',
      '- 记录命令、结果、关键输出和不能覆盖的场景。',
      '交付说明要区分通过、失败、未验证和建议下一步。',
    ].join('\n'),
  },
}

const getDefaultDescription = (
  role: WorkerRole,
  roleTemplates: RoleTemplate[],
  language: UiLanguage
) =>
  language === 'zh'
    ? (roleTemplates.find((template) => template.roleType === role)?.description ??
      fallbackRoleDescriptions.zh[role])
    : fallbackRoleDescriptions.en[role]

export const useWorkerComposer = ({
  createWorker,
  open,
}: UseWorkerComposerInput): WorkerComposerState => {
  const { language } = useI18n()
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([])
  const [roleDescription, setRoleDescriptionState] = useState(
    fallbackRoleDescriptions[language].coder
  )
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState('claude')
  const [commandPresetTouched, setCommandPresetTouched] = useState(false)
  const [startupCommand, setStartupCommand] = useState('')
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const workerNameGeneratedRef = useRef(false)
  const roleDescriptionEditedRef = useRef(false)
  const roleDescriptionDefault = getDefaultDescription(workerRole, roleTemplates, language)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        setCommandPresets(presets)
        setCommandPresetId((current) => {
          if (presets.some((preset) => preset.id === current && preset.available)) return current
          return (
            presets.find((preset) => preset.id === 'claude' && preset.available)?.id ??
            presets.find((preset) => preset.available)?.id ??
            presets[0]?.id ??
            ''
          )
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setCreateWorkerError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listRoleTemplates()
      .then((templates) => {
        if (cancelled) return
        setRoleTemplates(templates)
        if (!roleDescriptionEditedRef.current) {
          setRoleDescriptionState(getDefaultDescription(workerRole, templates, language))
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCreateWorkerError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, workerRole, language])

  useEffect(() => {
    if (!roleDescriptionEditedRef.current) {
      setRoleDescriptionState(getDefaultDescription(workerRole, roleTemplates, language))
    }
  }, [language, roleTemplates, workerRole])

  const setRoleDescription = (value: string) => {
    roleDescriptionEditedRef.current = true
    setRoleDescriptionState(value)
  }

  const setWorkerNameFromUser = (value: string) => {
    workerNameGeneratedRef.current = false
    setWorkerName(value)
  }

  const randomizeWorkerName = () => {
    workerNameGeneratedRef.current = true
    setWorkerName(generateWorkerName(language))
  }

  useEffect(() => {
    if (workerNameGeneratedRef.current) {
      setWorkerName(generateWorkerName(language))
    }
  }, [language])

  const selectWorkerRole = (value: WorkerRole) => {
    setWorkerRole(value)
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(getDefaultDescription(value, roleTemplates, language))
  }

  const resetRoleDescription = () => {
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(roleDescriptionDefault)
  }

  const selectCommandPresetId = (value: string) => {
    setCommandPresetTouched(true)
    setCommandPresetId(value)
  }

  const submit = (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => {
    event.preventDefault()
    setCreating(true)
    setCreateWorkerError(null)
    const launchPresetId = startupCommand.trim() && !commandPresetTouched ? '' : commandPresetId
    void createWorker({
      commandPresetId: launchPresetId,
      name: workerName,
      role: workerRole,
      roleDescription,
      startupCommand,
    })
      .then(({ error }) => {
        setWorkerName('')
        workerNameGeneratedRef.current = false
        selectWorkerRole('coder')
        setCommandPresetId('claude')
        setCommandPresetTouched(false)
        setStartupCommand('')
        onSuccess()
        if (error) setCreateWorkerError(error)
      })
      .catch((error) => {
        setCreateWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setCreating(false))
  }

  return {
    commandPresets,
    commandPresetId,
    createWorkerError,
    creating,
    roleDescription,
    roleDescriptionDefault,
    startupCommand,
    workerName,
    workerRole,
    setCommandPresetId: selectCommandPresetId,
    setRoleDescription,
    setStartupCommand,
    setWorkerName: setWorkerNameFromUser,
    setWorkerRole: selectWorkerRole,
    randomizeWorkerName,
    resetRoleDescription,
    resetError: () => setCreateWorkerError(null),
    submit,
  }
}
