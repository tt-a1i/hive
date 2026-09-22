import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  createRuntimeStoreLifecycle,
  createRuntimeStoreServices,
} from '../../src/server/runtime-store-helpers.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

test('shell shutdown failure stays observable after other resources close', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-close-error-'))
  const services = createRuntimeStoreServices({ dataDir })
  const lifecycle = createRuntimeStoreLifecycle({ services })
  const closeShell = services.shellRuntime.close
  const shellFailure = new Error('injected shell shutdown failure')
  services.shellRuntime.close = async () => {
    throw shellFailure
  }
  try {
    expect(services.db.isOpen).toBe(true)
    await expect(lifecycle.close()).rejects.toBe(shellFailure)
    expect(services.db.isOpen).toBe(false)
    expect(services.isRuntimeClosing()).toBe(true)
  } finally {
    services.shellRuntime.close = closeShell
    if (services.db.isOpen) await lifecycle.close()
    removeTestPath(dataDir)
  }
})

test('preserves both shutdown failures without closing SQLite ahead of its users', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-close-errors-'))
  const services = createRuntimeStoreServices({ dataDir })
  const lifecycle = createRuntimeStoreLifecycle({ services })
  const closeShell = services.shellRuntime.close
  const closeExport = services.teamMemoryExport.close
  const shellFailure = new Error('injected shell failure')
  const exportFailure = new Error('injected export failure')
  services.shellRuntime.close = async () => {
    throw shellFailure
  }
  services.teamMemoryExport.close = async () => {
    throw exportFailure
  }
  try {
    const failure = await lifecycle.close().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([shellFailure, exportFailure])
    expect(services.db.isOpen).toBe(true)
  } finally {
    services.shellRuntime.close = closeShell
    services.teamMemoryExport.close = closeExport
    await lifecycle.close()
    removeTestPath(dataDir)
  }
})
