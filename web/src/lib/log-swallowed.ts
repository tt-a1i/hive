/**
 * AGENTS.md §一 forbids silent error swallowing. For promise chains where the
 * caller genuinely doesn't have a recovery path (best-effort fire-and-forget
 * like persistence queues, clipboard writes, log saves) but failure still
 * matters for diagnosis, route the rejection through this helper instead of
 * `.catch(() => {})`. Errors land in the dev console with a tag.
 */
export const logSwallowed =
  (context: string) =>
  (error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error(`[hive] swallowed:${context}`, error)
  }
