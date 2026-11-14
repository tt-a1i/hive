import { spawn } from 'node:child_process'

const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/cli/hive.ts', ...process.argv.slice(2)],
  {
    env: { ...process.env, HIVE_WEB_PORT: process.env.HIVE_WEB_PORT ?? '5180' },
    stdio: 'inherit',
  }
)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
