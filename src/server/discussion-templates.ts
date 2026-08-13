export interface DiscussionTemplate {
  id: string
  name: string
  description: string
  defaultRounds: number
  roles: string[]
  topicPromptHint: string
}

export const discussionTemplates: DiscussionTemplate[] = [
  {
    id: 'design-review',
    name: 'Design Review',
    description: 'Architecture and solution selection — challenge assumptions, find blind spots.',
    defaultRounds: 3,
    roles: ['Advocate', 'Critic', 'Integrator'],
    topicPromptHint: 'Describe the design decision or architecture choice to evaluate.',
  },
  {
    id: 'root-cause-debate',
    name: 'Root Cause Debate',
    description: 'Incident or bug hypothesis elimination — competing explanations, evidence check.',
    defaultRounds: 2,
    roles: ['Hypothesis-A', 'Hypothesis-B', 'Evidence-Checker'],
    topicPromptHint: 'Describe the incident/bug symptoms and known context.',
  },
  {
    id: 'risk-review',
    name: 'Risk Review',
    description: 'Pre-launch risk assessment — surface risks, propose mitigations.',
    defaultRounds: 2,
    roles: ['Optimist', 'Pessimist', 'Mitigator'],
    topicPromptHint: 'Describe what is about to ship and known risk areas.',
  },
  {
    id: 'compare-approaches',
    name: 'Compare Approaches',
    description: 'Technical approach comparison — each member champions one option.',
    defaultRounds: 3,
    roles: ['Approach-A', 'Approach-B', 'Approach-C'],
    topicPromptHint: 'List the approaches to compare and the evaluation criteria.',
  },
]

export const getDiscussionTemplate = (id: string): DiscussionTemplate | undefined =>
  discussionTemplates.find((t) => t.id === id)

export type DiscussionTriggerCondition =
  | 'task_has_multiple_approaches'
  | 'task_is_high_risk'
  | 'task_needs_review'
  | 'manual'

export interface DiscussionTriggerRule {
  condition: DiscussionTriggerCondition
  template_id?: string
  min_workers?: number
  description: string
}

export interface DiscussionTriggers {
  rules: DiscussionTriggerRule[]
}

const CONDITION_KEYWORDS: Record<DiscussionTriggerCondition, string[]> = {
  task_has_multiple_approaches: ['approach', 'option', 'alternative', 'choose', 'compare', 'tradeoff', 'versus', 'vs'],
  task_is_high_risk: ['risk', 'dangerous', 'breaking', 'migration', 'irreversible', 'production', 'deploy', 'critical'],
  task_needs_review: ['review', 'audit', 'check', 'validate', 'approve', 'security', 'compliance'],
  manual: [],
}

export const evaluateTrigger = (
  taskDescription: string,
  triggers: DiscussionTriggerRule[],
  availableWorkers?: number
): DiscussionTriggerRule[] => {
  const lower = taskDescription.toLowerCase()
  return triggers.filter((rule) => {
    if (rule.condition === 'manual') return false
    if (rule.min_workers && availableWorkers !== undefined && availableWorkers < rule.min_workers) return false
    const keywords = CONDITION_KEYWORDS[rule.condition]
    return keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(lower))
  })
}
