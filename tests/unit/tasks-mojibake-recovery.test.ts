import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import {
  recoverMojibake,
  recoverMojibakePass,
  runRecoveryCli,
} from '../../scripts/recover-tasks-mojibake.mjs'

const corruptOnce = (text: string) => new TextDecoder('windows-1252').decode(Buffer.from(text))
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('tasks mojibake recovery preview', () => {
  test('recovers repeatedly misdecoded UTF-8 while preserving Markdown and emoji', () => {
    const original = '# 任务 🚀\n- [ ] 中文，English `code` [链接](https://example.com/路径)\n'
    let damaged = original
    for (let pass = 0; pass < 5; pass += 1) damaged = corruptOnce(damaged)

    const recovered = recoverMojibake(damaged)

    expect(recovered.content).toBe(original)
    expect(recovered.passes).toBe(5)
    expect(recovered.after.replacementCharacters).toBe(0)
  })

  test('does not rewrite valid UTF-8 prose that has no mojibake markers', () => {
    const valid = 'café 中文 😀\n'
    expect(recoverMojibakePass(valid)).toBe(valid)
  })

  test('does not guess that an isolated literal mojibake marker is damaged', () => {
    const validLiteral = 'The literal string Ã© is part of this example.\n'
    expect(recoverMojibake(validLiteral).content).toBe(validLiteral)
  })

  test('CLI writes a separate preview and hash-only audit without changing source bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-tasks-recovery-'))
    tempDirs.push(dir)
    const input = join(dir, 'tasks.md')
    const output = join(dir, 'tasks.preview.md')
    const report = join(dir, 'tasks.preview.audit.json')
    const original = '# 任务 🚀\n- [ ] 中文，English `code`\n'
    let damaged = original
    for (let pass = 0; pass < 3; pass += 1) damaged = corruptOnce(damaged)
    const sourceBytes = Buffer.from(damaged, 'utf8')
    writeFileSync(input, sourceBytes)

    const result = runRecoveryCli(['--input', input, '--output', output, '--report', report])

    expect(readFileSync(input)).toEqual(sourceBytes)
    expect(readFileSync(output, 'utf8')).toBe(original)
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
    const audit = JSON.parse(readFileSync(report, 'utf8')) as {
      changed_lines: Array<Record<string, unknown>>
      warning: string
    }
    expect(audit.warning).toContain('Review before replacing')
    expect(audit.changed_lines).toHaveLength(2)
    expect(audit.changed_lines[0]).not.toHaveProperty('before')
    expect(audit.changed_lines[0]).not.toHaveProperty('after')
  })

  test('CLI refuses same-path, existing-output, missing-argument, and invalid UTF-8 inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-tasks-recovery-guards-'))
    tempDirs.push(dir)
    const input = join(dir, 'tasks.md')
    const output = join(dir, 'existing.md')
    writeFileSync(input, 'valid', 'utf8')
    writeFileSync(output, 'keep-me', 'utf8')

    expect(() => runRecoveryCli(['--input', input, '--output', input])).toThrow(
      'Refusing to overwrite the input file'
    )
    expect(() => runRecoveryCli(['--input', input, '--output', output])).toThrow()
    expect(readFileSync(output, 'utf8')).toBe('keep-me')
    const reservedOutput = join(dir, 'reserved-output.md')
    const existingReport = join(dir, 'existing-report.json')
    writeFileSync(existingReport, 'keep-report', 'utf8')
    expect(() =>
      runRecoveryCli(['--input', input, '--output', reservedOutput, '--report', existingReport])
    ).toThrow()
    expect(existsSync(reservedOutput)).toBe(false)
    expect(readFileSync(existingReport, 'utf8')).toBe('keep-report')
    expect(() => runRecoveryCli(['--input', input])).toThrow(
      'Both --input and --output are required'
    )

    const invalid = join(dir, 'invalid.md')
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]))
    expect(() =>
      runRecoveryCli(['--input', invalid, '--output', join(dir, 'invalid.preview.md')])
    ).toThrow()
  })
})
