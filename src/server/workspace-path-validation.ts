import { realpathSync, type Stats, statSync } from 'node:fs'

import { BadRequestError } from './http-errors.js'

export const validateWorkspacePath = (path: unknown): string => {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new BadRequestError('Workspace path is required')
  }

  const candidate = path.trim()
  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    throw new BadRequestError(`Workspace path does not exist: ${candidate}`)
  }

  let stat: Stats
  try {
    stat = statSync(resolved)
  } catch {
    throw new BadRequestError(`Workspace path does not exist: ${candidate}`)
  }

  if (!stat.isDirectory()) {
    throw new BadRequestError(`Workspace path is not a directory: ${candidate}`)
  }

  return resolved
}
