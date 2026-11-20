import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectComponents, isStoryOrTest } from '../src/inventory.js'
import { planPackages } from '../src/workspace.js'

/**
 * 0.4.x C1（React/TSX 实机验证暴露的两个问题）：
 * - Storybook story / 测试文件不是业务组件，不参与重名与重复检测；
 * - 项目根是 git 根的子目录时，依赖账本对比必须读子目录自己的 package.json。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-react-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeFile(app, file, text) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
  writeFileSync(path.join(app, file), text)
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function git(app, args) {
  const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

test('stories / 测试文件不进入组件清单', () => {
  assert.equal(isStoryOrTest('src/Button.stories.tsx'), true)
  assert.equal(isStoryOrTest('src/Button.test.tsx'), true)
  assert.equal(isStoryOrTest('src/__tests__/Button.tsx'), true)
  assert.equal(isStoryOrTest('e2e/home.tsx'), true)
  assert.equal(isStoryOrTest('src/components/button.tsx'), false)
  assert.equal(isStoryOrTest('src/components/button/button.tsx'), false)

  const app = tempDir('inventory')
  writeFile(app, 'src/Button.tsx', 'export function Button(props: { title: string }) {\n  return null\n}\n')
  writeFile(app, 'src/Button.stories.tsx', 'export function Default() {\n  return null\n}\n')
  writeFile(app, 'src/Button.test.tsx', 'export function TestCase() {\n  return null\n}\n')
  writeFile(app, 'src/__tests__/Helper.tsx', 'export function Helper() {\n  return null\n}\n')

  const components = collectComponents(app)
  assert.deepEqual(
    components.map((component) => `${component.file}:${component.name}`),
    ['src/Button.tsx:Button'],
  )
})

test('pnpm workspace 把 "." 写进 packages 时，根包只执行一次', () => {
  const root = tempDir('root-package')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFile(root, 'package.json', '{"name":"jotai"}\n')
  mkdirSync(path.join(root, 'website'), { recursive: true })
  writeFile(root, 'website/package.json', '{"name":"jotai-website"}\n')

  const packages = planPackages(
    root,
    {
      isWorkspace: true,
      packages: [
        { name: 'jotai', dir: root, rel: '.' },
        { name: 'jotai-website', dir: path.join(root, 'website'), rel: 'website' },
      ],
    },
    {},
  )
  assert.deepEqual(
    packages.map((pkg) => `${pkg.rel}:${pkg.name}`),
    [':jotai', 'website:jotai-website'],
  )
})

test('子目录项目：依赖对比读取自己的 package.json，不误报历史依赖', () => {
  const repo = tempDir('subdir-deps')
  writeFile(repo, 'package.json', '{"name":"root","private":true}\n')
  writeFile(repo, 'apps/web/package.json', '{"name":"web","private":true,"dependencies":{"react":"^18.3.1"}}\n')
  writeFile(repo, 'apps/web/src/app.tsx', 'export function App() {\n  return null\n}\n')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'react@fe-guard.local'])
  git(repo, ['config', 'user.name', 'react'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'initial'])

  const app = path.join(repo, 'apps', 'web')
  assert.equal(cli(app, ['init']).code, 0)
  const run = cli(app, ['check', '--profile', 'fast', '--format', 'json'])
  assert.equal(run.code, 0, run.err || run.out)
  const report = JSON.parse(run.out)
  assert.deepEqual(
    report.violations.filter((violation) => violation.ruleId === 'deps/unregistered'),
    [],
    '仓库根 package.json 没有 react，不代表子目录项目新增了依赖',
  )
})
