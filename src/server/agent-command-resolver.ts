import { accessSync, constants } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const canExecute = (path: string, platform = process.platform): boolean => {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const createCommandNotFoundError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${command} CLI not found in PATH`), {
    code: 'ENOENT',
    path: command,
  })

const getWindowsExecutableNames = (command: string, env: NodeJS.ProcessEnv): string[] => {
  if (extname(command)) return [command]

  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...extensions.map((extension) => `${command}${extension}`), command]
}

const getExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] => (platform === 'win32' ? getWindowsExecutableNames(command, env) : [command])

export const resolveCommandPath = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): string => {
  if (hasPathSeparator(command)) {
    for (const name of getExecutableNames(command, env)) {
      const candidate = isAbsolute(name) ? name : join(cwd, name)
      if (canExecute(candidate)) return candidate
    }
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (env.PATH ?? '').split(delimiter)) {
    if (!pathEntry) continue
    for (const name of getExecutableNames(command, env)) {
      const candidate = join(pathEntry, name)
      if (canExecute(candidate)) return candidate
    }
  }

  throw createCommandNotFoundError(command)
}

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  resolveCommandPath(command, cwd, env)
}
