import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultChecks } from '../src/config.js'

/**
 * v6.3 Vue 类型门禁修复：
 * 1. init 默认配置不再写死 typescript.bin，Vue 项目必须真的自动切到 vue-tsc（此前会静默漏检 .vue）；
 * 2. Vue + TypeScript 7 直接给出明确报错，而不是 vue-tsc 崩溃后报“检查未执行”；
 * 3. 显式指定非 vue-tsc 的 bin 时，必须提示 .vue 不会被检查。
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO_ROOT, 'bin', 'fe-guard.js')

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function reportOf(app) {
  return JSON.parse(readFileSync(path.join(app, '.fe-guard', 'report.json'), 'utf8'))
}

/**
 * Vue 工程：src/main.ts 合法、src/Bad.vue 有真实类型错误。
 * linkRealDeps=true 时软链仓库 node_modules（真实 vue-tsc / typescript），否则写假版本元数据。
 */
function makeVueProject({ linkRealDeps = false, tsVersion = '5.9.3', vueTscVersion = '3.3.14' } = {}) {
  const app = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-v63-'))
  mkdirSync(path.join(app, 'src'), { recursive: true })
  writeJson(path.join(app, 'package.json'), {
    name: 'vue-v63',
    private: true,
    dependencies: { vue: '^3.5.0' },
  })
  writeJson(path.join(app, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      jsx: 'preserve',
      skipLibCheck: true,
    },
    include: ['src/**/*.ts', 'src/**/*.vue'],
  })
  writeFileSync(path.join(app, 'src/main.ts'), 'export const ok: number = 1\n')
  writeFileSync(
    path.join(app, 'src/Bad.vue'),
    '<script setup lang="ts">\nconst n: number = "definitely not a number"\n</script>\n<template><div>{{ n }}</div></template>\n',
  )

  if (linkRealDeps) {
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  } else {
    writeJson(path.join(app, 'node_modules/typescript/package.json'), { name: 'typescript', version: tsVersion })
    writeJson(path.join(app, 'node_modules/vue-tsc/package.json'), { name: 'vue-tsc', version: vueTscVersion })
  }

  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'v63@fe-guard.local'])
  git(app, ['config', 'user.name', 'v63'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'v63: initial'])
  return app
}

function cleanup(app) {
  rmSync(app, { recursive: true, force: true })
}

test('默认配置不写死 typescript.bin，保留 Vue 自动切换', () => {
  assert.equal(defaultChecks().typescript.bin, undefined)
})

test('init 生成的配置里没有 typescript.bin 字段', () => {
  const app = makeVueProject()
  try {
    assert.equal(cli(app, ['init']).code, 0)
    const config = JSON.parse(readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8'))
    assert.equal('bin' in config.checks.typescript, false, '默认配置不应包含 bin')
  } finally {
    cleanup(app)
  }
})

test('init 默认配置下，Vue 项目真的用 vue-tsc 抓到 .vue 类型错误（防假通过）', () => {
  const app = makeVueProject({ linkRealDeps: true })
  try {
    const init = cli(app, ['init'])
    assert.equal(init.code, 0, init.out)
    const result = cli(app, ['check', '--full'])
    assert.equal(result.code, 1, `应因 .vue 类型错误失败：\n${result.out}`)
    const vueViolations = reportOf(app).violations.filter(
      (violation) => violation.file === 'src/Bad.vue' && violation.ruleId === 'typescript/TS2322',
    )
    assert.ok(vueViolations.length >= 1, `报告里应包含 src/Bad.vue 的 TS2322：${JSON.stringify(reportOf(app).violations)}`)
  } finally {
    cleanup(app)
  }
})

test('Vue + TypeScript 7：给出明确不支持提示，而不是崩溃后的“检查未执行”', () => {
  const app = makeVueProject({ tsVersion: '7.0.2', vueTscVersion: '3.3.14' })
  try {
    assert.equal(cli(app, ['init']).code, 0)
    const result = cli(app, ['check', '--full'])
    assert.equal(result.code, 2, `应作为配置/环境错误退出：\n${result.out}`)
    assert.match(result.out, /TypeScript 7/)
    assert.match(result.out, /typescript@5/)
  } finally {
    cleanup(app)
  }
})

test('显式 bin 指定非 vue-tsc 时提示 .vue 不会被检查', () => {
  const app = makeVueProject({ linkRealDeps: true })
  try {
    assert.equal(cli(app, ['init']).code, 0)
    const configFile = path.join(app, 'fe-guard.config.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    config.checks.typescript.bin = 'tsc'
    writeJson(configFile, config)
    const result = cli(app, ['check', '--full'])
    assert.match(result.out, /不会被类型检查/)
    assert.match(result.out, /删掉该字段/)
  } finally {
    cleanup(app)
  }
})
