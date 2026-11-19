import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCheckCore } from '../src/check-core.js'
import { loadConfig, isBaselineExempt } from '../src/config.js'
import { run } from '../src/utils.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-v5-${name}-`))
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
  const result = spawnSync(command, args, { cwd: app, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr || result.stdout}`)
  return result
}

function git(app, args) {
  return sh(app, 'git', args)
}

function initGit(app) {
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'v5@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard v5'])
}

function config(app, checks) {
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
  writeJson(app, 'fe-guard.config.json', { checks: all })
}

function cli(app, args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

// ================================================================ 第一组：--staged

test('--staged：检查暂存区内容，而不是工作区磁盘', async () => {
  const app = tempDir('staged')
  initGit(app)
  writeJson(app, 'package.json', {
    name: 'staged-fixture',
    private: true,
    dependencies: { dayjs: '^1.0.0', moment: '^2.0.0' },
  })
  writeFile(app, 'src/a.ts', "import dayjs from 'dayjs'\nexport const a = dayjs()\n")
  writeFile(app, 'src/big.ts', 'export const big = 1\n')
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])

  // 暂存一份“有问题”的版本：a.ts 用被禁的 moment，big.ts 600 行。
  writeFile(app, 'src/a.ts', "import moment from 'moment'\nexport const a = moment()\n")
  writeFile(app, 'src/big.ts', `${Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i}`).join('\n')}\n`)
  git(app, ['add', '-A'])

  // 工作区改回“没问题”的版本，但不 add：旧实现会读到这里，从而漏检。
  writeFile(app, 'src/a.ts', "import dayjs from 'dayjs'\nexport const a = dayjs()\n")
  writeFile(app, 'src/big.ts', 'export const big = 1\n')

  config(app, {
    deps: { enabled: true, roots: ['src'] },
    metrics: { enabled: true, roots: ['src'], maxFileLines: 500 },
  })

  const { report, exitCode } = await runCheckCore({ root: app, mode: 'staged', config: loadConfig(app) })
  const ids = report.violations.map((violation) => violation.ruleId)

  assert.equal(exitCode, 1)
  assert.ok(ids.includes('deps/capability-conflict'), `暂存区里的 moment 必须被抓到，实际：${ids.join(', ')}`)
  assert.ok(ids.includes('metrics/file-lines'), `暂存区里的 600 行文件必须被抓到，实际：${ids.join(', ')}`)
  assert.ok(report.violations.every((violation) => violation.file === 'src/a.ts' || violation.file === 'src/big.ts'))

  // 报告必须诚实标注哪些检查读的是暂存快照、哪些仍读工作区。
  assert.deepEqual(report.staged.contentChecks.sort(), ['deps', 'metrics'])
})

test('--staged：ESLint 实际读的是影子目录里的暂存内容', async () => {
  const app = tempDir('staged-eslint')
  initGit(app)
  writeJson(app, 'package.json', { name: 'staged-eslint', private: true })
  writeFile(app, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'error' } }]\n")
  writeFile(app, 'src/a.js', "export const a = 'OK'\n")
  // 假 ESLint：只检查传给它的文件内容里有没有 BROKEN，用来证明 runner 读的是哪份文件。
  writeFile(
    app,
    'fake-eslint.js',
    [
      '#!/usr/bin/env node',
      "const fs = require('fs')",
      "const path = require('path')",
      'const out = []',
      'for (const file of process.argv.slice(2)) {',
      "  if (fs.readFileSync(file, 'utf8').includes('BROKEN')) {",
      '    out.push({ filePath: path.resolve(file), messages: [{ ruleId: "fake", severity: 2, message: "staged broken" }] })',
      '  }',
      '}',
      'process.stdout.write(JSON.stringify(out))',
      '',
    ].join('\n'),
  )
  chmodSync(path.join(app, 'fake-eslint.js'), 0o755)
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])

  writeFile(app, 'src/a.js', "export const a = 'BROKEN'\n")
  git(app, ['add', 'src/a.js'])
  writeFile(app, 'src/a.js', "export const a = 'OK'\n") // 工作区干净，但没 add

  config(app, { eslint: { enabled: true, args: [], bin: './fake-eslint.js' } })
  const { report } = await runCheckCore({ root: app, mode: 'staged', config: loadConfig(app) })
  const ids = report.violations.map((violation) => violation.ruleId)
  assert.ok(ids.includes('eslint/fake'), ids.join(', '))
  assert.equal(report.violations.find((violation) => violation.ruleId === 'eslint/fake').file, 'src/a.js')
})

