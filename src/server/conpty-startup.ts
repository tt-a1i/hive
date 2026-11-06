// The dependency's bundled ConPTY requests DA1 before starting the application.
// Answer for Hive's xterm frontend even when no browser is attached, and consume
// that query so a viewer cannot send a second reply into the application.
// Only recognize the pinned backend's startup prefix, never later app queries.
const STARTUP_PREFIXES = ['\x1b[c', '\x1b[1t\x1b[c']
const XTERM_PRIMARY_DEVICE_ATTRIBUTES = '\x1b[?1;2c'

export const createConptyStartupFilter = (reply: (data: string) => void) => {
  let pending = ''
  let complete = false

  return (chunk: string): string => {
    if (complete) return chunk
    pending += chunk
    const prefix = STARTUP_PREFIXES.find((candidate) => pending.startsWith(candidate))
    if (prefix) {
      complete = true
      const output = prefix.slice(0, -3) + pending.slice(prefix.length)
      pending = ''
      reply(XTERM_PRIMARY_DEVICE_ATTRIBUTES)
      return output
    }
    if (STARTUP_PREFIXES.some((candidate) => candidate.startsWith(pending))) return ''
    complete = true
    const output = pending
    pending = ''
    return output
  }
}
