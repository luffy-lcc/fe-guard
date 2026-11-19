import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadBaseline, saveBaseline } from '../src/baseline.js'
import { normalizeConfig } from '../src/config.js'
import { appendMisreport, loadMisreports, summarizeMisreports } from '../src/feedback.js'
import { detectWorkspace, eslintConfigFor, planPackages, resolveBinFrom, workspaceRoots } from '../src/workspace.js'
import { discoverManifests, installedFor } from '../src/runners/deps.js'

function tempProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-v4-'))
  writeJson(path.join(dir, 'package.json'), { name: 'root', private: true })
  return dir
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, value)
}

test('detectWorkspace：识别 package.json workspaces 并展开 apps/* 与 packages/**', () => {
  const root = tempProject()
  writeJson(path.join(root, 'package.json'), { name: 'root', private: true, workspaces: ['apps/*', 'packages/**'] })
  writeJson(path.join(root, 'apps/a/package.json'), { name: '@demo/a' })
  writeJson(path.join(root, 'apps/b/package.json'), { name: '@demo/b' })
  writeJson(path.join(root, 'packages/config/ts/package.json'), { name: '@demo/ts' })

  const workspace = detectWorkspace(root)
  assert.equal(workspace.isWorkspace, true)
  assert.equal(workspace.source, 'package.json#workspaces')
  assert.deepEqual(
    workspace.packages.map((pkg) => pkg.rel),
    ['apps/a', 'apps/b', 'packages/config/ts'],
  )
})

