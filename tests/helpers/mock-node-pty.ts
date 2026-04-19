import { afterEach, vi } from 'vitest'

interface MockSpawnOptions {
  env?: NodeJS.ProcessEnv
}

const emitScriptBoot = (
  scriptPath: string,
  env: NodeJS.ProcessEnv | undefined,
  emitData: (chunk: string) => void,
  emitExit: (exitCode: number) => void
) => {
  if (scriptPath.endsWith('print-env.js')) {
    emitData(`${env?.HIVE_PROJECT_ID}\r\n${env?.HIVE_AGENT_ID}\r\n`)
    emitExit(0)
    return
  }

  if (scriptPath.endsWith('print-runtime-env.js')) {
    emitData(`PORT=${env?.HIVE_PORT}\r\n`)
    emitData(`PROJECT=${env?.HIVE_PROJECT_ID}\r\n`)
    emitData(`AGENT=${env?.HIVE_AGENT_ID}\r\n`)
    emitData(`PATH=${env?.PATH}\r\n`)
    emitExit(0)
    return
  }

  if (scriptPath.endsWith('long-running.js')) {
    emitData('started\r\n')
    return
  }

  if (scriptPath.endsWith('huge-output.js')) {
    emitData(`${'a'.repeat(500_000)}${'b'.repeat(500_000)}${'z'.repeat(500_000)}`)
    emitExit(0)
    return
  }

  if (scriptPath.endsWith('exit-immediately.js')) {
    emitExit(0)
  }
}

const emitScriptWrite = (
  scriptPath: string,
  text: string,
  emitData: (chunk: string) => void,
  emitExit: (exitCode: number) => void
) => {
  if (scriptPath.endsWith('echo-stdin.js')) {
    emitData(`IN:${text}`)
    emitExit(0)
    return
  }

  if (scriptPath.endsWith('worker-echo.js')) {
    emitData(`PROMPT:${text}`)
    return
  }

  if (scriptPath.endsWith('orch-echo.js')) {
    emitData(`ORCH:${text}`)
    return
  }

  if (scriptPath.endsWith('dummy-worker.js')) {
    emitData(`WORKER:${text}`)
    return
  }

  if (scriptPath.endsWith('dummy-orch.js')) {
    emitData(`ORCH:${text}`)
  }
}

vi.mock('node-pty', () => ({
  spawn: (_command: string, args: string[] = [], options: MockSpawnOptions = {}) => {
    const scriptPath = args[0] ?? ''
    const pid = 4242
    let dataHandler: ((chunk: string) => void) | undefined
    let exitHandler: ((event: { exitCode: number }) => void) | undefined
    let stopped = false

    const emitExit = (exitCode: number) => {
      if (stopped) {
        return
      }
      stopped = true
      exitHandler?.({ exitCode })
    }

    const emitData = (chunk: string) => {
      if (stopped) {
        return
      }
      dataHandler?.(chunk)
    }

    setTimeout(() => {
      emitScriptBoot(scriptPath, options.env, emitData, emitExit)
    }, 0)

    return {
      pid,
      kill() {
        emitExit(0)
      },
      onData(handler: (chunk: string) => void) {
        dataHandler = handler
      },
      onExit(handler: (event: { exitCode: number }) => void) {
        exitHandler = handler
      },
      write(text: string) {
        emitScriptWrite(scriptPath, text, emitData, emitExit)
      },
    }
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})
