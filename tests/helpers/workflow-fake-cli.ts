import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { inboxReaderCommonJsSource } from './inbox.js'

export const writePassiveWorkflowCli = (binDir: string, name: string) => {
  const scriptPath = join(binDir, `${name}-workflow-fake.js`)
  writeFileSync(
    scriptPath,
    [
      inboxReaderCommonJsSource,
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      "const PASTE_OPEN = '\\u001b[200~'",
      "const PASTE_END = '\\u001b[201~'",
      "const FIRST_PASTE_ACK_DELAY_MS = Number(process.env.HIVE_FAKE_CLI_FIRST_PASTE_ACK_DELAY_MS || '0')",
      "let pasteBuffer = ''",
      'let pasteCount = 0',
      "process.stdout.write('› ')",
      "process.stdin.on('data', (chunk) => {",
      '  pasteBuffer += chunk',
      '  pasteBuffer = expandReceivedInbox(pasteBuffer)',
      '  const sawPasteStart = pasteBuffer.includes(PASTE_OPEN) || pasteBuffer.includes("<hive-message")',
      '  const sawPasteEnd = pasteBuffer.includes(PASTE_END) || (process.platform === "win32" && sawPasteStart && pasteBuffer.includes("</hive-message>"))',
      '  if (sawPasteEnd) {',
      '    pasteCount += 1',
      '    const currentPaste = pasteCount',
      '    const dispatch = pasteBuffer.match(/dispatch_id: ([^\\s|<]+)/)',
      "    if (dispatch) process.stdout.write('\\nDISPATCH:' + dispatch[1])",
      "    const ack = () => process.stdout.write('\\n[Pasted text #' + currentPaste + ']\\n› ')",
      '    if (currentPaste === 1 && FIRST_PASTE_ACK_DELAY_MS > 0) setTimeout(ack, FIRST_PASTE_ACK_DELAY_MS)',
      '    else ack()',
      "    pasteBuffer = ''",
      '    return',
      '  }',
      '  if (/^[\\r\\n]+$/.test(chunk)) {',
      "    pasteBuffer = ''",
      "    process.stdout.write('\\nSUBMITTED\\n› ')",
      '  }',
      '})',
      'process.stdin.resume()',
      'setInterval(() => {}, 1 << 30)',
    ].join('\n')
  )
  const unixCli = join(binDir, name)
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  const winCli = join(binDir, `${name}.cmd`)
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
}

export const prependPassiveWorkflowCliPath = (
  baseDir: string,
  names: readonly string[],
  originalPath = process.env.PATH
) => {
  const binDir = join(baseDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  for (const name of names) writePassiveWorkflowCli(binDir, name)
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
  return binDir
}
