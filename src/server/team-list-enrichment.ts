import type { TeamListItem } from '../shared/types.js'
import type { RuntimeStore } from './runtime-store.js'

export type TeamListEnrichmentStore = Pick<
  RuntimeStore,
  'getLastPtyLineForAgent' | 'peekAgentLaunchConfig' | 'settings'
>

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
  const implicit = store.settings.getCommandPreset(config.command)
  if (!implicit || implicit.command !== config.command) return null
  return implicit.id
}

/**
 * Folds the two transient signals exposed on team list payloads — last PTY
 * line (read fresh per request) and resolved command preset id (read from the
 * launch cache) — into the in-memory worker records. The records themselves
 * stay narrow (`workspace-store.listWorkers`) because the workspace store does
 * not own the launch cache; enrichment happens at the route boundary instead.
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
    if (line !== null) next.lastPtyLine = line
    if (presetId !== null) next.commandPresetId = presetId
    return next
  })