test('--staged：typescript 读取工作区，但报告里明确标注', async () => {
  const app = tempDir('staged-ts')
  initGit(app)
  writeJson(app, 'package.json', { name: 'staged-ts', private: true })
  writeFile(app, 'src/a.ts', 'export const a = 1\n')
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])
  writeFile(app, 'src/a.ts', 'export const a = 2\n')
  git(app, ['add', '-A'])

  writeFile(app, 'tsconfig.json', '{}\n')
  config(app, { deps: { enabled: true, roots: ['src'] }, typescript: { enabled: true } })

  const { report } = await runCheckCore({ root: app, mode: 'staged', config: loadConfig(app) })
  assert.ok(report.staged)
  assert.deepEqual(report.staged.contentChecks, ['deps'])
  assert.deepEqual(report.staged.workingTreeChecks, ['typescript'])
})

// ================================================================ 第二组：baseline --verify

test('baseline --verify：用 merge-base，PR 里自带放宽不能通过', () => {
  const app = tempDir('verify-base')
  initGit(app)
  config(app, { deps: { enabled: true, roots: ['src'] } })
  writeFile(app, 'src/a.ts', 'export const a = 1\n')
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: { 'src/a.ts': { 'deps/phantom': 1 } },
    ratchets: {},
    firstSeen: { 'src/a.ts::deps/phantom': '2026-01-01' },
    widenLog: [],
  })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'main: baseline'])
  git(app, ['branch', '-M', 'main'])

  // feature 分支把允许数从 1 放宽到 2，并且随提交一起带上（模拟 PR）。
  git(app, ['checkout', '-qb', 'feature'])
  writeJson(app, 'fe-guard.baseline.json', {
    version: 3,
    entries: { 'src/a.ts': { 'deps/phantom': 2 } },
    ratchets: {},
    firstSeen: { 'src/a.ts::deps/phantom': '2026-01-01' },
    widenLog: [],
  })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'feature: widen'])

  const withBase = cli(app, ['baseline', '--verify', '--base', 'main'])
  assert.equal(withBase.code, 1, `必须拦截随 PR 提交的静默放宽：${withBase.out}${withBase.err}`)
  assert.match(withBase.out, /src\/a\.ts/)
})

test('baseline --verify：无法确定基线时报错，而不是通过', () => {
  const app = tempDir('verify-nobase')
  initGit(app)
  config(app, { deps: { enabled: true, roots: ['src'] } })
  writeFile(app, 'src/a.ts', 'export const a = 1\n')
  writeJson(app, 'fe-guard.baseline.json', { version: 3, entries: {}, ratchets: {}, firstSeen: {}, widenLog: [] })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])

  const env = { ...process.env }
  delete env.GITHUB_BASE_REF
  delete env.GITHUB_BASE_SHA
  const result = spawnSync(process.execPath, [CLI, 'baseline', '--verify'], {
    cwd: app,
    encoding: 'utf8',
    env,
  })
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /无法确定比较基线/)
})

// ================================================================ 第三组：静默跳过

