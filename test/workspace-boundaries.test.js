import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findCrossPackageImports,
  packageDirsForScan,
  workspaceBoundaryConfigSource,
} from '../src/workspace-boundaries.js'

/**
 * 0.4.x C2：monorepo 跨包边界。
 * 只拦相对路径穿透到别的 package；包内引用、包名入口都不拦。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-ws-${name}-`))
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

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const PACKAGES = [
  { name: 'web', rel: 'apps/web' },
  { name: 'ui', rel: 'packages/ui' },
  { name: '(root)', rel: '' },
]

test('只拦跨 package 的相对引用，包内与包名入口放行', () => {
  const modules = [
    {
      source: 'apps/web/src/a.ts',
      dependencies: [
        { module: '../../../packages/ui/src/index', resolved: 'packages/ui/src/index.ts', dependencyTypes: ['local', 'import'] },
        { module: './b', resolved: 'apps/web/src/b.ts', dependencyTypes: ['local', 'import'] },
        { module: 'ui', resolved: 'packages/ui/src/index.ts', dependencyTypes: ['npm', 'import'] },
        { module: 'react', resolved: 'node_modules/react/index.js', dependencyTypes: ['npm', 'import'] },
      ],
    },
  ]
  const violations = findCrossPackageImports(modules, PACKAGES)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].ruleId, 'boundaries/workspace-cross-package')
  assert.equal(violations[0].file, 'apps/web/src/a.ts')
  assert.equal(violations[0].line, null)
  assert.match(violations[0].message, /web → ui/)
  assert.match(violations[0].fix, /公开入口/)
})

test('真实 depcruise 形态：resolved 相对当前文件、依赖类型 unknown 也能识别', () => {
  const modules = [
    {
      source: 'apps/web/src/cross.ts',
      dependencies: [
        { module: '../../../packages/ui/src/index', resolved: '../../../packages/ui/src/index', dependencyTypes: ['unknown'] },
      ],
    },
  ]
  const violations = findCrossPackageImports(modules, PACKAGES)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'apps/web/src/cross.ts')
  assert.match(violations[0].message, /packages\/ui\/src\/index/)
})

test('同一依赖重复出现只报一条；根包不参与跨包检查', () => {
  const modules = [
    {
      source: 'apps/web/src/a.ts',
      dependencies: [
        { module: '../../packages/ui/src/x', resolved: 'packages/ui/src/x.ts', dependencyTypes: ['local'] },
        { module: '../../packages/ui/src/x', resolved: 'packages/ui/src/x.ts', dependencyTypes: ['local'] },
      ],
    },
    {
      source: 'src/root.ts',
      dependencies: [{ module: '../packages/ui/src/x', resolved: 'packages/ui/src/x.ts', dependencyTypes: ['local'] }],
    },
  ]
  assert.equal(findCrossPackageImports(modules, PACKAGES).length, 1)
  assert.deepEqual(packageDirsForScan({ packages: PACKAGES }), ['apps/web', 'packages/ui'])
})

test('生成的 depcruise 配置不引外部文件、不覆盖用户规则', () => {
  const source = workspaceBoundaryConfigSource()
  assert.match(source, /forbidden: \[\]/)
  assert.match(source, /node_modules/)
  assert.ok(!/require\(['"][^'"]+\.cjs/.test(source), '不应引用用户的 depcruise 配置')
})

test('init 对 monorepo + depcruise 配置写入 workspace=auto；单仓库保持 off', () => {
  const mono = tempDir('init-mono')
  writeJson(mono, 'package.json', { name: 'mono', private: true, workspaces: ['packages/*'] })
  writeJson(mono, 'packages/ui/package.json', { name: 'ui', private: true })
  writeJson(mono, 'packages/ui/src/index.ts', 'export const ui = 1\n')
  writeFile(mono, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  assert.equal(cli(mono, ['init']).code, 0)
  const monoConfig = JSON.parse(readFileSync(path.join(mono, 'fe-guard.config.json'), 'utf8'))
  assert.equal(monoConfig.checks.boundaries.workspace, 'auto')
  assert.equal(monoConfig.checks.boundaries.enabled, true)

  const single = tempDir('init-single')
  writeJson(single, 'package.json', { name: 'single', private: true })
  writeFile(single, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] }\n')
  assert.equal(cli(single, ['init']).code, 0)
  const singleConfig = JSON.parse(readFileSync(path.join(single, 'fe-guard.config.json'), 'utf8'))
  assert.equal(singleConfig.checks.boundaries.workspace, 'off')
})

test('非法 workspace 取值直接报配置错误', () => {
  const app = tempDir('bad-mode')
  writeJson(app, 'package.json', { name: 'bad', private: true })
  writeJson(app, 'fe-guard.config.json', {
    schemaVersion: 1,
    enabled: true,
    checks: { boundaries: { enabled: true, workspace: 'sometimes' } },
  })
  const run = cli(app, ['check'])
  assert.equal(run.code, 2)
  assert.match(run.err, /checks\.boundaries\.workspace 只能是 off 或 auto/)
})