test('detectWorkspace：pnpm-workspace.yaml 也能识别，且跳过非 package 目录', () => {
  const root = tempProject()
  writeText(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - '!apps/ignored'\nonlyBuiltDependencies:\n  - esbuild\n")
  writeJson(path.join(root, 'apps/a/package.json'), { name: 'a' })
  mkdirSync(path.join(root, 'apps/not-a-package'), { recursive: true })

  const workspace = detectWorkspace(root)
  assert.equal(workspace.source, 'pnpm-workspace.yaml')
  assert.deepEqual(workspace.packages.map((pkg) => pkg.rel), ['apps/a'])
})

test('detectWorkspace：没有 workspace 声明时保持单仓库模式', () => {
  const root = tempProject()
  const workspace = detectWorkspace(root)
  assert.equal(workspace.isWorkspace, false)
  assert.deepEqual(workspace.packages, [])
})

test('eslintConfigFor：优先 package 自己的配置，其次继承根配置，都没有则返回 null', () => {
  const root = tempProject()
  writeJson(path.join(root, 'apps/a/package.json'), { name: 'a' })
  writeJson(path.join(root, 'apps/b/package.json'), { name: 'b' })

  assert.equal(eslintConfigFor(root, path.join(root, 'apps/a')), null)
  writeText(path.join(root, '.eslintrc.cjs'), 'module.exports = {}\n')
  assert.match(eslintConfigFor(root, path.join(root, 'apps/b')), /\.eslintrc\.cjs$/)
  writeText(path.join(root, 'apps/a/eslint.config.mjs'), 'export default []\n')
  assert.match(eslintConfigFor(root, path.join(root, 'apps/a')), /apps\/a\/eslint\.config\.mjs$/)
})

test('planPackages：workspace 自动模式逐个 package，显式 root 模式只跑根', () => {
  const workspace = {
    isWorkspace: true,
    packages: [
      { name: 'a', dir: '/repo/apps/a', rel: 'apps/a' },
      { name: 'b', dir: '/repo/apps/b', rel: 'apps/b' },
    ],
  }
  assert.deepEqual(
    planPackages('/repo', workspace, { workspace: 'auto' }).map((pkg) => pkg.rel),
    ['apps/a', 'apps/b'],
  )
  assert.deepEqual(
    planPackages('/repo', workspace, { workspace: 'root' }).map((pkg) => pkg.rel),
    [''],
  )
})

test('resolveBinFrom：从 package 目录向上找到根 node_modules/.bin', () => {
  const root = tempProject()
  writeText(path.join(root, 'node_modules/.bin/eslint'), '#!/bin/sh\n')
  const pkgDir = path.join(root, 'apps/a')
  mkdirSync(pkgDir, { recursive: true })
  assert.equal(resolveBinFrom(root, pkgDir, 'eslint'), path.join(root, 'node_modules/.bin/eslint'))
  assert.equal(resolveBinFrom(root, pkgDir, 'missing-bin'), 'missing-bin')
})

test('workspaceRoots：根级检查在 monorepo 下展开到各 package，且只执行一次', () => {
  const root = tempProject()
  writeJson(path.join(root, 'package.json'), { name: 'root', private: true, workspaces: ['apps/*'] })
  writeJson(path.join(root, 'apps/a/package.json'), { name: 'a', dependencies: { vue: '^3.0.0' } })
  mkdirSync(path.join(root, 'apps/a/src'), { recursive: true })
  const workspace = detectWorkspace(root)

  const expanded = workspaceRoots(root, { roots: ['src'] }, workspace)
  assert.deepEqual(expanded.roots, ['apps/a/src'])
  assert.deepEqual(workspaceRoots(root, { roots: ['lib'] }, workspace).roots, ['lib'])
})

test('discoverManifests：从 <pkg>/src 出发能发现 package 自己的 package.json 与根清单', () => {
  const root = tempProject()
  writeJson(path.join(root, 'package.json'), { name: 'root', private: true, dependencies: { shared: '1.0.0' } })
  writeJson(path.join(root, 'apps/a/package.json'), { name: 'a', dependencies: { echarts: '5.0.0' } })
  writeText(path.join(root, 'apps/a/src/use.ts'), 'import echarts from "echarts"\nexport default echarts\n')

  const manifests = discoverManifests(root, ['apps/a/src'])
  assert.deepEqual(manifests.map((manifest) => manifest.dir).sort(), ['', 'apps/a'])
  const deps = [...installedFor('apps/a/src/use.ts', manifests)]
  assert.ok(deps.includes('echarts'))
  assert.ok(deps.includes('shared'))
})

test('baseline：firstSeen 与 widenLog 能稳定读写，删除的条目不会留下日期', () => {
  const root = tempProject()
  const file = path.join(root, 'fe-guard.baseline.json')
  saveBaseline(
    file,
    { 'src/a.js::eslint/eqeqeq': 2 },
    {},
    {
      firstSeen: { 'src/a.js::eslint/eqeqeq': '2026-11-01', 'src/gone.js::eslint/no-unused-vars': '2026-11-01' },
      widenLog: [{ at: '2026-11-02T00:00:00.000Z', type: 'widen', items: [] }],
    },
  )

  const loaded = loadBaseline(file)
  assert.equal(loaded.firstSeen['src/a.js::eslint/eqeqeq'], '2026-11-01')
  assert.equal(loaded.firstSeen['src/gone.js::eslint/no-unused-vars'], undefined)
  assert.equal(loaded.widenLog.length, 1)

  const first = readFileSync(file, 'utf8')
  saveBaseline(file, loaded.entries, loaded.ratchets, { firstSeen: loaded.firstSeen, widenLog: loaded.widenLog })
  assert.equal(readFileSync(file, 'utf8'), first)
})

test('feedback：误报记录只追加、可汇总，坏行不会影响其余记录', () => {
  const root = tempProject()
  const file = path.join(root, '.fe-guard/false-positives.jsonl')
  appendMisreport(file, { file: 'src/a.js', line: 1, rule: 'eslint/eqeqeq', reason: '字符串表单比较' })
  appendMisreport(file, { file: 'src/b.js', rule: 'eslint/eqeqeq', reason: '同类误判' })
  appendMisreport(file, { file: 'src/c.js', rule: 'typescript/TS2322', reason: '第三方类型缺失' })
  writeFileSync(file, `${readFileSync(file, 'utf8')}{ broken json\n`)

  const records = loadMisreports(file)
  assert.equal(records.length, 3)
  const summary = summarizeMisreports(records)
  assert.equal(summary.total, 3)
  assert.deepEqual(summary.byRule[0], { name: 'eslint/eqeqeq', count: 2 })
  assert.deepEqual(summary.byCheck[0], { name: 'eslint', count: 2 })
  assert.ok(records[0].at)
})

test('normalizeConfig：workspace / vue 开关校验，非法值直接报错', () => {
  const config = normalizeConfig({ checks: { eslint: { workspace: 'root' }, typescript: { vue: false } } }, 'test')
  assert.equal(config.checks.eslint.workspace, 'root')
  assert.equal(config.checks.typescript.vue, false)
  assert.equal(config.checks.typescript.workspace, 'auto')
  assert.throws(() => normalizeConfig({ checks: { eslint: { workspace: 'per-package' } } }, 'test'), /只能/)
  assert.throws(() => normalizeConfig({ checks: { typescript: { vue: 'yes' } } }, 'test'), /vue/)
})
