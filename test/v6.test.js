import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCheckCore } from '../src/check-core.js'
import { loadConfig } from '../src/config.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-v6-${name}-`))
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

function sh(app, command, args) {
  return spawnSync(command, args, { cwd: app, encoding: 'utf8' })
}

function git(app, args) {
  const result = sh(app, 'git', args)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function initGit(app) {
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'v6@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard v6'])
}

function config(app, checks, extra = {}) {
  const all = {
    eslint: { enabled: false },
    typescript: { enabled: false },
    boundaries: { enabled: false },
    deps: { enabled: false },
    ui: { enabled: false },
    metrics: { enabled: false },
    'diff-size': { enabled: false },
    ...checks,
  }
  writeJson(app, 'fe-guard.config.json', { ...extra, checks: all })
}

function cli(app, args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function profileApp(name) {
  const app = tempDir(name)
  initGit(app)
  writeJson(app, 'package.json', { name, private: true })
  writeFile(app, 'tsconfig.json', '{ "compilerOptions": { "noEmit": true } }\n')
  writeFile(app, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'error' } }]\n")
  writeFile(app, 'src/a.ts', 'export const a = 1\n')
  writeFile(app, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  // 三个假工具：一旦被调用就写 marker，用来证明“没跑”而不是“跑完再过滤”。
  writeFile(app, 'fake-eslint.js', '#!/usr/bin/env node\nprocess.stdout.write("[]")\n')
  writeFile(app, 'fake-tsc.js', '#!/usr/bin/env node\nrequire("fs").writeFileSync("tsc-ran.marker", "1")\n')
  writeFile(app, 'fake-depcruise.js', '#!/usr/bin/env node\nrequire("fs").writeFileSync("depcruise-ran.marker", "1")\nprocess.stdout.write("[]")\n')
  for (const file of ['fake-eslint.js', 'fake-tsc.js', 'fake-depcruise.js']) chmodSync(path.join(app, file), 0o755)
  config(app, {
    eslint: { enabled: true, args: [], bin: './fake-eslint.js' },
    typescript: { enabled: true, bin: './fake-tsc.js' },
    boundaries: { enabled: true, bin: './fake-depcruise.js', args: [] },
    deps: { enabled: true, roots: ['src'] },
    ui: { enabled: true, roots: ['src'] },
    metrics: { enabled: true, roots: ['src'] },
    'diff-size': { enabled: true },
  })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])
  return app
}

// ============================================================ 一、档位

test('fast 档：只跑四项，且证明 tsc / depcruise 没有被调用', async () => {
  const app = profileApp('fast')
  const started = Date.now()
  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app), profile: 'fast' })
  const elapsed = Date.now() - started

  assert.equal(exitCode, 0)
  assert.equal(report.profile.name, 'fast')
  assert.deepEqual(
    [...report.profile.skipped].sort(),
    ['boundaries', 'diff-size', 'typescript'],
  )
  assert.deepEqual(
    report.checks.map((check) => check.id).sort(),
    ['deps', 'eslint', 'metrics', 'ui'],
  )
  assert.equal(existsSync(path.join(app, 'tsc-ran.marker')), false, 'fast 档不能调用 tsc')
  assert.equal(existsSync(path.join(app, 'depcruise-ran.marker')), false, 'fast 档不能调用 depcruise')
  assert.ok(elapsed < 3000, `fast 档目标 3 秒内，实际 ${elapsed}ms`)
})

test('full 档：tsc / depcruise 真的执行，且不再标记为跳过', async () => {
  const app = profileApp('full')
  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app), profile: 'full' })
  assert.equal(exitCode, 0)
  assert.equal(report.profile.name, 'full')
  assert.deepEqual(report.profile.skipped, [])
  assert.equal(existsSync(path.join(app, 'tsc-ran.marker')), true)
  assert.equal(existsSync(path.join(app, 'depcruise-ran.marker')), true)
  assert.ok(report.checks.some((check) => check.id === 'typescript'))
})

