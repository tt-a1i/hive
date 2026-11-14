#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const source = /^(?:src|web\/src|gateway\/src)\/.*\.(?:[cm]?[jt]sx?)$/
const integration = /^tests\/(?:server|cli|integration)\/.*\.(?:[cm]?[jt]sx?)$/

function lines(text) {
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}
function isName(node, name) {
  return ts.isIdentifier(node) && node.text === name
}
function isProperty(node, name) {
  return ts.isPropertyAccessExpression(node) && node.name.text === name
}
function isPtyModule(node) {
  return (
    ts.isStringLiteralLike(node) &&
    /(?:^|\/)mock-node-pty(?:\.[cm]?[jt]s)?$|(?:^|\/)node-pty$/.test(node.text)
  )
}
export function checkFile(file, content, previous) {
  const errors = []
  const report = (path, message) => errors.push(`${path}: ${message}`)
  if (!source.test(file) && !integration.test(file)) return errors
  if (source.test(file)) {
    const count = lines(content)
    if (count > 500 && previous === undefined)
      report(file, `new source file has ${count} lines (maximum 500)`)
    if (count > 600 && previous !== undefined) {
      const previousCount = lines(previous)
      if (count > previousCount)
        report(file, `source file grew from ${previousCount} to ${count} lines above 600`)
    }
  }
  const ast = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const ptyAliases = new Set()
  function collectAliases(node) {
    if (ts.isImportDeclaration(node) && node.importClause && isPtyModule(node.moduleSpecifier)) {
      if (node.importClause.name) ptyAliases.add(node.importClause.name.text)
      const bindings = node.importClause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) ptyAliases.add(bindings.name.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (
        ts.isCallExpression(value) &&
        (isName(value.expression, 'require') ||
          value.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        value.arguments[0] &&
        isPtyModule(value.arguments[0])
      ) {
        ptyAliases.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(ast)
  function isPtyAlias(node) {
    return node && ts.isIdentifier(node) && ptyAliases.has(node.text)
  }
  function visit(node) {
    if (source.test(file) && ts.isCallExpression(node) && isProperty(node.expression, 'toString')) {
      const random = node.expression.expression
      if (
        ts.isCallExpression(random) &&
        isProperty(random.expression, 'random') &&
        isName(random.expression.expression, 'Math')
      ) {
        report(
          file,
          `line ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: Math.random().toString() is prohibited for IDs`
        )
      }
    }
    if (integration.test(file)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        /mock-node-pty/.test(node.moduleSpecifier.text)
      ) {
        report(file, `line ${line}: PTY mock helper import`)
      }
      if (ts.isCallExpression(node)) {
        const expr = node.expression
        if (
          (expr.kind === ts.SyntaxKind.ImportKeyword || isName(expr, 'require')) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          /mock-node-pty/.test(node.arguments[0].text)
        ) {
          report(file, `line ${line}: PTY mock helper import`)
        }
        if (
          ts.isPropertyAccessExpression(expr) &&
          isName(expr.expression, 'vi') &&
          ['mock', 'doMock'].includes(expr.name.text) &&
          node.arguments[0] &&
          isPtyModule(node.arguments[0])
        ) {
          report(file, `line ${line}: PTY module mock`)
        }
        if (
          ts.isPropertyAccessExpression(expr) &&
          isName(expr.expression, 'vi') &&
          expr.name.text === 'spyOn' &&
          isPtyAlias(node.arguments[0]) &&
          node.arguments[1] &&
          ts.isStringLiteralLike(node.arguments[1]) &&
          node.arguments[1].text === 'spawn'
        ) {
          report(file, `line ${line}: spawn spy/stub`)
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProperty(node.left, 'spawn') &&
        isPtyAlias(node.left.expression) &&
        ts.isCallExpression(node.right) &&
        isProperty(node.right.expression, 'fn')
      ) {
        report(file, `line ${line}: spawn stub`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
    console.error('Usage: node scripts/check-engineering.mjs [--base <git-ref>]')
    process.exit(2)
  }
  const base = args[1] ?? 'HEAD'
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    git('rev-parse', '--verify', `${base}^{commit}`)
  } catch {
    console.error(`Invalid base commit: ${base}`)
    process.exit(2)
  }
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
  const baseFiles = new Set(git('ls-tree', '-r', '--name-only', '-z', base).split('\0'))
  const errors = []
  for (const file of files) {
    if (!source.test(file) && !integration.test(file)) continue
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const previous =
      baseFiles.has(file) && source.test(file) && lines(content) > 600
        ? git('show', `${base}:${file}`)
        : baseFiles.has(file)
          ? ''
          : undefined
    errors.push(...checkFile(file, content, previous))
  }
  for (const error of errors) console.log(error)
  if (errors.length) process.exitCode = 1
  else console.log('Engineering policy checks passed.')
}
