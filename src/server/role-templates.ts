import type { WorkerRole } from '../shared/types.js'

export const ORCHESTRATOR_ROLE_DESCRIPTION =
  '你是 Hive 的 Orchestrator。直接响应用户，拆解任务，按 worker 名称派单，并在收到汇报后推进下一步。'

export const CODER_ROLE_DESCRIPTION =
  '你是实现型 worker。专注编码与最小正确改动，完成后用 team report 汇报结果、风险与产物。'

export const REVIEWER_ROLE_DESCRIPTION =
  '你是审查型 worker。专注发现 bug、回归风险、边界条件和测试缺口，结论要具体可执行。'

export const TESTER_ROLE_DESCRIPTION =
  '你是测试型 worker。专注复现问题、补充验证、运行测试并确认行为与 spec 一致。'

export const CUSTOM_ROLE_DESCRIPTION =
  '你是自定义 worker。按派单要求完成任务，边界不清时先澄清，完成后必须用 team report 汇报。'

export const getDefaultRoleDescription = (role: WorkerRole | 'orchestrator') => {
  switch (role) {
    case 'orchestrator':
      return ORCHESTRATOR_ROLE_DESCRIPTION
    case 'coder':
      return CODER_ROLE_DESCRIPTION
    case 'reviewer':
      return REVIEWER_ROLE_DESCRIPTION
    case 'tester':
      return TESTER_ROLE_DESCRIPTION
    case 'custom':
      return CUSTOM_ROLE_DESCRIPTION
  }
}
