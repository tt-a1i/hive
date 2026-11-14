import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// A skipped selected job is missing verification, not a successful result.
export function validateResults(results) {
  const plan = results.plan
  if (plan?.result !== 'success') throw new Error('The CI plan did not succeed')
  const selected = (name) => {
    const value = plan.outputs?.[name]
    if (value !== 'true' && value !== 'false') throw new Error(`Missing CI plan output: ${name}`)
    return value === 'true'
  }
  const code = selected('code')
  const gatewayPolicy = selected('gateway_policy')
  const tests = selected('tests')
  const full = selected('full')
  const native = selected('native')
  const extended = selected('extended')
  const legacy = selected('legacy')
  if (
    (gatewayPolicy && code) ||
    (tests && !code) ||
    (legacy && !code) ||
    (full && (!tests || !native || !legacy)) ||
    (extended && !full)
  ) {
    throw new Error('Inconsistent CI plan')
  }
  const required = {
    verify: code,
    'gateway-policy': gatewayPolicy,
    tests,
    platforms: native,
    extended,
    'legacy-sqlite': legacy,
  }
  for (const [name, requiredJob] of Object.entries(required)) {
    const expected = requiredJob ? 'success' : 'skipped'
    if (results[name]?.result !== expected) {
      throw new Error(
        `${name}: expected ${expected}, received ${results[name]?.result ?? 'missing'}`
      )
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  validateResults(JSON.parse(process.env.RESULTS ?? '{}'))
}
