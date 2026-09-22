import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WINDOWS_RETRYABLE_FS_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])

const sleepSync = (delayMs) => {
  if (delayMs <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

const getErrorCode = (error) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined

export const withWindowsFsRetry = (
  label,
  operation,
  { maxRetries = 20, platform = process.platform, retryDelayMs = 100, sleep = sleepSync } = {}
) => {
  let attempt = 0
  while (true) {
    try {
      return operation()
    } catch (error) {
      const code = getErrorCode(error)
      const canRetry =
        platform === 'win32' &&
        WINDOWS_RETRYABLE_FS_ERRORS.has(String(code)) &&
        attempt < maxRetries
      if (!canRetry) throw error
      attempt += 1
      console.warn(
        `[hive] ${label} hit transient Windows filesystem error ${String(code)}; retrying ${attempt}/${maxRetries}`
      )
      sleep(retryDelayMs)
    }
  }
}

const removePath = (path) => {
  withWindowsFsRetry(`remove ${path}`, () => {
    rmSync(path, {
      force: true,
      recursive: true,
    })
  })
}

const copyRequired = (root, source, target, mode) => {
  const sourcePath = join(root, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required build artifact source: ${source}`)
  }
  const targetPath = join(root, target)
  withWindowsFsRetry(`create ${dirname(targetPath)}`, () =>
    mkdirSync(dirname(targetPath), { recursive: true })
  )
  withWindowsFsRetry(`copy ${source} -> ${target}`, () => copyFileSync(sourcePath, targetPath))
  if (mode) withWindowsFsRetry(`chmod ${target}`, () => chmodSync(targetPath, mode))
}

const copyDirRequired = (root, source, target) => {
  const sourcePath = join(root, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required build artifact source: ${source}`)
  }
  const targetPath = join(root, target)
  removePath(targetPath)
  withWindowsFsRetry(`copy ${source} -> ${target}`, () =>
    cpSync(sourcePath, targetPath, { recursive: true })
  )
}

export const prepareBuildArtifacts = ({ root = process.cwd() } = {}) => {
  const distBin = join(root, 'dist', 'bin')
  const distVendor = join(root, 'dist', 'vendor')

  withWindowsFsRetry(`create ${distBin}`, () => mkdirSync(distBin, { recursive: true }))
  copyRequired(root, 'bin/team', 'dist/bin/team', 0o755)
  copyRequired(root, 'bin/team.cmd', 'dist/bin/team.cmd')
  copyRequired(root, 'src/server/workflow-vm-worker.cjs', 'dist/src/server/workflow-vm-worker.cjs')
  // tsc also emits this via the JSON import, but copy explicitly so the npm
  // package contract does not depend on that side effect alone.
  copyRequired(root, 'src/shared/agent-names.json', 'dist/src/shared/agent-names.json')

  withWindowsFsRetry(`create ${distVendor}`, () => mkdirSync(distVendor, { recursive: true }))
  copyDirRequired(root, 'vendor/marketplace', 'dist/vendor/marketplace')
  copyDirRequired(root, 'vendor/node-pty-windows', 'dist/vendor/node-pty-windows')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareBuildArtifacts()
}
