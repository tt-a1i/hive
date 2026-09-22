import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CP1252_INVERSE = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
])

const byteForCodePoint = (codePoint) => {
  if (codePoint <= 0xff) return codePoint
  return CP1252_INVERSE.get(codePoint)
}

const metrics = (text) => ({
  characters: [...text].length,
  han: (text.match(/[\u3400-\u9fff]/gu) ?? []).length,
  mojibakeMarkers: (text.match(/[ÃÂâæåçðƒŠšŒœŽžŸ™€]/gu) ?? []).length,
  replacementCharacters: (text.match(/\uFFFD/gu) ?? []).length,
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const recoverMojibakePass = (input) => {
  let output = ''
  let candidate = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const flush = () => {
    if (!candidate) return
    const before = metrics(candidate)
    let decoded
    try {
      decoded = decoder.decode(
        Uint8Array.from([...candidate], (character) => byteForCodePoint(character.codePointAt(0)))
      )
    } catch {
      output += candidate
      candidate = ''
      return
    }
    const after = metrics(decoded)
    // A single marker can be legitimate text (for example a literal `Ã©`).
    // Only accept a marker-only improvement when the run is densely corrupted;
    // otherwise require the decode to reveal Han characters.
    const improvesCorruption =
      before.mojibakeMarkers >= 3 &&
      after.mojibakeMarkers * 2 <= before.mojibakeMarkers &&
      after.characters < before.characters
    const revealsHan = before.mojibakeMarkers > 0 && after.han > before.han
    output += improvesCorruption || revealsHan ? decoded : candidate
    candidate = ''
  }

  for (const character of input) {
    if (byteForCodePoint(character.codePointAt(0)) !== undefined) {
      candidate += character
    } else {
      flush()
      output += character
    }
  }
  flush()
  return output
}

export const recoverMojibake = (input, maxPasses = 8) => {
  let content = input
  let passes = 0
  while (passes < maxPasses) {
    const next = recoverMojibakePass(content)
    if (next === content) break
    content = next
    passes += 1
  }
  return { content, passes, before: metrics(input), after: metrics(content) }
}

const buildAuditReport = (input, result, inputPath, outputPath) => {
  const beforeLines = input.split(/\r\n|\n|\r/u)
  const afterLines = result.content.split(/\r\n|\n|\r/u)
  const changes = []
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    const before = beforeLines[index] ?? ''
    const after = afterLines[index] ?? ''
    if (before === after) continue
    changes.push({
      line: index + 1,
      before_sha256: sha256(before),
      after_sha256: sha256(after),
      before_metrics: metrics(before),
      after_metrics: metrics(after),
    })
  }
  return {
    kind: 'hive_tasks_mojibake_recovery_preview',
    warning: 'Candidate preview only. Review before replacing the source file.',
    input_path: inputPath,
    output_path: outputPath,
    input_sha256: sha256(Buffer.from(input, 'utf8')),
    output_sha256: sha256(Buffer.from(result.content, 'utf8')),
    passes: result.passes,
    before: result.before,
    after: result.after,
    changed_lines: changes,
  }
}

const parseArgs = (args) => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node scripts/recover-tasks-mojibake.mjs --input <path> --output <path>'
      )
    }
    values.set(key, value)
  }
  return values
}

export const runRecoveryCli = (args) => {
  const values = parseArgs(args)
  if (!values.get('--input') || !values.get('--output')) {
    throw new Error('Both --input and --output are required')
  }
  const inputPath = resolve(values.get('--input'))
  const outputPath = resolve(values.get('--output'))
  const reportPath = values.get('--report') ? resolve(values.get('--report')) : undefined
  if (inputPath === outputPath) throw new Error('Refusing to overwrite the input file')
  if (reportPath && (reportPath === inputPath || reportPath === outputPath)) {
    throw new Error('Report path must be distinct from input and output')
  }

  const sourceBytes = readFileSync(inputPath)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
  const result = recoverMojibake(source)
  let outputFd
  let reportFd
  let outputCreated = false
  let reportCreated = false
  try {
    // Reserve every destination exclusively before writing either artifact.
    // If the second reservation or a write fails, only files created by this
    // invocation are removed; existing user files are never opened for write.
    outputFd = openSync(outputPath, 'wx')
    outputCreated = true
    if (reportPath) {
      reportFd = openSync(reportPath, 'wx')
      reportCreated = true
    }
    writeFileSync(outputFd, result.content, 'utf8')
    if (reportPath && reportFd !== undefined) {
      const report = buildAuditReport(source, result, inputPath, outputPath)
      writeFileSync(reportFd, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
  } catch (error) {
    if (reportFd !== undefined) {
      closeSync(reportFd)
      reportFd = undefined
    }
    if (outputFd !== undefined) {
      closeSync(outputFd)
      outputFd = undefined
    }
    if (reportCreated && reportPath) unlinkSync(reportPath)
    if (outputCreated) unlinkSync(outputPath)
    throw error
  } finally {
    if (reportFd !== undefined) closeSync(reportFd)
    if (outputFd !== undefined) closeSync(outputFd)
  }
  return {
    after: result.after,
    before: result.before,
    inputPath,
    outputPath,
    passes: result.passes,
    reportPath,
    sourceSha256: sha256(sourceBytes),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(runRecoveryCli(process.argv.slice(2)), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
