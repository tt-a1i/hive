/**
 * Wraps a system-injected message body in an out-of-band XML envelope so the
 * agent attends to it as system content rather than mistaking it for user
 * input or its own output. `<hive-system-reminder>` is reserved for the short
 * re-anchoring action menu appended at a message tail; this `<hive-system-message>`
 * tag carries larger injected bodies.
 *
 * The content must already be escaped or intentionally contain trusted Hive
 * sub-envelopes.
 */
export const wrapRawSystemMessage = (content: string) =>
  `<hive-system-message>\n${content}\n</hive-system-message>`
