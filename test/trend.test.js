import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 0.3.x B3：baseline 趋势只读 git 历史，不产生第二份事实源。
 * 覆盖：多版本差值、放宽计数、--limit 截断、非 git / 未入库降级、参数冲突。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-trend-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeJson(app, file, value) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
  writeFileSync(path.join(app, file), `${JSON.stringify(value, null, 2)}\n`)
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function git(app, args) {
  const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

function repo(name) {
  const app = tempDir(name)
  writeJson(app, 'package.json', { name, private: true })
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'trend@fe-guard.local'])
  git(app, ['config', 'user.name', 'trend'])
  return app
}

function commitBaseline(app, entries, extra = {}) {
  writeJson(app, 'fe-guard.baseline.json', { version: 3, entries, ratchets: {}, ...extra })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', `baseline ${new Date().toISOString()}`])
}

test('多版本趋势：差值、放宽计数、--limit 截断', () => {
  const app = repo('history')
  assert.equal(cli(app, ['init']).code, 0)
  commitBaseline(app, { 'src/a.js': { 'no-unused-vars': 2 }, 'src/b.js': { eqeqeq: 1 } })
  commitBaseline(app, { 'src/a.js': { 'no-unused-vars': 1 } })
  commitBaseline(
    app,
    { 'src/a.js': { 'no-unused-vars': 1 }, 'src/b.js': { eqeqeq: 1 } },
    {
      firstSeen: { 'src/a.js::eslint/no-unused-vars': '2026-11-01' },
      widenLog: [
        {
          at: '2026-11-20T00:00:00.000Z',
          type: 'widen',
          items: [{ file: 'src/b.js', ruleId: 'eslint/eqeqeq', kind: 'entry', from: 0, to: 1 }],
        },
      ],
    },
  )

  const run = cli(app, ['baseline', '--trend', '--json'])
  assert.equal(run.code, 0, run.err)
  const trend = JSON.parse(run.out)
  assert.equal(trend.available, true)
  assert.equal(trend.totalVersions, 3)
  assert.equal(trend.truncated, false)
  assert.deepEqual(
    trend.versions.map((version) => version.entries),
    [3, 1, 2],
  )
  assert.deepEqual(
    trend.versions.map((version) => version.delta),
    [null, -2, 1],
  )
  assert.equal(trend.versions[1].changes.removed, 1)
  assert.equal(trend.versions[1].changes.decreased, 1)
  assert.equal(trend.versions[2].changes.added, 1)
  assert.equal(trend.summary.first, 3)
  assert.equal(trend.summary.last, 2)
  assert.equal(trend.summary.delta, -1)
  assert.equal(trend.summary.widens, 1)
  assert.equal(trend.latestWidenLog[0].items[0].file, 'src/b.js')

  const text = cli(app, ['baseline', '--trend'])
  assert.equal(text.code, 0)
  assert.match(text.out, /期间放宽 1 次/)
  assert.match(text.out, /最近一次放宽/)
  assert.match(text.out, /src\/b\.js eslint\/eqeqeq 0 -> 1/)

  const limited = cli(app, ['baseline', '--trend', '--limit', '2', '--json'])
  const limitedTrend = JSON.parse(limited.out)
  assert.equal(limitedTrend.versions.length, 2)
  assert.equal(limitedTrend.truncated, true)
  assert.equal(limitedTrend.totalVersions, 3)
})

test('降级：非 git 仓库 / baseline 未入库', () => {
  const plain = tempDir('no-git')
  writeJson(plain, 'package.json', { name: 'plain', private: true })
  assert.equal(cli(plain, ['init']).code, 0)
  const noGit = cli(plain, ['baseline', '--trend', '--json'])
  assert.equal(noGit.code, 0)
  assert.deepEqual(JSON.parse(noGit.out), {
    available: false,
    reason: 'no-git',
    path: 'fe-guard.baseline.json',
  })

  const untracked = repo('not-tracked')
  git(untracked, ['add', '-A'])
  git(untracked, ['commit', '-qm', 'initial'])
  assert.equal(cli(untracked, ['init']).code, 0)
  const notTracked = cli(untracked, ['baseline', '--trend', '--json'])
  assert.equal(notTracked.code, 0)
  assert.equal(JSON.parse(notTracked.out).reason, 'not-tracked')
  assert.match(cli(untracked, ['baseline', '--trend']).out, /baseline 应该入库/)
})

test('参数校验：--trend 互斥、--limit 只能搭配 --trend', () => {
  const app = repo('args')
  assert.equal(cli(app, ['init']).code, 0)
  const conflict = cli(app, ['baseline', '--trend', '--show'])
  assert.equal(conflict.code, 2)
  assert.match(conflict.err, /--trend 只读 baseline 历史/)

  const orphan = cli(app, ['baseline', '--limit', '5'])
  assert.equal(orphan.code, 2)
  assert.match(orphan.err, /--limit 只用于 baseline --trend/)

  const invalid = cli(app, ['baseline', '--trend', '--limit', '0'])
  assert.equal(invalid.code, 2)
  assert.match(invalid.err, /--limit 需要正整数/)
})
