import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const runtimePort = Number.parseInt(process.env.HIVE_RUNTIME_PORT ?? '4010', 10)
const webPort = Number.parseInt(process.env.HIVE_WEB_PORT ?? '5180', 10)

export default defineConfig({
  plugins: [tailwindcss()],
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
})
