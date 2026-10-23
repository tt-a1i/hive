import type { TeamListItem } from '../shared/types.js'
import { getBuiltinCommandPresetByCommand } from './command-preset-defaults.js'
import type { RuntimeStore } from './runtime-store.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

export type TeamListEnrichmentStore = Pick<
  RuntimeStore,
  'getLastPtyLineForAgent' | 'peekAgentLaunchConfig' | 'settings'
> &
  Partial<Pick<RuntimeStore, 'getActiveRunByAgentId'>>

/** Only expose an explicitly configured model, never infer a provider default.
 * Raw launch arguments may contain credentials and must not enter the roster. */
export const readConfiguredModel = (args: readonly string[], command?: string): string | null => {
  const codex = normalizeExecutableToken(command) === 'codex'
  let model: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') break
    if (arg === '--model' || (codex && arg === '-m')) {
      const value = args[index + 1]
      if (value && !value.startsWith('-')) {
        model = value
        index += 1
      }
    } else if (arg?.startsWith('--model=')) {
      model = arg.slice('--model='.length) || null
    }
  }
  return model
}

/**
 * Resolves the built-in command preset id for a worker. Mirrors the launch-time
 * lookup in `agent-run-bootstrap.ts::resolveLaunchPreset`: explicit
 * `commandPresetId` first, then implicit by matching `config.command` against a
 * built-in preset record. Returns null when the worker was launched with a
 * custom command, when augmentation has been disabled on the config (the
 * launcher won't apply preset behavior, so claiming the brand logo would be a
 * lie), or when there is no launch config row yet (worker created but never
 * configured).
 */
export const resolveCommandPresetId = (
  store: Pick<RuntimeStore, 'peekAgentLaunchConfig' | 'settings'>,
  workspaceId: string,
  workerId: string
): string | null => {
  const config = store.peekAgentLaunchConfig(workspaceId, workerId)
  if (!config) return null
  if (config.presetAugmentationDisabled) return null
  if (config.commandPresetId) return config.commandPresetId
  const implicitBuiltin = getBuiltinCommandPresetByCommand(config.command)
  const implicit = store.settings.getCommandPreset(implicitBuiltin?.id ?? config.command)
  if (!implicit || implicit.command !== config.command) return null
  return implicit.id
}

/**
 * Folds transient signals exposed on team list payloads — last PTY line,
 * resolved command preset id, and startup readiness — into the in-memory
 * worker records. The records themselves stay narrow
 * (`workspace-store.listWorkers`) because the workspace store does not own
 * the launch cache or live runs; enrichment happens at the route boundary.
 */
export const enrichTeamList = (
  workspaceId: string,
  store: TeamListEnrichmentStore,
  workers: TeamListItem[]
): TeamListItem[] =>
  workers.map((worker) => {
    const line = store.getLastPtyLineForAgent(workspaceId, worker.id)
    const presetId = resolveCommandPresetId(store, workspaceId, worker.id)
    const next: TeamListItem = { ...worker }
    const config = store.peekAgentLaunchConfig(workspaceId, worker.id)
    next.configuredCommand = config?.command ?? null
    next.configuredModel =
      config && getBuiltinCommandPresetByCommand(normalizeExecutableToken(config.command) ?? '')
        ? readConfiguredModel(config.args ?? [], config.command)
        : null
    if (line !== null) next.lastPtyLine = line
    if (presetId !== null) next.commandPresetId = presetId
    next.startupReadyAt =
      store.getActiveRunByAgentId?.(workspaceId, worker.id)?.startupReadyAt ?? null
    return next
  })
