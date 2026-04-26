import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const canExecute = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
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

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  if (hasPathSeparator(command)) {
    const candidate = isAbsolute(command) ? command : join(cwd, command)
    if (canExecute(candidate)) return
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (env.PATH ?? '').split(delimiter)) {
    if (!pathEntry) continue
    if (canExecute(join(pathEntry, command))) return
  }

  throw createCommandNotFoundError(command)
}
