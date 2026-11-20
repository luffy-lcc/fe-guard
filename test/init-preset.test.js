import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 0.2.x 第二项：init 的配置预设（js / vue / legacy / monorepo）与 --dry-run。
 * 顺序约定：默认配置 → 预设（定基调）→ 探测（只做缺前置条件的降级）。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-preset-${name}-`))
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

function initGit(app) {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'preset@fe-guard.local'],
    ['config', 'user.name', 'fe-guard preset'],
    ['add', '-A'],
    ['commit', '-qm', 'initial'],
  ]) {
    const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function readConfig(app) {
  return JSON.parse(readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8'))
}

/** 配置齐全的 TS 项目：三件套都在。 */
function configuredTsApp(name) {
  const app = tempDir(name)
  writeJson(app, 'package.json', { name, private: true })
  writeFile(app, 'tsconfig.json', '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n')
  writeFile(app, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'error' } }]\n")
  writeFile(app, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  writeFile(app, 'src/a.ts', 'export const a: number = 1\n')
  initGit(app)
  return app
}

test('--preset legacy：放宽指标与大 diff 阈值，探测仍只做降级', () => {
  const app = configuredTsApp('legacy')
  const init = cli(app, ['init', '--preset', 'legacy'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /预设: legacy/)

  const config = readConfig(app)
  assert.equal(config.checks.metrics.maxFileLines, 800)
  assert.equal(config.checks.metrics.maxFunctionLines, 150)
  assert.equal(config.checks.metrics.maxAny, 50)
  assert.equal(config.checks.metrics.duplication.maxRatio, 0.6)
  assert.equal(config.checks.metrics.duplication.windowTokens, 50, '未覆盖的字段保持默认')
  assert.equal(config.checks['diff-size'].maxFiles, 40)
  assert.equal(config.checks['diff-size'].maxLines, 1200)
  assert.equal(config.checks.typescript.enabled, true)
})

test('--preset legacy 在缺 ESLint 配置的项目里，探测把 eslint 关掉但保留放宽的阈值', () => {
  const app = tempDir('legacy-downgrade')
  writeJson(app, 'package.json', { name: 'legacy-js', private: true })
  writeFile(app, 'tsconfig.json', '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }\n')
  writeFile(app, 'src/a.ts', 'export const a = 1\n')
  initGit(app)

  const init = cli(app, ['init', '--preset', 'legacy'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /已关闭 checks\.eslint/)
  assert.match(init.out, /已关闭 checks\.boundaries/)

  const config = readConfig(app)
  assert.equal(config.checks.eslint.enabled, false)
  assert.equal(config.checks.metrics.maxFileLines, 800, '探测不改预设阈值')
})

test('--preset js：即使有 tsconfig 也关闭 typescript / ui，并提示预设来源', () => {
  const app = configuredTsApp('js')
  const init = cli(app, ['init', '--preset', 'js'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /已关闭 checks\.typescript — 预设 js/)
  assert.match(init.out, /已关闭 checks\.ui — 预设 js/)

  const config = readConfig(app)
  assert.equal(config.checks.typescript.enabled, false)
  assert.equal(config.checks.ui.enabled, false)
})

test('--preset js 遇到 Vue 项目：保持预设，但提示可能选错', () => {
  const app = tempDir('js-vue-mismatch')
  writeJson(app, 'package.json', { name: 'js-vue', private: true, dependencies: { vue: '^3.5.0' } })
  writeFile(app, 'src/App.vue', '<template><div /></template>\n')
  initGit(app)

  const init = cli(app, ['init', '--preset', 'js'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /检测到 1 个 \.vue 文件/)
  assert.match(init.out, /建议改用 --preset vue/)
})

test('--preset vue：显式写出 vue-tsc 自动切换；没有 .vue 时给出提示', () => {
  const vueApp = tempDir('vue-preset')
  writeJson(vueApp, 'package.json', { name: 'vue-preset', private: true, dependencies: { vue: '^3.5.0' } })
  writeFile(vueApp, 'tsconfig.json', '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }\n')
  writeFile(vueApp, 'src/App.vue', '<template><div /></template>\n')
  initGit(vueApp)
  assert.equal(cli(vueApp, ['init', '--preset', 'vue']).code, 0)
  const config = readConfig(vueApp)
  assert.equal(config.checks.typescript.vue, 'auto')
  assert.equal(config.checks.typescript.enabled, true)

  const jsApp = configuredTsApp('vue-preset-js')
  const jsInit = cli(jsApp, ['init', '--preset', 'vue'])
  assert.equal(jsInit.code, 0, jsInit.out)
  assert.match(jsInit.out, /未检测到 \.vue 文件/)
  assert.match(jsInit.out, /可以改用 --preset js/)
})

test('--preset monorepo：workspace 按包执行 + 放宽大 diff 阈值', () => {
  const app = tempDir('monorepo-preset')
  writeJson(app, 'package.json', { name: 'mono', private: true, workspaces: ['packages/*'] })
  writeJson(app, 'packages/a/package.json', { name: '@mono/a', private: true })
  writeJson(app, 'packages/a/tsconfig.json', { compilerOptions: { noEmit: true }, include: ['src'] })
  writeFile(app, 'packages/a/src/index.ts', 'export const a: number = 1\n')
  writeFile(app, 'eslint.config.mjs', 'export default []\n')
  initGit(app)

  const init = cli(app, ['init', '--preset', 'monorepo'])
  assert.equal(init.code, 0, init.out)
  const config = readConfig(app)
  assert.equal(config.checks.eslint.workspace, 'auto')
  assert.equal(config.checks.typescript.workspace, 'auto')
  assert.equal(config.checks['diff-size'].maxFiles, 40)
  assert.equal(config.checks['diff-size'].maxLines, 1000)
  assert.equal(config.checks.boundaries.enabled, false, '没有 depcruise 配置时仍由探测降级')
})

test('未知预设：退出码 2 并列出可选值', () => {
  const app = tempDir('bad-preset')
  writeJson(app, 'package.json', { name: 'bad', private: true })
  const init = cli(app, ['init', '--preset', 'react'])
  assert.equal(init.code, 2)
  assert.match(init.out, /未知预设 "react"/)
  assert.match(init.out, /js \/ vue \/ legacy \/ monorepo/)
  assert.equal(existsSync(path.join(app, 'fe-guard.config.json')), false, '参数错误不应留下半成品')
})

test('--dry-run：只打印将写入的文件与内容，一个文件都不落盘', () => {
  const app = tempDir('dry-run')
  writeJson(app, 'package.json', { name: 'dry', private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  initGit(app)

  const preview = cli(app, ['init', '--dry-run', '--preset', 'legacy'])
  assert.equal(preview.code, 0, preview.out)
  assert.match(preview.out, /fe-guard init 预览（--dry-run，不写入任何文件）/)
  assert.match(preview.out, /将写入:/)
  assert.match(preview.out, /内容预览:/)
  assert.match(preview.out, /--- fe-guard\.config\.json \(created\) ---/)
  assert.match(preview.out, /"maxFileLines": 800/, '预览里能看到预设效果')
  assert.match(preview.out, /去掉 --dry-run 才会写入文件/)

  for (const file of ['fe-guard.config.json', 'fe-guard.baseline.json', 'AGENTS.md', '.trae/mcp.json', '.cursor/mcp.json']) {
    assert.equal(existsSync(path.join(app, file)), false, `--dry-run 不应写 ${file}`)
  }

  assert.equal(cli(app, ['init', '--preset', 'legacy']).code, 0, '预览后仍可正常写入')
  assert.equal(readConfig(app).checks.metrics.maxFileLines, 800)
})

test('--dry-run --force：显示将更新，但磁盘上的配置保持原样', () => {
  const app = configuredTsApp('dry-run-force')
  writeJson(app, 'fe-guard.config.json', { checks: { typescript: { enabled: true } } })
  const before = readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8')

  const preview = cli(app, ['init', '--dry-run', '--force', '--preset', 'legacy'])
  assert.equal(preview.code, 0, preview.out)
  assert.match(preview.out, /将更新:/)
  assert.match(preview.out, /--- fe-guard\.config\.json \(updated\) ---/)
  assert.equal(readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8'), before)
})

test('配置已存在时 --preset 不生效，并明确提示需要 --force', () => {
  const app = configuredTsApp('preset-kept')
  writeJson(app, 'fe-guard.config.json', { checks: { typescript: { enabled: true } } })
  const init = cli(app, ['init', '--preset', 'legacy'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /--preset legacy 没有应用/)
  assert.equal(readConfig(app).checks.metrics, undefined, '不应悄悄改动已有配置')
})
