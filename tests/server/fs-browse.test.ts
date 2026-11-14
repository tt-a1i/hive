import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { sameFilesystemPath } from '../../src/server/path-canonicalization.js'
import { WINDOWS_DRIVES_ROOT } from '../../src/shared/fs-browse.js'
import { startTestServer } from '../helpers/test-server.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let cookie = ''
let sandboxRoot = ''
let outsideRoot = ''
const tempDirs: string[] = []

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-root-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'hive-fs-outside-'))
  tempDirs.push(sandboxRoot, outsideRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  mkdirSync(join(sandboxRoot, 'projects'), { recursive: true })
  mkdirSync(join(sandboxRoot, 'projects', 'my-app', '.git'), { recursive: true })
  writeFileSync(join(sandboxRoot, 'projects', 'my-app', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(sandboxRoot, 'projects', 'worktree-app'), { recursive: true })
  mkdirSync(join(sandboxRoot, '.git-worktrees', 'worktree-app'), { recursive: true })
  writeFileSync(
    join(sandboxRoot, 'projects', 'worktree-app', '.git'),
    `gitdir: ${join(sandboxRoot, '.git-worktrees', 'worktree-app')}\n`
  )
  writeFileSync(
    join(sandboxRoot, '.git-worktrees', 'worktree-app', 'HEAD'),
    'ref: refs/heads/feature/windows\n'
  )
  mkdirSync(join(sandboxRoot, '.hidden-dotdir'), { recursive: true })
  writeFileSync(join(sandboxRoot, 'projects', 'file-not-dir.txt'), 'nope')
  mkdirSync(join(outsideRoot, 'secret'), { recursive: true })

  server = await startTestServer()
  const session = await fetch(`${server.baseUrl}/api/ui/session`)
  cookie = session.headers.get('set-cookie') ?? ''
})

