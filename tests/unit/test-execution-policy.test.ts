import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

test('real runner parallelizes fast tests, serializes runtime tests, and keeps packaging opt-in', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-execution-policy-'))
  try {
    for (const dir of [
      'scripts',
      'tests/setup',
      'tests/unit',
      'tests/server',
      'tests/integration',
    ]) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    for (const file of [
      'vitest.config.ts',
      'scripts/run-tests.mjs',
      'tests/setup/vitest.setup.ts',
    ]) {
      copyFileSync(resolve(file), join(root, file))
    }
    symlinkSync(
      resolve('node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    for (const [id, peer] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      writeFileSync(
        join(root, `tests/unit/${id}.test.js`),
        `
import {test,expect} from 'vitest';
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
test('parallel ${id}', async()=>{
  writeFileSync('${id}.start','');
  const deadline=Date.now()+10000;
  while(!existsSync('${peer}.start') && Date.now()<deadline) await setTimeout(10);
  expect(existsSync('${peer}.start')).toBe(true);
  writeFileSync('${id}.done','');
  writeFileSync('${id}.env.json',JSON.stringify({data:process.env.HIVE_DATA_DIR,home:process.env.HOME}));
});`
      )
    }
    for (const id of ['one', 'two']) {
      writeFileSync(
        join(root, `tests/server/${id}.test.ts`),
        `
import {test,expect} from 'vitest';
import {existsSync,openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
test('serial ${id}',async()=>{
  expect(existsSync('a.done') && existsSync('b.done')).toBe(true);
  const lock=openSync('runtime.lock','wx');
  try {await setTimeout(30);writeFileSync('${id}.done',String(process.pid));}
  finally {closeSync(lock);unlinkSync('runtime.lock');}
});`
      )
    }
    writeFileSync(
      join(root, 'tests/integration/package-tarball.test.ts'),
      "import {test,expect} from 'vitest';test('explicit packaging failure',()=>expect(1).toBe(2));"
    )
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 25_000,
      })
    const normal = run()
    expect(normal.status, normal.stdout + normal.stderr).toBe(0)
    for (const id of ['one', 'two']) expect(existsSync(join(root, `${id}.done`))).toBe(true)
    expect(readFileSync(join(root, 'one.done'), 'utf8')).not.toBe(
      readFileSync(join(root, 'two.done'), 'utf8')
    )
    const environment = JSON.parse(readFileSync(join(root, 'a.env.json'), 'utf8'))
    expect(environment.home).toBe(join(environment.data, 'home'))
    expect(existsSync(environment.data)).toBe(false)
    const explicit = run('tests/integration/package-tarball.test.ts')
    expect(explicit.status, explicit.stdout + explicit.stderr).toBe(1)
    expect(explicit.stdout + explicit.stderr).toContain('explicit packaging failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 35_000)
