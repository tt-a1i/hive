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
  coder: '你是实现型 worker。专注编码与最小正确改动，完成后用 team report 汇报结果、风险与产物。',
  custom:
    '你是自定义 worker。按派单要求完成任务，边界不清时先澄清，完成后必须用 team report 汇报。',
  reviewer: '你是审查型 worker。专注发现 bug、回归风险、边界条件和测试缺口，结论要具体可执行。',
  tester: '你是测试型 worker。专注复现问题、补充验证、运行测试并确认行为与 spec 一致。',
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
