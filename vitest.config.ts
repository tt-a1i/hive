import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['tests/**/*.test.{js,ts,tsx}'],
    setupFiles: ['./tests/setup/vitest.setup.ts'],
  },
})
