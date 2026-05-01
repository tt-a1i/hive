const ADJECTIVES = [
  'atlas',
  'ember',
  'lumen',
  'nova',
  'orbit',
  'pixel',
  'rivet',
  'sable',
  'tempo',
  'vector',
] as const

const NOUNS = [
  'beacon',
  'check',
  'coder',
  'forge',
  'relay',
  'runner',
  'signal',
  'spark',
  'thread',
  'watch',
] as const

const nextRandomUint32 = (): number => {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] ?? 0
}

const pick = <T>(items: readonly T[], nextUint32: () => number): T =>
  items[nextUint32() % items.length] as T

export const generateWorkerName = (nextUint32: () => number = nextRandomUint32): string => {
  const adjective = pick(ADJECTIVES, nextUint32)
  const noun = pick(NOUNS, nextUint32)
  const suffix = 10 + (nextUint32() % 90)
  return `${adjective}-${noun}-${suffix}`
}
