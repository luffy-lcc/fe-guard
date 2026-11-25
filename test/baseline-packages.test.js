import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../src/config.js'
import { ownerOfFile, splitByOwner } from '../src/baseline-packages.js'

/**
 * 0.5.0 package 级 baseline：账本拆分、迁移、多账本 show/verify/trend 与 doctor。
 * 全部用临时 monorepo，不依赖本仓库自己的 baseline。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-pkg-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeFile(app, file, text) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
  writeFileSync(path.join(app, file), text)
}

function writeJson(app, file, value) {
  writeFile(app, file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(...parts) {
  return JSON.parse(readFileSync(path.join(...parts), 'utf8'))
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function git(app, args) {
  const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

function commitAll(app, message = 'snapshot') {
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', message])
}

function source(lines) {
  return Array.from({ length: lines }, (_, index) => `export const value${index} = ${index}`).join('\n')
}

function monorepo(name) {
  const app = tempDir(name)
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'pkg@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard pkg'])

  writeJson(app, 'package.json', { name: `mono-${name}`, private: true, workspaces: ['apps/*'] })
  for (const pkg of ['a', 'b']) {
    writeJson(app, `apps/${pkg}/package.json`, { name: `@mono/${pkg}`, private: true })
    writeFile(app, `apps/${pkg}/src/index.ts`, source(15))
  }
  writeJson(app, 'fe-guard.config.json', {
    baseline: { strategy: 'package', packageFile: 'fe-guard.baseline.json' },
    checks: {
      eslint: { enabled: false },
      typescript: { enabled: false },
      boundaries: { enabled: false },
      deps: { enabled: false },
      ui: { enabled: false },
      metrics: {
        enabled: true,
        roots: ['apps/a/src', 'apps/b/src'],
        extensions: ['.ts'],
        maxFileLines: 10,
        maxFunctionLines: 1000,
        maxAny: 1000,
        duplication: { windowTokens: 50, minTokens: 100000, maxRatio: 1, ignore: [] },
      },
      'diff-size': { enabled: false },
    },
  })
  return app
}

function ledgerPath(app, pkg) {
  return path.join(app, 'apps', pkg, 'fe-guard.baseline.json')
}

test('配置：baseline 默认 root / packageFile，非法 strategy / packageFile 报错', () => {
  const config = normalizeConfig({ schemaVersion: 1 }, 'test.json')
  assert.equal(config.baseline.strategy, 'root')
  assert.equal(config.baseline.packageFile, 'fe-guard.baseline.json')

  const pkgConfig = normalizeConfig({ baseline: { strategy: 'package', packageFile: 'debt.json' } }, 'test.json')
  assert.equal(pkgConfig.baseline.strategy, 'package')
  assert.equal(pkgConfig.baseline.packageFile, 'debt.json')

  assert.throws(() => normalizeConfig({ baseline: { strategy: 'workspace' } }, 'test.json'), /baseline.strategy/)
  assert.throws(() => normalizeConfig({ baseline: { packageFile: '../debt.json' } }, 'test.json'), /baseline.packageFile/)
  assert.throws(() => normalizeConfig({ baseline: { packageFile: '/tmp/debt.json' } }, 'test.json'), /baseline.packageFile/)
  assert.throws(() => normalizeConfig({ baseline: { packageFile: 'db/' } }, 'test.json'), /baseline.packageFile/)
  assert.throws(() => normalizeConfig({ baseline: { packageFile: '.' } }, 'test.json'), /baseline.packageFile/)
})

test('ownerOfFile：最长 package 前缀胜出，根文件归 root；splitByOwner 按归属拆账', () => {
  const packages = [
    { name: 'root', rel: '', isRoot: true },
    { name: 'ab', rel: 'apps/ab', isRoot: false },
    { name: 'a', rel: 'apps/a', isRoot: false },
    { name: 'deep', rel: 'apps/a/src/deep', isRoot: false },
  ]
  assert.equal(ownerOfFile('apps/ab/index.ts', packages).rel, 'apps/ab')
  assert.equal(ownerOfFile('apps/a/src/deep/x.ts', packages).rel, 'apps/a/src/deep')
  assert.equal(ownerOfFile('src/root.ts', packages).rel, '')
  assert.equal(ownerOfFile('apps/abc.ts', packages).rel, '')

  const split = splitByOwner(
    {
      'apps/a/src/index.ts::metrics/file-lines': 12,
      'apps/ab/index.ts::eslint/eqeqeq': 1,
      'src/root.ts::eslint/eqeqeq': 2,
    },
    packages,
  )
  assert.deepEqual(split.get('apps/a'), { 'apps/a/src/index.ts::metrics/file-lines': 12 })
  assert.deepEqual(split.get('apps/ab'), { 'apps/ab/index.ts::eslint/eqeqeq': 1 })
  assert.deepEqual(split.get(''), { 'src/root.ts::eslint/eqeqeq': 2 })
})

test('package 模式：两本账各自入账，check 通过；收紧 A 不影响 B，新增违规只拦 A', () => {
  const app = monorepo('flow')
  const baseline = cli(app, ['baseline'])
  assert.equal(baseline.code, 0, baseline.err)

  const aLedger = ledgerPath(app, 'a')
  const bLedger = ledgerPath(app, 'b')
  assert.ok(existsSync(aLedger), 'A 账本应生成')
  assert.ok(existsSync(bLedger), 'B 账本应生成')
  assert.equal(readJson(aLedger).ratchets['apps/a/src/index.ts']['metrics/file-lines'], 15)
  assert.equal(readJson(bLedger).ratchets['apps/b/src/index.ts']['metrics/file-lines'], 15)

  const pass = cli(app, ['check'])
  assert.equal(pass.code, 0, pass.out + pass.err)

  const bBefore = readFileSync(bLedger, 'utf8')
  writeFile(app, 'apps/a/src/index.ts', source(5))
  const tightened = cli(app, ['check'])
  assert.equal(tightened.code, 0, tightened.out + tightened.err)
  assert.match(tightened.out, /已写回 1 本 package 账本/)
  assert.deepEqual(readJson(aLedger).ratchets, {})
  assert.equal(readFileSync(bLedger, 'utf8'), bBefore, 'B 账本应逐字节不变')

  writeFile(app, 'apps/a/src/index.ts', source(25))
  const failed = cli(app, ['check'])
  assert.equal(failed.code, 1, failed.out + failed.err)
  assert.match(failed.out, /metrics\/file-lines/)
  assert.equal(readFileSync(bLedger, 'utf8'), bBefore, 'A 新增违规不应改动 B 账本')
})

test('package 模式：blocking 未 --widen 时退出 2 且不写账本，--widen 才写回', () => {
  const app = monorepo('widen')
  assert.equal(cli(app, ['baseline']).code, 0)
  const aLedger = ledgerPath(app, 'a')
  const bLedger = ledgerPath(app, 'b')
  const aBefore = readFileSync(aLedger, 'utf8')
  const bBefore = readFileSync(bLedger, 'utf8')

  writeFile(app, 'apps/a/src/index.ts', source(25))
  const blocked = cli(app, ['baseline'])
  assert.equal(blocked.code, 2)
  assert.match(blocked.err, /\[apps\/a\]/)
  assert.equal(readFileSync(aLedger, 'utf8'), aBefore, '被拒绝时不应写任何账本')
  assert.equal(readFileSync(bLedger, 'utf8'), bBefore)

  const widened = cli(app, ['baseline', '--widen'])
  assert.equal(widened.code, 0, widened.err)
  const ledger = readJson(aLedger)
  assert.equal(ledger.ratchets['apps/a/src/index.ts']['metrics/file-lines'], 25)
  assert.ok(ledger.widenLog.some((event) => event.type === 'widen'))
  assert.equal(readFileSync(bLedger, 'utf8'), bBefore, 'B 没有变化不应被重写')
})

test('package 模式：根账本仍有 package 条目时 check 拒绝并提示 --migrate-packages', () => {
  const app = monorepo('stale')
  assert.equal(cli(app, ['baseline']).code, 0)
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: {},
    ratchets: { 'apps/a/src/index.ts': { 'metrics/file-lines': 1 } },
  })

  const result = cli(app, ['check'])
  assert.equal(result.code, 2)
  assert.match(result.err, /--migrate-packages/)
  assert.match(result.err, /apps\/a\/src\/index\.ts/)
})

test('package 模式：缺少 package 账本时新增违规仍然失败', () => {
  const app = monorepo('missing-ledger')
  assert.equal(cli(app, ['baseline']).code, 0)
  rmSync(ledgerPath(app, 'a'))

  writeFile(app, 'apps/a/src/index.ts', source(25))
  const result = cli(app, ['check'])
  assert.equal(result.code, 1, result.out + result.err)
  assert.match(result.out, /metrics\/file-lines/)
})

test('--migrate-packages：dry-run 不写文件，实际迁移清空根账本并保留 firstSeen', () => {
  const app = monorepo('migrate')
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: { 'src/root.ts': { 'eslint/eqeqeq': 1 } },
    ratchets: {
      'apps/a/src/index.ts': { 'metrics/file-lines': 15 },
      'apps/b/src/index.ts': { 'metrics/file-lines': 12 },
    },
    firstSeen: {
      'src/root.ts::eslint/eqeqeq': '2026-01-01',
      'apps/a/src/index.ts::metrics/file-lines': '2026-02-02',
      'apps/b/src/index.ts::metrics/file-lines': '2026-03-03',
    },
  })
  commitAll(app, 'before migrate')
  const rootBefore = readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8')

  const dry = cli(app, ['baseline', '--migrate-packages', '--dry-run'])
  assert.equal(dry.code, 0, dry.err)
  assert.match(dry.out, /只预览/)
  assert.equal(existsSync(ledgerPath(app, 'a')), false)
  assert.equal(readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8'), rootBefore)

  const applied = cli(app, ['baseline', '--migrate-packages'])
  assert.equal(applied.code, 0, applied.err)
  assert.match(applied.out, /apps\/a\/fe-guard\.baseline\.json/)
  const root = readJson(app, 'fe-guard.baseline.json')
  assert.deepEqual(root.entries, { 'src/root.ts': { 'eslint/eqeqeq': 1 } })
  assert.deepEqual(root.ratchets, {})

  const aLedger = readJson(ledgerPath(app, 'a'))
  assert.equal(aLedger.ratchets['apps/a/src/index.ts']['metrics/file-lines'], 15)
  assert.equal(aLedger.firstSeen['apps/a/src/index.ts::metrics/file-lines'], '2026-02-02')
  assert.ok(aLedger.widenLog.some((event) => event.type === 'initial-adoption'))

  const verify = cli(app, ['baseline', '--verify', '--base', 'HEAD'])
  assert.equal(verify.code, 0, verify.out + verify.err)
})

test('--migrate-packages：冲突时退出 2 且不写任何文件', () => {
  const app = monorepo('conflict')
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: {},
    ratchets: { 'apps/a/src/index.ts': { 'metrics/file-lines': 15 } },
  })
  writeJson(app, 'apps/a/fe-guard.baseline.json', {
    version: 3,
    entries: {},
    ratchets: { 'apps/a/src/index.ts': { 'metrics/file-lines': 3 } },
  })
  const rootBefore = readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8')
  const aBefore = readFileSync(ledgerPath(app, 'a'), 'utf8')

  const result = cli(app, ['baseline', '--migrate-packages'])
  assert.equal(result.code, 2)
  assert.match(result.err, /已有同 key 不同值/)
  assert.equal(readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8'), rootBefore)
  assert.equal(readFileSync(ledgerPath(app, 'a'), 'utf8'), aBefore)
})

test('package 模式：--show 单本 / 全部、--verify --package、--trend --package 与 doctor', () => {
  const app = monorepo('read')
  assert.equal(cli(app, ['baseline']).code, 0)
  commitAll(app, 'baseline')

  const single = cli(app, ['baseline', '--show', '--package', 'apps/a', '--json'])
  assert.equal(single.code, 0, single.err)
  const singleJson = JSON.parse(single.out)
  assert.equal(singleJson.package, '@mono/a')
  assert.equal(singleJson.path, 'apps/a/fe-guard.baseline.json')
  assert.equal(singleJson.ratchets['apps/a/src/index.ts::metrics/file-lines'], 15)

  const allJson = cli(app, ['baseline', '--show', '--json'])
  assert.equal(allJson.code, 0, allJson.err)
  const all = JSON.parse(allJson.out)
  assert.equal(all.strategy, 'package')
  assert.equal(all.ledgers.length, 3)
  assert.equal(all.ledgers.find((item) => item.package === '@mono/a').exists, true)

  const text = cli(app, ['baseline', '--show'])
  assert.equal(text.code, 0, text.err)
  assert.match(text.out, /== apps\/a \(apps\/a\/fe-guard\.baseline\.json\) ==/)

  const verify = cli(app, ['baseline', '--verify', '--package', 'apps/a', '--base', 'HEAD'])
  assert.equal(verify.code, 0, verify.out + verify.err)

  const trendSingle = cli(app, ['baseline', '--trend', '--package', 'apps/a', '--json'])
  assert.equal(trendSingle.code, 0, trendSingle.err)
  const trend = JSON.parse(trendSingle.out)
  assert.equal(trend.package, '@mono/a')
  assert.equal(trend.path, 'apps/a/fe-guard.baseline.json')
  assert.equal(trend.available, true)

  const trendAll = cli(app, ['baseline', '--trend', '--json'])
  assert.equal(trendAll.code, 0, trendAll.err)
  const trends = JSON.parse(trendAll.out)
  assert.equal(trends.mode, 'package')
  assert.equal(trends.ledgers.length, 2)

  const doctor = cli(app, ['doctor'])
  assert.equal(doctor.code, 0, doctor.err)
  assert.match(doctor.out, /baseline\.strategy: package/)
  assert.match(doctor.out, /apps\/a\/fe-guard\.baseline\.json/)

  const doctorJson = cli(app, ['doctor', '--json'])
  const doctorReport = JSON.parse(doctorJson.out)
  assert.equal(doctorReport.baseline.strategy, 'package')
  const aLedger = doctorReport.baseline.ledgers.find((item) => item.package === '@mono/a')
  assert.equal(aLedger.files, 1)
  assert.equal(aLedger.entries, 0)
  assert.equal(aLedger.ratchets, 1)
  assert.ok(aLedger.lastCommit)
})

test('参数约束：--package 仅供 show/verify/trend，--dry-run 仅供迁移，迁移互斥', () => {
  const app = monorepo('args')

  const packageAlone = cli(app, ['baseline', '--package', 'a'])
  assert.equal(packageAlone.code, 2)
  assert.match(packageAlone.err, /--package 只能与/)

  const dryAlone = cli(app, ['baseline', '--dry-run'])
  assert.equal(dryAlone.code, 2)
  assert.match(dryAlone.err, /--dry-run 只能与/)

  const migrateWiden = cli(app, ['baseline', '--migrate-packages', '--widen'])
  assert.equal(migrateWiden.code, 2)
  assert.match(migrateWiden.err, /--migrate-packages 不能与/)

  const migrateShow = cli(app, ['baseline', '--migrate-packages', '--show'])
  assert.equal(migrateShow.code, 2)

  writeJson(app, 'fe-guard.config.json', {
    ...readJson(app, 'fe-guard.config.json'),
    baseline: { strategy: 'root', packageFile: 'fe-guard.baseline.json' },
  })
  const rootPackage = cli(app, ['baseline', '--show', '--package', 'a'])
  assert.equal(rootPackage.code, 2)
  assert.match(rootPackage.err, /只有一本根账本/)
})
