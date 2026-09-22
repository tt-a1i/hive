import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const expectedSources = {
  'src/browser/services/Services.ts':
    'b3024deaec8cc0839b8cf96a7a68528a6e5d0af9af61b570f643d20db6abce30',
  'src/browser/services/RenderService.ts':
    '5a08da7d6bc489f6fecc0352e75ad559476ccedf6c021d3bc2a9d7a64539c1e3',
  'src/browser/CoreBrowserTerminal.ts':
    'f1433e79d0e571e2f26b566bd643c6a9a8e7f06e3a0ea8e3e081f7e96cad68ef',
  'src/browser/input/CompositionHelper.ts':
    '7d8048c3de27ced889ef5b4bb2288c4deebc79130f0a6570ae73911abe9a459b',
}
const hash = (value) => createHash('sha256').update(value).digest('hex')

// pnpm patches sources, not xterm's precompiled lib. Rebuild for both Vite dev
// and production; npm consumers receive the resulting prebuilt web assets.
export async function buildXterm() {
  const source = dirname(require.resolve('@xterm/xterm/package.json'))
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (version !== '6.0.0')
    throw new Error(`Review xterm patch before upgrading from 6.0.0 to ${version}`)
  for (const [path, expected] of Object.entries(expectedSources)) {
    const content = readFileSync(join(source, path), 'utf8').replaceAll('\r\n', '\n')
    if (hash(content) !== expected) {
      throw new Error(
        `xterm source patch missing or changed: ${path}; install with frozen pnpm lockfile`
      )
    }
  }
  const result = await build({
    absWorkingDir: source,
    entryPoints: ['src/browser/public/Terminal.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    alias: {
      browser: join(source, 'src/browser'),
      common: join(source, 'src/common'),
      vs: join(source, 'src/vs'),
    },
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
    banner: { js: `/*!\n${readFileSync(join(source, 'LICENSE'), 'utf8')}\n*/` },
  })
  const contents = result.outputFiles[0].contents
  const cache = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../node_modules/.cache/hive-xterm'
  )
  mkdirSync(cache, { recursive: true })
  const output = join(cache, `${hash(contents)}.mjs`)
  writeFileSync(output, contents)
  return output
}
