import { readFileSync } from 'node:fs'

const inboxReferencePattern =
  /\[hive-inbox [a-f0-9-]+[^\]\r\n]*\] Read ("(?:[^"\\]|\\.)*") for the complete Hive system message\./g

/** Expand only runtime-owned references; use raw input separately to check transport. */
export const expandInboxReferences = (text: string): string =>
  text.replace(inboxReferencePattern, (_match, path: string) =>
    readFileSync(JSON.parse(path) as string, 'utf8')
  )

/** Native CLI fixtures read the same files that a real agent would open. */
export const inboxReaderSource = `
import { readFileSync as readInboxFile } from 'node:fs'
const expandReceivedInbox = (text) => text.replace(
  new RegExp(${JSON.stringify(inboxReferencePattern.source)}, 'g'),
  (_match, path) => readInboxFile(JSON.parse(path), 'utf8')
)
`

export const inboxReaderCommonJsSource = inboxReaderSource.replace(
  "import { readFileSync as readInboxFile } from 'node:fs'",
  "const { readFileSync: readInboxFile } = require('node:fs')"
)
