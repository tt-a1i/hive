import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveSpawnCommand } from '../../src/server/agent-command-resolver.js'
import {
  commandVendorToken,
  createStartupCommandLaunch,
  getStartupCommandExecutable,
} from '../../src/server/startup-command-parser.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

/** Same node-pty `argsToCommandLine` model used in
 * `agent-command-resolver.test.ts`; see comments there for rationale. */
const repeat = (s: string, n: number) => (n <= 0 ? '' : s.repeat(n))
const simulateNodePtyCommandLine = (file: string, args: string | string[]): string => {
  if (typeof args === 'string') {
    return args.length === 0 ? file : `${simulateNodePtyCommandLine(file, [])} ${args}`
  }
  const argv = [file, ...args]
  let result = ''
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) result += ' '
    const arg = argv[argIndex] ?? ''
    const hasLopsidedEnclosingQuote = (arg[0] !== '"') !== (arg[arg.length - 1] !== '"')
    const hasNoEnclosingQuotes = arg[0] !== '"' && arg[arg.length - 1] !== '"'
    const quote =
      arg === '' ||
      ((arg.indexOf(' ') !== -1 || arg.indexOf('\t') !== -1) &&
        arg.length > 1 &&
        (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes))
    if (quote) result += '"'
    let bsCount = 0
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i]
      if (p === '\\') {
        bsCount++
      } else if (p === '"') {
        result += repeat('\\', bsCount * 2 + 1)
        result += '"'
        bsCount = 0
      } else {
        result += repeat('\\', bsCount)
        bsCount = 0
        result += p
      }
    }
    if (quote) {
      result += repeat('\\', bsCount * 2)
      result += '"'
    } else {
      result += repeat('\\', bsCount)
    }
  }
  return result
}

