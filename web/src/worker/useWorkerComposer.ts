import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import {
  type CommandPreset,
  listCommandPresets,
  listRoleTemplates,
  type RoleTemplate,
} from '../api.js'
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
  workerName: string
  workerRole: WorkerRole
  setCommandPresetId: (value: string) => void
  setRoleDescription: (value: string) => void
  setWorkerName: (value: string) => void
  setWorkerRole: (value: WorkerRole) => void
  randomizeWorkerName: () => void
  resetRoleDescription: () => void
  resetError: () => void
  submit: (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => void
}

const fallbackRoleDescriptions: Record<WorkerRole, string> = {
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
}

const getDefaultDescription = (role: WorkerRole, roleTemplates: RoleTemplate[]) =>
  roleTemplates.find((template) => template.roleType === role)?.description ??
  fallbackRoleDescriptions[role]

export const useWorkerComposer = ({
  createWorker,
  open,
}: UseWorkerComposerInput): WorkerComposerState => {
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([])
  const [roleDescription, setRoleDescriptionState] = useState(fallbackRoleDescriptions.coder)
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState('claude')
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const roleDescriptionEditedRef = useRef(false)
  const roleDescriptionDefault = getDefaultDescription(workerRole, roleTemplates)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        setCommandPresets(presets)
        setCommandPresetId((current) => {
          if (presets.some((preset) => preset.id === current)) return current
          return presets.find((preset) => preset.id === 'claude')?.id ?? presets[0]?.id ?? ''
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
          setRoleDescriptionState(getDefaultDescription(workerRole, templates))
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
  }, [open, workerRole])

  const setRoleDescription = (value: string) => {
    roleDescriptionEditedRef.current = true
    setRoleDescriptionState(value)
  }

  const selectWorkerRole = (value: WorkerRole) => {
    setWorkerRole(value)
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(getDefaultDescription(value, roleTemplates))
  }

  const resetRoleDescription = () => {
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(roleDescriptionDefault)
  }

  const submit = (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => {
    event.preventDefault()
    setCreating(true)
    setCreateWorkerError(null)
    void createWorker(workerName, workerRole, commandPresetId, roleDescription)
      .then(({ error }) => {
        setWorkerName('')
        selectWorkerRole('coder')
        setCommandPresetId('claude')
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
    workerName,
    workerRole,
    setCommandPresetId,
    setRoleDescription,
    setWorkerName,
    setWorkerRole: selectWorkerRole,
    randomizeWorkerName: () => setWorkerName(generateWorkerName()),
    resetRoleDescription,
    resetError: () => setCreateWorkerError(null),
    submit,
  }
}
