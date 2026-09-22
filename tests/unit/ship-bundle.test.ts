import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildShipManifest,
  buildUploadPlan,
  detectEntryUrls,
  renderGeneratedModule,
} from '../../gateway/scripts/ship-bundle.mjs'

// ship-bundle.mjs codegens the WORKER-ANCHORED manifest (the sha384 trust root) + the R2 upload
// plan. The security contract these tests defend:
//   - the loader emits SRI ONLY for the ENTRY chunk(s) (entry js + its css), detected from the
//     freshly-built index.html — never a hardcoded hash;
//   - lazy chunks are pinned (worker re-verifies them from R2) but marked isEntry:false so they
//     don't leak into the loader;
//   - EVERY file under dist gets an R2 key derived only from version+path (no traversal);
//   - codegen is deterministic so a re-ship of the same dist is a no-op diff.

const sha384 = (s: string) =>
  `sha384-${createHash('sha384').update(Buffer.from(s)).digest('base64')}`

// A realistic code-split fixture: a hash-named entry js + its entry css (referenced by index.html),
// plus lazy chunks (xterm, a drawer) under assets/, plus non-JS/CSS files (a font, the webmanifest,
// a source map) that ship to R2 but are NOT SRI-pinned.
function writeFixture(dist: string) {
  mkdirSync(join(dist, 'assets'), { recursive: true })
  const files = {
    'assets/index-DfDCUk9m.js': 'export const app = true; import("./xterm-B-qIQCd3.js")\n',
    'assets/index-CfiKBH8o.css': 'body{margin:0}\n',
    'assets/xterm-B-qIQCd3.js': 'export const term = 1\n',
    'assets/MarketplaceDrawer-CLXpimuT.js': 'export const drawer = 2\n',
    'assets/index-DfDCUk9m.js.map': '{"version":3}\n',
    'logo.png': '\x89PNG\n',
    'manifest.webmanifest': '{"name":"Hive"}\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dist, rel), body)
  }
  // index.html is what the build rewrites to reference the ENTRY only. ship-bundle reads the hash
  // out of HERE, never a constant.
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-DfDCUk9m.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CfiKBH8o.css">
</head><body><div id="root"></div></body></html>`
  )
  return files
}

describe('detectEntryUrls', () => {
  let dist: string
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'ship-entry-'))
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  test('reads the entry js + css out of index.html (the hash is never hardcoded)', () => {
    writeFixture(dist)
    const urls = detectEntryUrls(dist)
    // dist-relative paths (leading "/" stripped) — Vite emits the entry under assets/
    expect(urls).toEqual(new Set(['assets/index-DfDCUk9m.js', 'assets/index-CfiKBH8o.css']))
    // a lazy chunk is NOT in index.html, so it must NOT be detected as an entry
    expect(urls.has('assets/xterm-B-qIQCd3.js')).toBe(false)
    expect(urls.has('assets/MarketplaceDrawer-CLXpimuT.js')).toBe(false)
  })

  test('ignores absolute-URL refs (google fonts) — only local entry assets count', () => {
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'assets', 'index-AAAA.js'), 'export const x = 1\n')
    writeFileSync(
      join(dist, 'index.html'),
      `<link href="https://fonts.googleapis.com/css2?family=Inter.css" rel="stylesheet">
<script type="module" src="/assets/index-AAAA.js"></script>`
    )
    const urls = detectEntryUrls(dist)
    expect(urls).toEqual(new Set(['assets/index-AAAA.js']))
    expect([...urls].some((u) => u.includes('fonts.googleapis'))).toBe(false)
  })

  test('throws if index.html references no entry asset (refuses an empty loader)', () => {
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html><html><head></head><body></body></html>'
    )
    expect(() => detectEntryUrls(dist)).toThrow()
  })
})

describe('buildShipManifest — pins every JS/CSS, marks ONLY the entry isEntry', () => {
  let dist: string
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'ship-manifest-'))
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  test('entry chunks get isEntry:true, lazy chunks isEntry:false, all sha384-pinned', () => {
    const files = writeFixture(dist)
    const m = buildShipManifest(dist, '1.7.0')
    expect(m.version).toBe('1.7.0')

    const byUrl = new Map(m.entries.map((e) => [e.url, e]))
    const entryJs = byUrl.get('/assets/1.7.0/assets/index-DfDCUk9m.js')
    const entryCss = byUrl.get('/assets/1.7.0/assets/index-CfiKBH8o.css')
    const lazyXterm = byUrl.get('/assets/1.7.0/assets/xterm-B-qIQCd3.js')
    const lazyDrawer = byUrl.get('/assets/1.7.0/assets/MarketplaceDrawer-CLXpimuT.js')

    // entry: emitted in the loader with SRI
    expect(entryJs?.isEntry).toBe(true)
    expect(entryCss?.isEntry).toBe(true)
    // lazy: pinned (worker re-verifies) but NOT in the loader
    expect(lazyXterm?.isEntry).toBe(false)
    expect(lazyDrawer?.isEntry).toBe(false)

    // every pinned entry is the REAL sha384 of the actual bytes (reversing bytes->integrity fails)
    expect(entryJs?.integrity).toBe(sha384(files['assets/index-DfDCUk9m.js']))
    expect(lazyXterm?.integrity).toBe(sha384(files['assets/xterm-B-qIQCd3.js']))

    // exactly the 4 JS/CSS files are pinned; the png/webmanifest/.map are NOT (they have no SRI)
    expect(m.entries.length).toBe(4)
    expect(m.entries.some((e) => e.url.endsWith('.png'))).toBe(false)
    expect(m.entries.some((e) => e.url.endsWith('.webmanifest'))).toBe(false)
    expect(m.entries.some((e) => e.url.endsWith('.map'))).toBe(false)
  })

  test('throws if index.html names an entry asset the build did not emit (no unverifiable tag)', () => {
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'assets', 'index-AAAA.css'), 'body{}\n')
    // index.html points at a js that was never built
    writeFileSync(
      join(dist, 'index.html'),
      '<script type="module" src="/assets/index-MISSING.js"></script><link rel="stylesheet" href="/assets/index-AAAA.css">'
    )
    expect(() => buildShipManifest(dist, '1.0.0')).toThrow()
  })

  test('throws if no entry SCRIPT is detected (a css-only loader cannot boot)', () => {
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'assets', 'index-AAAA.css'), 'body{}\n')
    writeFileSync(join(dist, 'index.html'), '<link rel="stylesheet" href="/assets/index-AAAA.css">')
    expect(() => buildShipManifest(dist, '1.0.0')).toThrow()
  })
})

describe('buildUploadPlan — every file -> R2 key, traversal-proof', () => {
  let dist: string
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'ship-plan-'))
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  test('covers EVERY file (not just JS/CSS), keyed assets/<version>/<rel>, sorted', () => {
    writeFixture(dist)
    const plan = buildUploadPlan(dist, '1.7.0')
    const keys = plan.files.map((f) => f.key)

    // lazy chunks AND non-pinned assets (png, webmanifest, source map, index.html) all upload
    expect(keys).toContain('assets/1.7.0/assets/xterm-B-qIQCd3.js')
    expect(keys).toContain('assets/1.7.0/logo.png')
    expect(keys).toContain('assets/1.7.0/manifest.webmanifest')
    expect(keys).toContain('assets/1.7.0/assets/index-DfDCUk9m.js.map')
    expect(keys).toContain('assets/1.7.0/index.html')

    // every key is strictly under assets/<version>/ — derived only from version+rel path
    for (const k of keys) expect(k.startsWith('assets/1.7.0/')).toBe(true)
    // sorted (deterministic upload order)
    expect([...keys].sort()).toEqual(keys)

    // content-type is mapped per extension; JS is text/javascript, png is image/png
    const js = plan.files.find((f) => f.key.endsWith('xterm-B-qIQCd3.js'))
    const png = plan.files.find((f) => f.key.endsWith('logo.png'))
    expect(js?.contentType).toContain('text/javascript')
    expect(png?.contentType).toBe('image/png')
  })
})

describe('renderGeneratedModule — deterministic, anchored, loader-honest', () => {
  let dist: string
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'ship-codegen-'))
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  test('idempotent: same dist + version -> byte-identical module', () => {
    writeFixture(dist)
    const a = renderGeneratedModule(buildShipManifest(dist, '1.7.0'))
    const b = renderGeneratedModule(buildShipManifest(dist, '1.7.0'))
    expect(a).toBe(b)
  })

  test('emits the @generated banner, the version, and one entry per pinned asset with isEntry', () => {
    writeFixture(dist)
    const code = renderGeneratedModule(buildShipManifest(dist, '1.7.0'))
    expect(code).toContain('@generated by gateway/scripts/ship-bundle.mjs')
    // single-quoted to match the project's biome quoteStyle (so a fresh codegen is biome-clean)
    expect(code).toContain("export const GENERATED_BUNDLE_VERSION = '1.7.0'")
    expect(code).toContain('export const GENERATED_BUNDLE_MANIFEST')
    // the integrity that ends up anchored is the real sha384 of the entry js
    expect(code).toContain(sha384('export const app = true; import("./xterm-B-qIQCd3.js")\n'))
    // both isEntry:true (entry) and isEntry:false (lazy) appear — the codegen marks every entry
    expect(code).toContain('isEntry: true,')
    expect(code).toContain('isEntry: false,')
    // it imports the shared type, never re-declares the SRI/verify logic
    expect(code).toContain("import type { BundleManifest } from './bundles.js'")
  })

  test('the codegen reflects byte changes: edit a chunk and the anchored integrity changes', () => {
    writeFixture(dist)
    const before = renderGeneratedModule(buildShipManifest(dist, '1.7.0'))
    // tamper one entry byte
    writeFileSync(join(dist, 'assets', 'index-DfDCUk9m.js'), 'export const app = false\n')
    // index.html still references the same hash-named file (we only changed its bytes)
    const after = renderGeneratedModule(buildShipManifest(dist, '1.7.0'))
    expect(after).not.toBe(before)
    expect(after).toContain(sha384('export const app = false\n'))
    expect(after).not.toContain(sha384('export const app = true; import("./xterm-B-qIQCd3.js")\n'))
  })
})
