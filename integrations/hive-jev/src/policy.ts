interface ApprovalInput {
  securityDecision: string
  requiresUserConfirmation: boolean
  riskLevel: number
  requested?: boolean
  tool?: string
  allowedTools?: string[]
}

export function automaticApproval({
  securityDecision,
  requiresUserConfirmation,
  riskLevel,
  requested = false,
  tool,
  allowedTools = [],
}: ApprovalInput) {
  const approved =
    requested &&
    typeof tool === 'string' &&
    allowedTools.includes(tool) &&
    securityDecision === 'clear' &&
    requiresUserConfirmation === false &&
    Number.isFinite(riskLevel) &&
    riskLevel >= 0 &&
    riskLevel <= 1
  return {
    auto_approved: approved,
    reason: approved
      ? 'explicitly_scoped_clear_low_risk'
      : 'not_explicitly_scoped_or_review_required',
  }
}
