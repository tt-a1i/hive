import type { UiLanguage } from '../uiLanguage.js'

/* Playful Docker-style names: `<adjective>-<noun>-<dd>`. The pools
   below are intentionally chunky (56 × 60 × 90 ≈ 300k combinations) so the
   "Random" button reliably surprises across a long session.

   Constraints:
   - No spaces, hyphenated. The generated name has to be safe in quoted shell
     args and `team send <name>` invocations.
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

const ZH_PREFIXES = [
  '半夜',
  '爆米花',
  '补丁',
  '茶水间',
  '超频',
  '代码',
  '电光',
  '饭点',
  '风火轮',
  '海盐',
  '火锅',
  '键盘',
  '咖啡',
  '蓝屏',
  '凌晨',
  '奶茶',
  '霓虹',
  '泡面',
  '像素',
  '星舰',
  '雪糕',
  '盐焗',
  '银河',
  '云端',
  '招财',
  '周五',
] as const

const ZH_PERSONAS = [
  '补丁侠',
  '拆弹员',
  '调度官',
  '读码人',
  '工匠',
  '观星师',
  '剪线师',
  '炼金师',
  '领航员',
  '魔法师',
  '判官',
  '排障师',
  '守门员',
  '探针',
  '听诊器',
  '驯龙师',
  '验收官',
  '侦探',
  '指挥家',
  '铸剑师',
] as const

const nextRandomUint32 = (): number => {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] ?? 0
}

const pick = <T>(items: readonly T[], nextUint32: () => number): T =>
  items[nextUint32() % items.length] as T

export const generateWorkerName = (
  language: UiLanguage = 'en',
  nextUint32: () => number = nextRandomUint32
): string => {
  if (language === 'zh') {
    const prefix = pick(ZH_PREFIXES, nextUint32)
    const persona = pick(ZH_PERSONAS, nextUint32)
    const suffix = 10 + (nextUint32() % 90)
    return `${prefix}-${persona}-${suffix}`
  }

  const adjective = pick(ADJECTIVES, nextUint32)
  const noun = pick(NOUNS, nextUint32)
  const suffix = 10 + (nextUint32() % 90)
  return `${adjective}-${noun}-${suffix}`
}
