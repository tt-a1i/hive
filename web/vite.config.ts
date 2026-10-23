import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Rollup } from 'vite'

import { buildXterm } from '../scripts/build-xterm.mjs'
import { DEFAULT_HIVE_PORT } from '../src/cli/hive-defaults.js'
import { buildSw } from './src/pwa/build-sw.js'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as {
  version: string
}

const runtimePort = Number.parseInt(process.env.HIVE_RUNTIME_PORT ?? String(DEFAULT_HIVE_PORT), 10)
const webPort = Number.parseInt(process.env.HIVE_WEB_PORT ?? '5180', 10)

export default defineConfig(async () => ({
  resolve: {
    alias: [{ find: /^@xterm\/xterm$/, replacement: await buildXterm() }],
  },
  plugins: [
    tailwindcss(),
    buildSw({ version: packageJson.version }),
    {
      name: 'bundled-licenses',
      generateBundle(_options: Rollup.NormalizedOutputOptions, bundle: Rollup.OutputBundle) {
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/xterm-LICENSE.txt',
          source: readFileSync(
            resolve(dirname(require.resolve('@xterm/xterm/package.json')), 'LICENSE')
          ),
        })
        // Browser dependencies are bundled, not installed by end users. Ship
        // their notices with the bundle, including transitive dependencies.
        // Tailwind emits CSS rather than a JavaScript chunk.
        const packageRoots = new Set([dirname(require.resolve('tailwindcss/package.json'))])
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue
          for (const id of Object.keys(output.modules)) {
            const normalized = id.replaceAll('\\', '/')
            if (normalized.startsWith('\0')) continue
            const boundary = normalized.lastIndexOf('/node_modules/')
            if (boundary < 0) continue
            const parts = normalized.slice(boundary + 14).split('/')
            // The patched xterm bundle carries the separate license above.
            if (parts[0] === '.cache' && parts[1] === 'hive-xterm') continue
            const name = parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/')
            packageRoots.add(normalized.slice(0, boundary + 14) + name)
          }
        }
        const notices: string[] = []
        for (const root of [...packageRoots].sort()) {
          const info = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
          const files = readdirSync(root, { withFileTypes: true })
            .filter(
              (file) => file.isFile() && /^(licen[sc]e|copying|notice)([.-]|$)/i.test(file.name)
            )
            .map((file) => file.name)
            .sort()
          // Older Radix subpackages omit LICENSE; they share the monorepo's
          // MIT notice shipped by our direct react-dialog dependency.
          if (
            files.length === 0 &&
            info.name.startsWith('@radix-ui/') &&
            info.license === 'MIT' &&
            info.repository?.url === 'git+https://github.com/radix-ui/primitives.git'
          ) {
            const radixRoot = resolve(dirname(require.resolve('@radix-ui/react-dialog')), '..')
            notices.push(
              `${info.name}@${info.version} — LICENSE\n${readFileSync(resolve(radixRoot, 'LICENSE'), 'utf8')}`
            )
            continue
          }
          // 2.3.8 also omits its notice; retain the upstream copy (see NOTICE).
          if (
            files.length === 0 &&
            info.name === 'react-remove-scroll-bar' &&
            info.version === '2.3.8'
          ) {
            notices.push(
              `${info.name}@${info.version} — LICENSE\n${readFileSync(resolve(here, '../assets/licenses/react-remove-scroll-bar-LICENSE.txt'), 'utf8')}`
            )
            continue
          }
          if (files.length === 0) throw new Error(`Missing bundled license: ${info.name}`)
          for (const file of files) {
            notices.push(
              `${info.name}@${info.version} — ${file}\n${readFileSync(resolve(root, file), 'utf8')}`
            )
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/third-party.txt',
          source: notices.join(`\n\n${'='.repeat(72)}\n\n`),
        })
      },
    },
  ],
  root: 'web',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${runtimePort}`,
      '/ws': {
        target: `ws://127.0.0.1:${runtimePort}`,
        ws: true,
      },
    },
  },
}))
