import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { HttpError } from './http-errors.js'
import { realpathNative } from './path-canonicalization.js'

const MAX_ARTIFACT_BYTES = 128 * 1024

const isWithin = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const sameFile = (before: Stats, after: Stats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs

const requireTextFile = (stats: Stats) => {
  if (!stats.isFile()) throw new HttpError(415, 'Artifact is not a regular text file')
  if (stats.size > MAX_ARTIFACT_BYTES) throw new HttpError(413, 'Artifact exceeds 128 KiB')
}

const validatePath = (path: string) => {
  const withoutDrive = process.platform === 'win32' ? path.replace(/^[a-z]:[\\/]/i, '') : path
  if (
    !path.trim() ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32 || character === '\x7f') ||
    withoutDrive.includes(':') ||
    /^[\\/]{2}/.test(path) ||
    (process.platform === 'win32' &&
      path
        .split(/[\\/]/)
        .some((part) =>
          /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
            part.trimEnd()
          )
        ))
  ) {
    throw new HttpError(400, 'Artifact path is not supported')
  }
}

const mapFilesystemError = (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'Artifact not found')
  if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'Artifact access denied')
  if (code === 'ELOOP' || code === 'ETXTBSY') throw new HttpError(409, 'Artifact changed; retry')
  if (code === 'EISDIR' || code === 'ENXIO') throw new HttpError(415, 'Artifact is not a text file')
  if (code === 'ENAMETOOLONG' || code === 'EINVAL') {
    throw new HttpError(400, 'Artifact path is not supported')
  }
  throw error
}

/** Reads the current file, not an immutable snapshot of the reported artifact. */
export const readDispatchArtifact = async (workspacePath: string, artifactPath: string) => {
  validatePath(artifactPath)
  try {
    // Require successful canonicalization: missing-path lexical fallbacks are unsafe here.
    const root = realpathNative(workspacePath)
    const path = resolve(root, artifactPath)
    const canonicalPath = realpathNative(path)
    if (!isWithin(root, canonicalPath))
      throw new HttpError(403, 'Artifact is outside the workspace')
    const before = await lstat(path)
    requireTextFile(before)
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const handle = await open(path, flags)
    try {
      const requireUnchanged = async () => {
        try {
          if (
            realpathNative(workspacePath) !== root ||
            realpathNative(path) !== canonicalPath ||
            !sameFile(before, await lstat(path)) ||
            !sameFile(before, await handle.stat())
          ) {
            throw new HttpError(409, 'Artifact changed; retry')
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
            throw new HttpError(409, 'Artifact changed; retry')
          }
          throw error
        }
      }
      requireTextFile(await handle.stat())
      await requireUnchanged()
      const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
        if (bytesRead === 0) break
        size += bytesRead
      }
      if (size > MAX_ARTIFACT_BYTES) throw new HttpError(413, 'Artifact exceeds 128 KiB')
      await requireUnchanged()
      if (size !== before.size) throw new HttpError(409, 'Artifact changed; retry')
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
      } catch (error) {
        if (error instanceof TypeError) throw new HttpError(415, 'Artifact is not UTF-8 text')
        throw error
      }
      if (
        bytes
          .subarray(0, size)
          .some((byte) => byte === 127 || (byte < 32 && ![9, 10, 13].includes(byte)))
      ) {
        throw new HttpError(415, 'Artifact contains binary data')
      }
      return { content, size_bytes: size, modified_at: before.mtime.toISOString() }
    } finally {
      await handle.close()
    }
  } catch (error) {
    mapFilesystemError(error)
  }
}
