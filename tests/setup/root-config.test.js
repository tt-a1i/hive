import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const readRequiredFile = (path) => {
  expect(existsSync(path)).toBe(true)
  return readFileSync(path, 'utf8')
}

test('root project config exists', () => {
  expect(existsSync('package.json')).toBe(true)
  expect(existsSync('tsconfig.json')).toBe(true)
  expect(existsSync('vitest.config.ts')).toBe(true)
})

test('public package metadata is ready for external users', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(packageJson.license).toBe('Apache-2.0')
  expect(packageJson.description).toBe(
    'Local multi-agent workspace for coordinating CLI coding agents through a web UI.'
  )
  expect(packageJson.keywords).toEqual(
    expect.arrayContaining(['ai-agents', 'cli', 'collaboration', 'multi-agent', 'workspace'])
  )
  expect(packageJson.files).toEqual(
    expect.arrayContaining(['CHANGELOG.md', 'LICENSE', 'README.md', 'SECURITY.md'])
  )
})

test('public support documents describe license, safety, and release scope', () => {
  const changelog = readRequiredFile('CHANGELOG.md')
  const license = readRequiredFile('LICENSE')
  const readme = readRequiredFile('README.md')
  const security = readRequiredFile('SECURITY.md')

  expect(changelog).toContain('0.6.0-alpha.0')
  expect(license).toContain('Apache License')
  expect(license).toContain('Version 2.0')
  expect(readme).toContain('60 Second Start')
  expect(readme).toContain('Platform Support')
  expect(readme).toContain('Safety Model')
  expect(readme).toContain('the publish job requires `NPM_TOKEN`')
  expect(security).toContain('Reporting a Vulnerability')
  expect(security).toContain('127.0.0.1')
  expect(security).toContain('arbitrary shell commands')
})