test('eslint：钩子模式下缺配置的 package 必须记录 skipped', async () => {
  const app = tempDir('eslint-skip')
  initGit(app)
  writeJson(app, 'package.json', { name: 'ws', private: true, workspaces: ['apps/*'] })
  writeFile(app, 'apps/a/package.json', '{"name":"a","private":true}\n')
  writeFile(app, 'apps/a/eslint.config.mjs', "export default [{ rules: { eqeqeq: 'error' } }]\n")
  writeFile(app, 'apps/a/src/a.js', 'export const a = 1\n')
  writeFile(app, 'apps/b/package.json', '{"name":"b","private":true}\n')
  writeFile(app, 'apps/b/src/b.js', 'export const b = 2\n')
  config(app, { eslint: { enabled: true } })
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'init'])

  writeFile(app, 'apps/b/src/b.js', 'export const b = 3\n')
  const { report, exitCode } = await runCheckCore({ root: app, mode: 'diff-only', config: loadConfig(app) })

  const skipped = (report.timings?.packages ?? []).filter(
    (pkg) => pkg.check === 'eslint' && pkg.status === 'skipped' && pkg.dir === 'apps/b',
  )
  assert.equal(skipped.length, 1, JSON.stringify(report.timings?.packages))
  const eslint = report.checks.find((check) => check.id === 'eslint')
  assert.equal(eslint.status, 'skipped')
  assert.equal(exitCode, 0, '跳过本身不失败，但必须可见')
})

test('diff-size：git 失败时不再静默通过', async () => {
  const app = tempDir('diff-nogit')
  writeJson(app, 'package.json', { name: 'no-git', private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  config(app, { 'diff-size': { enabled: true } })

  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
  const ids = report.violations.map((violation) => violation.ruleId)
  assert.equal(exitCode, 1)
  assert.ok(ids.includes('diff-size/not-executed'), ids.join(', '))
  assert.equal(report.checks.find((check) => check.id === 'diff-size').status, 'unavailable')
})

// ================================================================ 第四组：超时与全关

test('run：超时会终止子进程并返回 timedOut', async () => {
  const app = tempDir('timeout-run')
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    cwd: app,
    timeoutMs: 120,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, 124)
})

test('run：stdout 累积有上限，不会无限制吃内存', async () => {
  const app = tempDir('timeout-buffer')
  const result = await run(process.execPath, ['-e', "process.stdout.write('x'.repeat(200000))"], {
    cwd: app,
    maxOutput: 1000,
  })
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 1000)
})

test('eslint 超时：产出不可入账的 not-executed，退出码 1', async () => {
  const app = tempDir('eslint-timeout')
  writeJson(app, 'package.json', { name: 'slow', private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  writeFile(app, 'fake-eslint.sh', '#!/bin/sh\nsleep 5\nexit 0\n')
  chmodSync(path.join(app, 'fake-eslint.sh'), 0o755)
  config(app, { eslint: { enabled: true, targets: ['src'], bin: './fake-eslint.sh', timeoutMs: 120 } })

  const started = Date.now()
  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
  const elapsed = Date.now() - started
  const ids = report.violations.map((violation) => violation.ruleId)

  assert.equal(exitCode, 1)
  assert.ok(ids.includes('eslint/not-executed'), ids.join(', '))
  assert.ok(elapsed < 3000, `必须按 timeoutMs 截断，实际 ${elapsed}ms`)
  assert.equal(report.checks.find((check) => check.id === 'eslint').status, 'unavailable')
  assert.equal(isBaselineExempt('eslint/not-executed'), true)
})

test('0 个启用项：拒绝判定通过（退出码 2）', async () => {
  const app = tempDir('zero-checks')
  writeJson(app, 'package.json', { name: 'zero', private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  config(app, {})

  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
  assert.equal(exitCode, 2)
  assert.equal(report.ok, false)
  assert.match(report.note, /没有启用任何检查项/)
})

test('全局 enabled=false 仍是显式紧急止血（退出码 0）', async () => {
  const app = tempDir('global-off')
  writeJson(app, 'package.json', { name: 'off', private: true })
  writeJson(app, 'fe-guard.config.json', { enabled: false, checks: { eslint: { enabled: true } } })

  const { report, exitCode } = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
  assert.equal(exitCode, 0)
  assert.equal(report.skipped, true)
  assert.deepEqual(report.checks, [])
})