test('--config / FE_GUARD_CONFIG 覆盖默认配置文件', async () => {
  const app = tempDir('config-path')
  writeJson(app, 'package.json', { name: 'cfg', private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  config(app, {}) // 默认配置：全关 -> 退出码 2
  const alt = path.join(app, 'alt.config.json')
  writeJson(app, 'alt.config.json', { checks: { deps: { enabled: true, roots: ['src'] } } })

  const base = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
  assert.equal(base.exitCode, 2, '默认配置全关时必须退出码 2')

  const viaPath = await runCheckCore({ root: app, mode: 'full', configPath: alt })
  assert.equal(viaPath.exitCode, 0)

  const previous = process.env.FE_GUARD_CONFIG
  process.env.FE_GUARD_CONFIG = alt
  try {
    const viaEnv = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
    assert.equal(viaEnv.exitCode, 0)
  } finally {
    if (previous === undefined) delete process.env.FE_GUARD_CONFIG
    else process.env.FE_GUARD_CONFIG = previous
  }
})

test('--help / --version：参数与子命令参数都写全了', () => {
  const help = cli(ROOT, ['--help'])
  assert.equal(help.code, 0)
  for (const token of ['--config', '--profile', '--full', '--by-rule', '--suggest', '--base', 'doctor', '--all', '--json']) {
    assert.ok(help.out.includes(token), `帮助里缺少 ${token}`)
  }
  const version = cli(ROOT, ['--version'])
  assert.equal(version.out.trim(), VERSION)
})

// ============================================================ 二、doctor

test('doctor：输出档位、覆盖、跳过与 baseline 规模（真实运行）', () => {
  const app = profileApp('doctor')
  const result = cli(app, ['doctor', '--profile', 'fast'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /fe-guard doctor\s+\(profile: fast\)/)
  assert.match(result.out, /档位跳过/)
  assert.match(result.out, /baseline:/)
  assert.match(result.out, /TypeScript/)
})

test('doctor --json：空检查与 profile 跳过可被脚本消费', () => {
  const app = profileApp('doctor-json')
  const result = cli(app, ['doctor', '--profile', 'fast', '--json'])
  assert.equal(result.code, 0, result.err)
  const report = JSON.parse(result.out)
  assert.equal(report.profile.name, 'fast')
  assert.deepEqual([...report.profile.skipped].sort(), ['boundaries', 'diff-size', 'typescript'])
  const eslint = report.checks.find((check) => check.id === 'eslint')
  assert.equal(eslint.status, 'covered')
  assert.equal(eslint.covered, 1)
  assert.ok(Array.isArray(report.emptyChecks))
})

// ============================================================ 三、清单

test('baseline --show --by-rule：按可清理条数排序', () => {
  const app = tempDir('by-rule')
  writeJson(app, 'package.json', { name: 'rules', private: true })
  config(app, { deps: { enabled: true, roots: ['src'] } })
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: {
      'src/a.js': { 'eslint/eqeqeq': 10 },
      'src/b.js': { 'eslint/eqeqeq': 9 },
      'src/c.js': { 'eslint/eqeqeq': 8 },
      'src/d.js': { 'ui/duplicate-component': 2 },
    },
    ratchets: { 'src/e.js': { 'metrics/duplicate-block': 80 } },
    firstSeen: { 'src/a.js::eslint/eqeqeq': '2026-01-01' },
    widenLog: [],
  })

  const result = cli(app, ['baseline', '--show', '--by-rule'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /eslint\/eqeqeq\s+27 条/)
  assert.match(result.out, /先修 eslint\/eqeqeq/)
  assert.ok(result.out.indexOf('eslint/eqeqeq') < result.out.indexOf('ui/duplicate-component'))
})

test('false-positive --suggest：给出规则级降级/关闭建议', () => {
  const app = tempDir('suggest')
  writeJson(app, 'package.json', { name: 'fp', private: true })
  config(app, { deps: { enabled: true, roots: ['src'] } })
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: { 'src/a.js': { 'eslint/no-magic-number': 3 } },
    ratchets: {},
    firstSeen: {},
    widenLog: [],
  })

  for (const line of [1, 2]) {
    const added = cli(app, [
      'false-positive',
      '--file',
      'src/a.js',
      '--line',
      String(line),
      '--rule',
      'eslint/no-magic-number',
      '--reason',
      '这是协议常量，不是魔法数字',
    ])
    assert.equal(added.code, 0, added.err)
  }

  const result = cli(app, ['false-positive', '--suggest'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /eslint\/no-magic-number/)
  assert.match(result.out, /建议/)
  assert.match(result.out, /仍需|不会自动改配置/)
})

// ============================================================ 四、分发与版本

test('npm pack：tarball 含 bin/src/README，且能在空项目里安装运行', { timeout: 120000 }, () => {
  const dry = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  const packed = JSON.parse(dry.stdout)[0]
  const files = packed.files.map((file) => file.path)
  for (const expected of ['bin/fe-guard.js', 'src/cli.js', 'README.md']) {
    assert.ok(files.includes(expected), `tarball 缺少 ${expected}`)
  }
  assert.ok(!files.some((file) => file.startsWith('test/')), 'tarball 不应包含测试')

  const dest = tempDir('pack')
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(pack.status, 0, pack.stderr)
  const tgz = path.join(dest, JSON.parse(pack.stdout)[0].filename)

  const consumer = tempDir('consumer')
  writeJson(consumer, 'package.json', { name: 'consumer', private: true })
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '-D', tgz], {
    cwd: consumer,
    encoding: 'utf8',
  })
  assert.equal(install.status, 0, install.stderr)
  const bin = path.join(consumer, 'node_modules', '.bin', 'fe-guard')
  const version = spawnSync(bin, ['--version'], { cwd: consumer, encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), VERSION)
})

test('schema 不兼容：baseline / 配置都明确报错，不静默重播种', () => {
  const app = tempDir('schema')
  writeJson(app, 'package.json', { name: 'schema', private: true })
  config(app, { deps: { enabled: true, roots: ['src'] } })
  writeJson(app, 'fe-guard.baseline.json', { version: 99, entries: {}, ratchets: {}, firstSeen: {}, widenLog: [] })

  const baseline = cli(app, ['baseline', '--show'])
  assert.equal(baseline.code, 2)
  assert.match(baseline.err, /schema version=99/)

  writeJson(app, 'fe-guard.baseline.json', { version: 3, entries: {}, ratchets: {}, firstSeen: {}, widenLog: [] })
  writeJson(app, 'fe-guard.config.json', { schemaVersion: 99, checks: { deps: { enabled: true } } })
  const check = cli(app, ['check'])
  assert.equal(check.code, 2)
  assert.match(check.err, /schemaVersion=99/)
})
