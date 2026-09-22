import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

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
      name: 'xterm-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/xterm-LICENSE.txt',
          source: readFileSync(
            resolve(dirname(require.resolve('@xterm/xterm/package.json')), 'LICENSE')
          ),
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
