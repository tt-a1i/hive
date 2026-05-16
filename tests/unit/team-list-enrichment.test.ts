import { describe, expect, test, vi } from 'vitest'

import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { enrichTeamList, resolveCommandPresetId } from '../../src/server/team-list-enrichment.js'
import type { TeamListItem } from '../../src/shared/types.js'

/**
 * Synthesizes the minimal slice of RuntimeStore that enrichTeamList reads.
 * Casts to `Pick<RuntimeStore, ...>` because we only model the three methods;
 * a full RuntimeStore mock would drown the test in irrelevant noise.
 */
const makeStore = ({
  launchConfigs,
  lastPtyLines,
  knownPresets,
}: {
  launchConfigs: Map<string, AgentLaunchConfigInput>
  lastPtyLines?: Map<string, string>
  knownPresets?: Set<string>
}) =>
  ({
    getLastPtyLineForAgent: vi.fn(
      (_workspaceId: string, agentId: string) => lastPtyLines?.get(agentId) ?? null
    ),
    peekAgentLaunchConfig: vi.fn((_workspaceId: string, agentId: string) =>
      launchConfigs.get(agentId)
    ),
    settings: {
      // The real settings.getCommandPreset returns a CommandPresetRecord;
      // resolveLaunchPreset only reads `command` + `id`, so the test stub
      // returns the smallest shape that lets the lookup succeed.
      getCommandPreset: vi.fn((id: string) =>
        knownPresets?.has(id) ? { id, command: id } : undefined
      ),
    },
  }) as unknown as Pick<
    RuntimeStore,
    'getLastPtyLineForAgent' | 'peekAgentLaunchConfig' | 'settings'
  >

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'alice',
  role: 'coder',
  status: 'idle',
  pendingTaskCount: 0,
  ...overrides,
})

describe('resolveCommandPresetId', () => {
  test('returns the explicit commandPresetId when the launch config carries one', () => {
    // Happy path — worker was created via the Add dialog with a preset chip
    // selected, so configureAgentLaunch wrote `claude` to the row directly.
    const store = makeStore({
      launchConfigs: new Map([
        ['worker-1', { command: 'claude', args: [], commandPresetId: 'claude' }],
      ]),
    })
    expect(resolveCommandPresetId(store, 'ws-1', 'worker-1')).toBe('claude')
  })

  test('falls back to implicit lookup when commandPresetId is null but command matches a preset', () => {
    // Real-world case: an older worker whose launch_config row predates the
    // command_preset_id column. We can still recover the preset by matching
    // `config.command` against the built-in registry (this mirrors
    // agent-run-bootstrap.ts::resolveLaunchPreset).
    const store = makeStore({
      launchConfigs: new Map([['worker-1', { command: 'codex', args: [] }]]),
      knownPresets: new Set(['codex']),
    })
    expect(resolveCommandPresetId(store, 'ws-1', 'worker-1')).toBe('codex')
  })

  test('returns null when there is no launch config row at all', () => {
    // Newly-added worker with no preset chip picked and no later
    // configureAgentLaunch call — the row simply does not exist. Frontend
    // must fall back to the role-letter avatar.
    const store = makeStore({ launchConfigs: new Map() })
    expect(resolveCommandPresetId(store, 'ws-1', 'worker-1')).toBeNull()
  })

  test('returns null for custom commands that do not match any built-in preset', () => {
    // The user typed `bash -c "..."` as a startup command. We must NOT
    // confidently claim it's `claude` just because that's the default
    // settings.getCommandPreset wired into the AddWorkerDialog.
    const store = makeStore({
      launchConfigs: new Map([['worker-1', { command: 'bash', args: ['-c', 'echo'] }]]),
      knownPresets: new Set(['claude', 'gemini']),
    })
    expect(resolveCommandPresetId(store, 'ws-1', 'worker-1')).toBeNull()
  })

  test('returns null when presetAugmentationDisabled is set, even with explicit commandPresetId', () => {
    // `presetAugmentationDisabled` means the launcher will NOT apply preset
    // behavior (resume args, yolo, session capture). The brand logo would
    // visually claim "this is Claude" while the actual runtime ignores Claude
    // preset semantics — that's a lie. Must stay in lockstep with
    // `agent-run-bootstrap.ts::resolveLaunchPreset:40`.
    const store = makeStore({
      launchConfigs: new Map([
        [
          'worker-1',
          {
            command: 'claude',
            args: ['--custom'],
            commandPresetId: 'claude',
            presetAugmentationDisabled: true,
          },
        ],
      ]),
    })
    expect(resolveCommandPresetId(store, 'ws-1', 'worker-1')).toBeNull()
  })
})

describe('enrichTeamList', () => {
  test('attaches commandPresetId to each worker without mutating the source array', () => {
    // Mutation-safety is load-bearing: workspace-store.listWorkers returns
    // records that live in the in-memory cache. Writing back via enrichment
    // would mean the cache silently grows transient fields like lastPtyLine.
    const sourceWorker = worker({ id: 'w-1' })
    const sourceArray = [sourceWorker]
    const store = makeStore({
      launchConfigs: new Map([['w-1', { command: 'gemini', args: [], commandPresetId: 'gemini' }]]),
    })
    const result = enrichTeamList('ws-1', store, sourceArray)
    expect(result[0]?.commandPresetId).toBe('gemini')
    // Original record is untouched — proves we copied, not mutated.
    expect(sourceWorker.commandPresetId).toBeUndefined()
  })

  test('keeps commandPresetId absent when resolve returns null (does not write `undefined` into the field)', () => {
    // exactOptionalPropertyTypes is strict: writing `commandPresetId:
    // undefined` is a different shape from omitting the key. The serializer
    // and consumers downstream rely on the absent-key form.
    const store = makeStore({ launchConfigs: new Map() })
    const [result] = enrichTeamList('ws-1', store, [worker({ id: 'w-1' })])
    expect(result).toBeDefined()
    if (!result) throw new Error('expected an enriched record')
    expect('commandPresetId' in result).toBe(false)
  })

  test('layers lastPtyLine and commandPresetId together on the same record', () => {
    // Both transient signals must coexist; an earlier draft folded them in
    // sequence and accidentally clobbered lastPtyLine on the second pass.
    const store = makeStore({
      launchConfigs: new Map([
        ['w-1', { command: 'opencode', args: [], commandPresetId: 'opencode' }],
      ]),
      lastPtyLines: new Map([['w-1', 'Editing src/index.ts (line 12)']]),
    })
    const [result] = enrichTeamList('ws-1', store, [worker({ id: 'w-1' })])
    expect(result?.lastPtyLine).toBe('Editing src/index.ts (line 12)')
    expect(result?.commandPresetId).toBe('opencode')
  })
})
