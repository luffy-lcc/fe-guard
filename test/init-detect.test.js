import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 0.2.x 第一项：init 智能探测。
 * init 先看项目实际有什么（tsconfig / ESLint 配置 / dependency-cruiser 配置 / .vue / workspaces），
 * 缺前置条件的检查写成 enabled:false，而不是让首次 check 直接中断。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-init-${name}-`))
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
  git(app, ['config', 'user.email', 'detect@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard detect'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'initial'])
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function readConfig(app) {
  return JSON.parse(readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8'))
}

/** 纯 JS 项目：没有 tsconfig / ESLint 配置 / depcruise 配置。 */
function plainJsApp(name) {
  const app = tempDir(name)
  writeJson(app, 'package.json', { name, private: true })
  writeFile(app, 'src/a.js', 'export const a = 1\n')
  initGit(app)
  return app
}

/** 配置齐全的项目：tsconfig + eslint + depcruise 都在。 */
function configuredApp(name) {
  const app = tempDir(name)
  writeJson(app, 'package.json', { name, private: true })
  writeFile(app, 'tsconfig.json', '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n')
  writeFile(app, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'error' } }]\n")
  writeFile(app, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  writeFile(app, 'src/a.ts', 'export const a: number = 1\n')
  initGit(app)
  return app
}

test('纯 JS 项目：init 自动关闭 typescript / eslint / boundaries，check --full 不再中断', () => {
  const app = plainJsApp('plain-js')
  const init = cli(app, ['init'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /探测结果/)
  assert.match(init.out, /已关闭 checks\.typescript/)
  assert.match(init.out, /已关闭 checks\.eslint/)
  assert.match(init.out, /已关闭 checks\.boundaries/)

  const config = readConfig(app)
  assert.equal(config.checks.typescript.enabled, false)
  assert.equal(config.checks.eslint.enabled, false)
  assert.equal(config.checks.boundaries.enabled, false)
  assert.equal(config.checks.deps.enabled, true, '内置检查不依赖外部工具，保持启用')

  const check = cli(app, ['check', '--full'])
  assert.equal(check.code, 0, `首次 check 不应中断：\n${check.out}`)
  const report = JSON.parse(readFileSync(path.join(app, '.fe-guard', 'report.json'), 'utf8'))
  assert.equal('typescript' in report.checks, false, '未启用的检查不应出现在报告里')
})

test('配置齐全：init 保持五项外部检查启用，并记录探测来源', () => {
  const app = configuredApp('configured')
  const init = cli(app, ['init'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /workspace: 单仓库/)
  assert.match(init.out, /TypeScript: 找到 tsconfig\.json/)
  assert.match(init.out, /ESLint: 找到 eslint\.config\.mjs/)
  assert.match(init.out, /架构边界: 找到 \.dependency-cruiser\.cjs/)
  assert.match(init.out, /Vue: 未检测到 \.vue 文件/)

  const config = readConfig(app)
  for (const key of ['eslint', 'typescript', 'boundaries']) {
    assert.equal(config.checks[key].enabled, true, `${key} 应保持启用`)
  }
  assert.deepEqual(config.checks.boundaries.args, ['src', '--output-type', 'json', '--config', '.dependency-cruiser.cjs'])
})

test('monorepo：根目录没有 tsconfig、子包有，typescript 仍保持启用', () => {
  const app = tempDir('monorepo')
  writeJson(app, 'package.json', { name: 'mono', private: true, workspaces: ['packages/*'] })
  writeJson(app, 'packages/a/package.json', { name: '@mono/a', private: true })
  writeJson(app, 'packages/a/tsconfig.json', { compilerOptions: { noEmit: true }, include: ['src'] })
  writeFile(app, 'packages/a/src/index.ts', 'export const a: number = 1\n')
  writeFile(app, 'eslint.config.mjs', 'export default []\n')
  writeFile(app, '.dependency-cruiser.js', 'module.exports = { forbidden: [] }\n')
  initGit(app)

  const init = cli(app, ['init'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /workspace: package\.json#workspaces，1 个 package/)
  assert.match(init.out, /TypeScript: 找到 packages\/a\/tsconfig\.json/)

  const config = readConfig(app)
  assert.equal(config.checks.typescript.enabled, true)
  assert.equal(config.checks.eslint.enabled, true, '根级 ESLint 配置被子包继承')
  assert.deepEqual(
    config.checks.boundaries.args,
    ['src', '--output-type', 'json', '--config', '.dependency-cruiser.js'],
    '应按实际存在的 depcruise 配置写 args',
  )
})

test('已存在的配置不被探测覆盖（无 --force），--force 才重新探测', () => {
  const app = plainJsApp('keep-config')
  writeJson(app, 'fe-guard.config.json', {
    schemaVersion: 1,
    enabled: true,
    checks: { typescript: { enabled: true }, eslint: { enabled: true } },
  })
  const before = readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8')

  const kept = cli(app, ['init'])
  assert.equal(kept.code, 0, kept.out)
  assert.match(kept.out, /已存在，跳过/)
  assert.equal(readFileSync(path.join(app, 'fe-guard.config.json'), 'utf8'), before)
  assert.equal(existsSync(path.join(app, 'fe-guard.baseline.json')), true)

  const forced = cli(app, ['init', '--force'])
  assert.equal(forced.code, 0, forced.out)
  assert.equal(readConfig(app).checks.typescript.enabled, false, '--force 应按探测结果重写')
})

test('Vue 项目：探测到 .vue 时提示会自动改用 vue-tsc，但不擅自关闭类型检查', () => {
  const app = tempDir('vue')
  writeJson(app, 'package.json', { name: 'vue-detect', private: true, dependencies: { vue: '^3.5.0' } })
  writeJson(app, 'tsconfig.json', { compilerOptions: { noEmit: true }, include: ['src'] })
  writeFile(app, 'eslint.config.mjs', 'export default []\n')
  writeFile(app, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  writeFile(app, 'src/App.vue', '<template><div /></template>\n')
  initGit(app)

  const init = cli(app, ['init'])
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /检测到 1 个 \.vue 文件/)
  assert.equal(readConfig(app).checks.typescript.enabled, true)
})
