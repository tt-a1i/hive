/* Playful Docker-style names: `<adjective>-<creature>-<dd>`. The pools
   below are intentionally chunky (56 × 60 × 90 ≈ 300k combinations) so the
   "Random" button reliably surprises across a long session.

   Constraints:
   - Lowercase ASCII only, hyphenated. The generated name has to be safe
     in shell args and `team send <name>` invocations.
   - Both lists are sorted alphabetically — keeps the snapshot tests
     stable and predictable; adding a new word only shifts indices for
     words after it.
*/

const ADJECTIVES = [
  'bouncy',
  'breezy',
  'chipper',
  'chunky',
  'cosmic',
  'cozy',
  'crispy',
  'dapper',
  'dazzling',
  'dreamy',
  'electric',
  'fizzy',
  'fluffy',
  'frisky',
  'fuzzy',
  'gleeful',
  'glitchy',
  'glowing',
  'groovy',
  'happy',
  'hearty',
  'jazzy',
  'jolly',
  'jumpy',
  'lively',
  'lucky',
  'magical',
  'mellow',
  'merry',
  'mighty',
  'misty',
  'nifty',
  'nimble',
  'peppy',
  'perky',
  'plucky',
  'quirky',
  'rascal',
  'sassy',
  'scrappy',
  'silky',
  'silly',
  'sleepy',
  'snazzy',
  'sneaky',
  'spiffy',
  'stealthy',
  'sunny',
  'swift',
  'twinkly',
  'wacky',
  'whimsical',
  'wiggly',
  'witty',
  'zany',
  'zesty',
  'zippy',
  'zoomy',
] as const

const NOUNS = [
  'alpaca',
  'axolotl',
  'badger',
  'beaver',
  'capybara',
  'chimera',
  'dolphin',
  'dragon',
  'fennec',
  'ferret',
  'fox',
  'gecko',
  'gnome',
  'goblin',
  'griffin',
  'hedgehog',
  'hippo',
  'kitsune',
  'koala',
  'kraken',
  'lemur',
  'llama',
  'manatee',
  'marmot',
  'meerkat',
  'mongoose',
  'narwhal',
  'ocelot',
  'octopus',
  'otter',
  'owl',
  'panda',
  'pangolin',
  'pegasus',
  'phoenix',
  'pika',
  'pirate',
  'pixie',
  'platypus',
  'possum',
  'puffin',
  'quokka',
  'raccoon',
  'raven',
  'salamander',
  'samurai',
  'seahorse',
  'selkie',
  'sloth',
  'sphinx',
  'sprite',
  'squirrel',
  'tanuki',
  'tapir',
  'troll',
  'unicorn',
  'walrus',
  'weasel',
  'wizard',
  'wombat',
  'wyvern',
  'yeti',
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