describe('startup command parser', () => {
  describe('POSIX shell branch (unchanged)', () => {
    test('uses an interactive login shell for bash-like shells', () => {
      const parsed = createStartupCommandLaunch('  echo hi  ', { SHELL: '/bin/bash' }, 'linux')
      expect(parsed).toEqual({
        args: ['-lic', '  echo hi  '],
        command: '/bin/bash',
      })
    })

    test('falls back to /bin/sh when SHELL is unset', () => {
      const parsed = createStartupCommandLaunch('echo hi', {}, 'linux')
      expect(parsed.command).toBe('/bin/sh')
      expect(parsed.args).toEqual(['-ic', 'echo hi'])
    })

    test('fish gets -ic, not -lic', () => {
      const parsed = createStartupCommandLaunch(
        'echo hi',
        { SHELL: '/usr/local/bin/fish' },
        'linux'
      )
      expect(parsed.args).toEqual(['-ic', 'echo hi'])
    })
  })

  describe('Windows verbatim branch', () => {
    test('preserves padded and trailing whitespace in the Windows command payload', () => {
      const command = '  echo hello \t '
      const parsed = createStartupCommandLaunch(command, { ComSpec: 'cmd.exe' }, 'win32')
      expect(parsed).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', command] })
    })

    test('parser still emits a string[] for storage compatibility', () => {
      const parsed = createStartupCommandLaunch(
        '"C:\\nvm4w\\nodejs\\claude.CMD" --resume foo',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32'
      )
      // The launch config persistence layer types args as `string[]`; the
      // parser must continue to return that shape. The verbatim-string
      // repackaging happens at spawn time inside `resolveSpawnCommand`.
      expect(parsed.command).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(parsed.args).toEqual([
        '/d',
        '/s',
        '/c',
        '"C:\\nvm4w\\nodejs\\claude.CMD" --resume foo',
      ])
    })

    test('prefers an explicit ComSpec override over older Windows env casing', () => {
      const parsed = createStartupCommandLaunch(
        'claude --resume foo',
        { ComSpec: 'C:\\fake\\cmd.exe', comspec: 'C:\\old\\cmd.exe' },
        'win32'
      )
      expect(parsed.command).toBe('C:\\fake\\cmd.exe')
    })

    test('quoted Windows path survives node-pty serialization via cmd.exe shell-launch repackage', () => {
      // The actual user bug: `"C:\nvm4w\nodejs\claude.CMD"` typed into the
      // startup command field (Windows users habitually wrap paths). The
      // parser stores it; resolveSpawnCommand must repackage so cmd.exe sees
      // the user's raw line verbatim, not the backslash-escaped form
      // node-pty's argsToCommandLine would produce.
      const root = mkdtempSync(join(tmpdir(), 'hive-startup-win-'))
      tempDirs.push(root)
      const sys32 = join(root, 'Windows', 'System32')
      mkdirSync(sys32, { recursive: true })
      const cmdExePath = join(sys32, 'cmd.exe')
      writeFileSync(cmdExePath, 'fake cmd.exe placeholder')

      const parsed = createStartupCommandLaunch(
        '"C:\\nvm4w\\nodejs\\claude.CMD"',
        { ComSpec: cmdExePath },
        'win32'
      )
      const resolved = resolveSpawnCommand(
        parsed.command,
        root,
        {
          ComSpec: cmdExePath,
          Path: `${sys32}${delimiter}${process.env.PATH ?? ''}`,
          PathExt: '.EXE;.CMD',
        },
        parsed.args,
        'win32'
      )
      expect(typeof resolved.args).toBe('string')

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // Crucial: cmd.exe receives the user's raw line VERBATIM. cmd's `/s /c`
      // then strips the first/last quote, leaving `C:\nvm4w\nodejs\claude.CMD`
      // as the program name. NO `\"` mangling anywhere.
      expect(finalCommandLine).toBe(`${cmdExePath} /d /s /c "C:\\nvm4w\\nodejs\\claude.CMD"`)
      expect(finalCommandLine).not.toContain('\\"')
    })

    test('unquoted command with args also survives verbatim', () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-startup-win-'))
      tempDirs.push(root)
      const sys32 = join(root, 'Windows', 'System32')
      mkdirSync(sys32, { recursive: true })
      const cmdExePath = join(sys32, 'cmd.exe')
      writeFileSync(cmdExePath, 'fake cmd.exe placeholder')

      const parsed = createStartupCommandLaunch(
        'claude --resume abc',
        { ComSpec: cmdExePath },
        'win32'
      )
      const resolved = resolveSpawnCommand(
        parsed.command,
        root,
        {
          ComSpec: cmdExePath,
          Path: sys32,
          PathExt: '.EXE;.CMD',
        },
        parsed.args,
        'win32'
      )
      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // Verbatim — cmd's PATH lookup will find claude.CMD via PATHEXT.
      expect(finalCommandLine).toBe(`${cmdExePath} /d /s /c claude --resume abc`)
    })
  })

  describe('getStartupCommandExecutable', () => {
    // Extractor contract: return the raw command token from the leading
    // position of the startup command. CLI-brand identification (mapping
    // the token to a known preset like "claude"/"codex") happens in
    // agent-launch-resolver.ts — that's where the full-stack tests live.
    test('extracts the unquoted command word', () => {
      expect(getStartupCommandExecutable('claude --resume abc')).toBe('claude')
    })

    test('extracts a quoted Windows path without spaces', () => {
      expect(getStartupCommandExecutable('"C:\\path\\claude.CMD" --resume abc')).toBe(
        'C:\\path\\claude.CMD'
      )
    })

    test('extracts a quoted Windows path containing spaces', () => {
      // The real-world case: `C:\Program Files\nodejs\claude.cmd` is the
      // default nvm4w / Node installer path. Previously the extractor regex
      // forbade spaces inside the captured group and returned null here,
      // which broke CLI-brand identification end to end.
      expect(
        getStartupCommandExecutable('"C:\\Program Files\\nodejs\\claude.cmd" --continue')
      ).toBe('C:\\Program Files\\nodejs\\claude.cmd')
    })

    test('extracts a single-quoted POSIX path containing spaces', () => {
      expect(getStartupCommandExecutable("'/opt/my agents/codex' resume xyz")).toBe(
        '/opt/my agents/codex'
      )
    })

    test('returns null on empty input', () => {
      expect(getStartupCommandExecutable('')).toBeNull()
      expect(getStartupCommandExecutable('   ')).toBeNull()
    })

    test('returns null on an unbalanced opening quote', () => {
      // `"claude --continue` (no closing quote) must not produce a token
      // with a stray quote character — that token would never match a
      // preset id and would also confuse downstream basename normalization.
      // Explicit null is safer than a polluted token.
      expect(getStartupCommandExecutable('"claude --continue')).toBeNull()
      expect(getStartupCommandExecutable("'codex resume abc")).toBeNull()
    })
  })
})

describe('commandVendorToken', () => {
  test('skips package-runner wrappers and strips scope/version', () => {
    expect(commandVendorToken('npx', ['@anthropic-ai/claude-code'])).toBe('claude-code')
    expect(commandVendorToken('npx', ['--yes', '@openai/codex@latest'])).toBe('codex')
    expect(commandVendorToken('pnpm', ['dlx', '@google/gemini-cli'])).toBe('gemini-cli')
    expect(commandVendorToken('bunx', ['claude'])).toBe('claude')
    expect(commandVendorToken('uvx', ['some-tool'])).toBe('some-tool')
    expect(commandVendorToken('claude')).toBe('claude')
  })

  test('never matches on an empty token', () => {
    expect(commandVendorToken('npx')).toBeNull()
    expect(commandVendorToken('npx', ['--yes'])).toBeNull()
    expect(commandVendorToken('')).toBeNull()
    expect(commandVendorToken(null)).toBeNull()
  })
})
