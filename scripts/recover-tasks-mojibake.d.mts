interface TextMetrics {
  characters: number
  han: number
  mojibakeMarkers: number
  replacementCharacters: number
}

export function recoverMojibakePass(input: string): string
export function recoverMojibake(
  input: string,
  maxPasses?: number
): { content: string; passes: number; before: TextMetrics; after: TextMetrics }
export function runRecoveryCli(args: string[]): {
  after: TextMetrics
  before: TextMetrics
  inputPath: string
  outputPath: string
  passes: number
  reportPath: string | undefined
  sourceSha256: string
}
