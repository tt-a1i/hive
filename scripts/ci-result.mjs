// A skipped selected job is missing verification, not a successful result.
const results = JSON.parse(process.env.RESULTS ?? '{}')
const plan = results.plan
if (plan?.result !== 'success') throw new Error('The CI plan did not succeed')
const selected = (name) => {
  const value = plan.outputs?.[name]
  if (value !== 'true' && value !== 'false') throw new Error(`Missing CI plan output: ${name}`)
  return value === 'true'
}
const code = selected('code')
const tests = selected('tests')
const full = selected('full')
const native = selected('native')
const extended = selected('extended')
const legacy = selected('legacy')
if (
  (tests && !code) ||
  (legacy && !code) ||
  (full && (!tests || !native || !legacy)) ||
  (extended && !full)
) {
  throw new Error('Inconsistent CI plan')
}
const required = {
  verify: code,
  tests,
  platforms: native,
  extended,
  'legacy-sqlite': legacy,
}
for (const [name, requiredJob] of Object.entries(required)) {
  const expected = requiredJob ? 'success' : 'skipped'
  if (results[name]?.result !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${results[name]?.result ?? 'missing'}`)
  }
}