afterEach(async () => {
  await server.close()
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const browse = async (pathParam: string | null) => {
  const query = pathParam === null ? '' : `?path=${encodeURIComponent(pathParam)}`
  const response = await fetch(`${server.baseUrl}/api/fs/browse${query}`, {
    headers: { cookie },
  })
  return { status: response.status, body: await response.json() }
}

const probe = async (pathParam: string) => {
  const response = await fetch(
    `${server.baseUrl}/api/fs/probe?path=${encodeURIComponent(pathParam)}`,
    { headers: { cookie } }
  )
  return (await response.json()) as Record<string, unknown>
}

const denyDirectoryReadOnWindows = (path: string) => {
  const whoami = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  const sid = whoami.trim().match(/"[^"]+","([^"]+)"/)?.[1]
  if (!sid) throw new Error(`Unable to determine current Windows SID from: ${whoami}`)
  const identity = `*${sid}`
  execFileSync('icacls', [path, '/deny', `${identity}:(RX)`], { stdio: 'ignore' })
  return () => {
    execFileSync('icacls', [path, '/remove:d', identity], { stdio: 'ignore' })
  }
}

test.skipIf(process.platform === 'win32')(
  'does not read a git directory outside the browse root',
  async () => {
    const repo = join(sandboxRoot, 'projects', 'external-gitdir')
    mkdirSync(repo)
    writeFileSync(join(repo, '.git'), `gitdir: ${outsideRoot}\n`)
    writeFileSync(join(outsideRoot, 'HEAD'), 'ref: refs/heads/private\n')
    const result = await probe(repo)
    expect(result.current_branch).toBeNull()
    expect(result.is_git_repository).toBe(false)
  }
)

describe('GET /api/fs/browse', () => {
  test('defaults to the sandbox root and lists directories, hides dotdirs + files', async () => {
    const { body, status } = await browse(null)
    const expectedRoot = realpathSync.native(sandboxRoot)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.root_path).toBe(expectedRoot)
    expect(body.current_path).toBe(expectedRoot)
    expect(body.parent_path).toBeNull()
    const names = (body.entries as Array<{ name: string }>).map((entry) => entry.name)
    expect(names).toEqual(['projects'])
  })

  test('descends into a subdirectory and detects .git repositories', async () => {
    const { body } = await browse(join(sandboxRoot, 'projects'))
    expect(body.ok).toBe(true)
    expect(body.current_path).toBe(join(sandboxRoot, 'projects'))
    expect(body.parent_path).toBe(sandboxRoot)
    const entry = (body.entries as Array<{ name: string; is_git_repository: boolean }>).find(
      (e) => e.name === 'my-app'
    )
    expect(entry).toBeDefined()
    expect(entry?.is_git_repository).toBe(true)
  })

  test('accepts quoted paths copied from Windows Explorer before sandbox checks', async () => {
    const { body, status } = await browse(`  "${join(sandboxRoot, 'projects')}"  `)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(sameFilesystemPath(body.current_path, join(sandboxRoot, 'projects'))).toBe(true)
    expect((body.entries as Array<{ name: string }>).map((entry) => entry.name)).toContain('my-app')
  })

  test('rejects absolute paths that fall outside the sandbox root', async () => {
    const { body, status } = await browse(join(outsideRoot, 'secret'))
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/outside the browse root/)
    expect(body.entries).toEqual([])
  })

  test('rejects "../" traversal that escapes the sandbox root', async () => {
    const { body, status } = await browse('../../etc')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/outside the browse root/)
  })

  test('rejects symlinks or junction-like paths that resolve outside the sandbox root', async () => {
    const linkPath = join(sandboxRoot, 'projects', 'outside-link')
    symlinkSync(
      join(outsideRoot, 'secret'),
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const { body, status } = await browse(linkPath)
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/outside the browse root/)
  })

  test('requires the UI cookie', async () => {
    const response = await fetch(`${server.baseUrl}/api/fs/browse`)
    expect(response.status).toBe(403)
  })

  test('surfaces a readdir EACCES as ok:false instead of a server 500', async () => {
    // On Windows chmod is a no-op, so use the platform ACL tool to deny
    // directory read rights to the current SID. On POSIX chmod 000 hits
    // the same `stat`/`readdir` rejection contract from the route's
    // perspective.
    const unreadable = join(sandboxRoot, 'unreadable')
    mkdirSync(unreadable, { recursive: true })
    const restoreAccess =
      process.platform === 'win32'
        ? denyDirectoryReadOnWindows(unreadable)
        : () => chmodSync(unreadable, 0o755)
    if (process.platform !== 'win32') chmodSync(unreadable, 0o000)
    try {
      const { body, status } = await browse(unreadable)
      // Crucial: NOT 500. The route translates ok:false to 400 (the
      // user picked a path that we can't list); a 500 would mean the
      // handler crashed, which is the regression we're guarding.
      expect(status).not.toBe(500)
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/permission|EACCES|denied/i)
      expect(body.entries).toEqual([])
      expect(
        sameFilesystemPath(body.current_path, unreadable) ||
          sameFilesystemPath(body.current_path, sandboxRoot)
      ).toBe(true)
      if (sameFilesystemPath(body.current_path, unreadable)) {
        expect(sameFilesystemPath(body.parent_path, sandboxRoot)).toBe(true)
      }
    } finally {
      // Restore perms so afterEach cleanup can rm the temp dir.
      restoreAccess()
    }
  })

  test.runIf(process.platform === 'win32')(
    'Windows full browser starts at This PC and can enter HOME when no sandbox override is set',
    async () => {
      delete process.env.HIVE_FS_BROWSE_ROOT

      const home = realpathSync.native(homedir())
      const homeDriveRoot = parse(home).root
      const rootName = homeDriveRoot.replace(/[\\/:]+$/g, ':')

      const drivesBrowse = await browse(null)
      expect(drivesBrowse.status).toBe(200)
      expect(drivesBrowse.body.ok).toBe(true)
      expect(drivesBrowse.body.root_path).toBe(WINDOWS_DRIVES_ROOT)
      expect(drivesBrowse.body.current_path).toBe(WINDOWS_DRIVES_ROOT)
      expect(drivesBrowse.body.parent_path).toBeNull()
      expect(drivesBrowse.body.entries).toContainEqual(
        expect.objectContaining({ name: rootName, path: homeDriveRoot })
      )

      const driveBrowse = await browse(homeDriveRoot)
      expect(driveBrowse.status).toBe(200)
      expect(driveBrowse.body.ok).toBe(true)
      expect(sameFilesystemPath(driveBrowse.body.current_path, homeDriveRoot)).toBe(true)
      expect(driveBrowse.body.parent_path).toBe(WINDOWS_DRIVES_ROOT)

      const homeBrowse = await browse(home)
      expect(homeBrowse.status).toBe(200)
      expect(homeBrowse.body.ok).toBe(true)
      expect(sameFilesystemPath(homeBrowse.body.current_path, home)).toBe(true)
      expect(homeBrowse.body.parent_path).not.toBeNull()

      const missingBrowse = await browse(join(home, '__hive_missing_directory__'))
      expect(missingBrowse.status).toBe(400)
      expect(missingBrowse.body.ok).toBe(false)
      expect(sameFilesystemPath(missingBrowse.body.parent_path, home)).toBe(true)

      const driveProbe = await probe(homeDriveRoot)
      expect(driveProbe.ok).toBe(true)
      expect(driveProbe.is_dir).toBe(true)
    }
  )
})

describe('GET /api/fs/probe', () => {
  test('reports git repository + current branch for a repo inside the sandbox', async () => {
    const body = await probe(join(sandboxRoot, 'projects', 'my-app'))
    expect(body.ok).toBe(true)
    expect(body.is_dir).toBe(true)
    expect(body.is_git_repository).toBe(true)
    expect(body.suggested_name).toBe('my-app')
    expect(body.current_branch).toBe('main')
  })

  test('accepts quoted probe paths copied from Windows Explorer', async () => {
    const body = await probe(`  "${join(sandboxRoot, 'projects', 'my-app')}"  `)
    expect(body.ok).toBe(true)
    expect(body.is_dir).toBe(true)
    expect(body.is_git_repository).toBe(true)
    expect(body.suggested_name).toBe('my-app')
  })

  test('reports current branch from a worktree-style .git file without spawning git', async () => {
    const body = await probe(join(sandboxRoot, 'projects', 'worktree-app'))
    expect(body.ok).toBe(true)
    expect(body.is_dir).toBe(true)
    expect(body.is_git_repository).toBe(true)
    expect(body.current_branch).toBe('feature/windows')
  })

  test('returns ok=false for paths outside the sandbox', async () => {
    const body = await probe(join(outsideRoot, 'secret'))
    expect(body.ok).toBe(false)
    expect(body.is_dir).toBe(false)
  })
})
