import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { FEATURE_FLAGS_ALL_OFF, type FeatureFlags } from './feature-flags.js'
import { escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import { getHiveTeamRules } from './hive-team-guidance.js'

// Header metadata must stay on one line; descriptions remain multiline below it.
const escapeStartupField = (value: string) =>
  escapeHiveEnvelopeText(value).replaceAll('\r', '&#13;').replaceAll('\n', '&#10;')

export const buildAgentSessionBindingMarker = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) => `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}`

export const buildAgentLegacyIdentityMarker = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) =>
  `You are ${escapeStartupField(agent.name)} (${agent.role}) in workspace ${escapeStartupField(workspace.name)}.`

export const buildAgentStartupInstructions = ({
  agent,
  memoryDigest,
  workspace,
  flags = FEATURE_FLAGS_ALL_OFF,
}: {
  agent: AgentSummary
  memoryDigest?: string | null | undefined
  workspace: WorkspaceSummary
  /** Live flags gate optional workflow reference. They do not grant staffing authorization. */
  flags?: FeatureFlags
}) => {
  const lines = [
    '<hive-message kind="startup">',
    '',
    buildAgentLegacyIdentityMarker({ agent, workspace }),
    `Current workspace: ${escapeStartupField(workspace.name)}`,
    `Project path: ${escapeStartupField(workspace.path)}`,
    buildAgentSessionBindingMarker({ agent, workspace }),
    '',
    // agent.description follows the user's chosen language / custom edit, but
    // still travels inside a Hive envelope, so XML-like delimiters are escaped.
    `Your role: ${escapeHiveEnvelopeText(agent.description)}`,
    '',
  ]

  if (memoryDigest) {
    lines.push(memoryDigest, '')
  }

  lines.push('Hive boundaries:', ...getHiveTeamRules(agent, flags).map((rule) => `- ${rule}`))
  if (agent.role !== 'orchestrator') {
    lines.push(
      '',
      '- If no dispatch has been assigned in this conversation, end this turn quietly and wait for a later task message. Do not search for work, call tools to announce readiness, poll, sleep, or exit the CLI. A later dispatch starts your responsibility.',
      '- Command reference: `team guide member`. For long or shell-sensitive bodies use `--stdin` with safely quoted shell input.'
    )
  }
  lines.push(
    '',
    'For an assigned task with missing context, read `team guide core` or `.hive/PROTOCOL.md`; query messages using its dispatch ID. Native CLI compaction is not assumed detectable by Hive.'
  )

  lines.push('', '</hive-message>', '')
  return lines.join('\n')
}

export const buildWorkflowAgentStartupInstructions = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) =>
  [
    '<hive-message kind="startup">',
    '',
    buildAgentLegacyIdentityMarker({ agent, workspace }),
    `Current workspace: ${escapeStartupField(workspace.name)}`,
    `Project path: ${escapeStartupField(workspace.path)}`,
    buildAgentSessionBindingMarker({ agent, workspace }),
    '',
    `Your role: ${escapeHiveEnvelopeText(agent.description)}`,
    '',
    'You are a one-shot Hive workflow member. Finish only the dispatch that follows this startup message.',
    ...getHiveTeamRules(agent).map((rule) => `- ${rule}`),
    '',
    '</hive-message>',
    '',
  ].join('\n')
