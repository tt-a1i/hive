import { type FormEvent, useEffect, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import { type CommandPreset, listCommandPresets } from '../api.js'
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
  workerName: string
  workerRole: WorkerRole
  setCommandPresetId: (value: string) => void
  setWorkerName: (value: string) => void
  setWorkerRole: (value: WorkerRole) => void
  randomizeWorkerName: () => void
  resetError: () => void
  submit: (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => void
}

export const useWorkerComposer = ({
  createWorker,
  open,
}: UseWorkerComposerInput): WorkerComposerState => {
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState('claude')
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

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

  const submit = (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => {
    event.preventDefault()
    setCreating(true)
    setCreateWorkerError(null)
    void createWorker(workerName, workerRole, commandPresetId)
      .then(({ error }) => {
        setWorkerName('')
        setWorkerRole('coder')
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
    workerName,
    workerRole,
    setCommandPresetId,
    setWorkerName,
    setWorkerRole,
    randomizeWorkerName: () => setWorkerName(generateWorkerName()),
    resetError: () => setCreateWorkerError(null),
    submit,
  }
}
