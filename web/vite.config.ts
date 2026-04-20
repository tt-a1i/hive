import { defineConfig } from 'vite'

const runtimePort = Number.parseInt(process.env.HIVE_RUNTIME_PORT ?? '4010', 10)

export default defineConfig({
  root: 'web',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${runtimePort}`,
      '/ws': {
        target: `ws://127.0.0.1:${runtimePort}`,
        ws: true,
      },
    },
  },
})
