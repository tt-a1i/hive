type CaptureWaiter = {
  knownSessionIds: Set<string>
  onCapture: (sessionId: string) => void
  resolve: () => void
}

const claimedByProjectKey = new Map<string, Set<string>>()
const pollersByProjectKey = new Map<string, ReturnType<typeof setInterval>>()
const waitersByProjectKey = new Map<string, CaptureWaiter[]>()

const clearPollerIfIdle = (projectKey: string) => {
  if ((waitersByProjectKey.get(projectKey)?.length ?? 0) > 0) return
  const poller = pollersByProjectKey.get(projectKey)
  if (poller) clearInterval(poller)
  pollersByProjectKey.delete(projectKey)
  claimedByProjectKey.delete(projectKey)
}

const flushWaiters = (projectKey: string, listSessionIds: () => string[]) => {
  const waiters = waitersByProjectKey.get(projectKey)
  if (!waiters?.length) return clearPollerIfIdle(projectKey)
  const claimedSessionIds = claimedByProjectKey.get(projectKey) ?? new Set<string>()
  claimedByProjectKey.set(projectKey, claimedSessionIds)
  const availableSessionIds = listSessionIds().filter(
    (sessionId) => !claimedSessionIds.has(sessionId)
  )
  const remainingWaiters: CaptureWaiter[] = []

  for (const waiter of waiters) {
    const nextSessionId = availableSessionIds.find(
      (sessionId) => !waiter.knownSessionIds.has(sessionId)
    )
    if (!nextSessionId) {
      remainingWaiters.push(waiter)
      continue
    }
    claimedSessionIds.add(nextSessionId)
    availableSessionIds.splice(availableSessionIds.indexOf(nextSessionId), 1)
    waiter.onCapture(nextSessionId)
    waiter.resolve()
  }

  waitersByProjectKey.set(projectKey, remainingWaiters)
  clearPollerIfIdle(projectKey)
}

export const captureSessionIdWithCoordinator = async ({
  intervalMs = 100,
  knownSessionIds,
  listSessionIds,
  onCapture,
  projectKey,
  timeoutMs = 5000,
}: {
  intervalMs?: number
  knownSessionIds: Set<string>
  listSessionIds: () => string[]
  onCapture: (sessionId: string) => void
  projectKey: string
  timeoutMs?: number
}) => {
  await new Promise<void>((resolve) => {
    let waiter: CaptureWaiter | undefined
    const timeout = setTimeout(() => {
      waitersByProjectKey.set(
        projectKey,
        (waitersByProjectKey.get(projectKey) ?? []).filter((candidate) => candidate !== waiter)
      )
      clearPollerIfIdle(projectKey)
      resolve()
    }, timeoutMs)
    timeout.unref?.()
    waiter = {
      knownSessionIds,
      onCapture,
      resolve: () => {
        clearTimeout(timeout)
        resolve()
      },
    }
    waitersByProjectKey.set(projectKey, [...(waitersByProjectKey.get(projectKey) ?? []), waiter])
    if (!pollersByProjectKey.has(projectKey)) {
      pollersByProjectKey.set(
        projectKey,
        setInterval(() => flushWaiters(projectKey, listSessionIds), intervalMs)
      )
      pollersByProjectKey.get(projectKey)?.unref?.()
    }
    flushWaiters(projectKey, listSessionIds)
  })
}

export const resetSessionCaptureCoordinatorForTests = () => {
  for (const poller of pollersByProjectKey.values()) clearInterval(poller)
  pollersByProjectKey.clear()
  waitersByProjectKey.clear()
  claimedByProjectKey.clear()
}
