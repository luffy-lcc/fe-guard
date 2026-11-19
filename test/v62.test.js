import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCheckCore } from '../src/check-core.js'
import { loadConfig } from '../src/config.js'

/**
 * v6.2 子目录根支持：项目根是 git 根的子目录（前后端同仓）时，
 * --staged 快照、diff-size、重命名迁移、--verify 的路径语义都必须相对项目根。
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
  return result.stdout.trim()
}

const lines = (count) => Array.from({ length: count }, (_, index) => `// line ${index}`).join('\n')

/** git 根含 app/（前端项目）与 other/（兄弟目录），fe-guard 根 = app。 */
function makeSubdirRepo({ checks } = {}) {
  const gitRoot = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-v62-'))
  const app = path.join(gitRoot, 'app')
  mkdirSync(path.join(app, 'src'), { recursive: true })
  mkdirSync(path.join(gitRoot, 'other'), { recursive: true })
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: {} }))
  writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(path.join(gitRoot, 'other/b.ts'), 'export const b = 2\n')
  writeFileSync(
    path.join(app, 'fe-guard.config.json'),
    JSON.stringify({
      checks: checks ?? { deps: { enabled: true }, metrics: { enabled: true }, 'diff-size': { enabled: true, maxFiles: 3, maxLines: 50 } },
    }),
  )
  git(gitRoot, ['init', '-q'])
  git(gitRoot, ['config', 'user.email', 't@t.local'])
  git(gitRoot, ['config', 'user.name', 't'])
  git(gitRoot, ['add', '-A'])
  git(gitRoot, ['commit', '-qm', 'init'])
  return { gitRoot, app }
}

test('--staged 子目录根：检查暂存内容而非工作区，路径相对项目根', async () => {
  const { gitRoot, app } = makeSubdirRepo()
  try {
    // 暂存一份违规内容（幽灵依赖 + 超行数），工作区改回干净版本但不 add
    writeFileSync(path.join(app, 'src/a.ts'), `import { x } from 'ghost-pkg'\nexport const y = x\n${lines(600)}\n`)
    git(gitRoot, ['add', '-A'])
    writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 1\n')

    const { report, exitCode } = await runCheckCore({ root: app, mode: 'staged', config: loadConfig(app) })
    assert.equal(exitCode, 1, '暂存的违规必须被查到（影子目录偏移正确）')
    const ids = report.violations.map((violation) => violation.ruleId)
    assert.ok(ids.includes('deps/phantom'), ids.join(', '))
    assert.ok(ids.includes('metrics/file-lines'), ids.join(', '))
    assert.ok(report.violations.every((violation) => !violation.file.startsWith('app/')), '路径应相对项目根')
    assert.ok(report.staged.contentChecks.includes('deps'))
  } finally {
    rmSync(gitRoot, { recursive: true, force: true })
  }
})

test('--staged 子目录根：暂存内容干净则通过', async () => {
  const { gitRoot, app } = makeSubdirRepo()
  try {
    writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 2\n')
    git(gitRoot, ['add', '-A'])
    const { exitCode } = await runCheckCore({ root: app, mode: 'staged', config: loadConfig(app) })
    assert.equal(exitCode, 0)
  } finally {
    rmSync(gitRoot, { recursive: true, force: true })
  }
})

test('diff-size 子目录根：只统计项目内改动，兄弟目录不算', async () => {
  const { gitRoot, app } = makeSubdirRepo()
  try {
    // 兄弟目录大改 + 项目内小改：不应触发大 diff
    writeFileSync(path.join(gitRoot, 'other/b.ts'), lines(200))
    writeFileSync(path.join(app, 'src/a.ts'), `export const a = 1\n${lines(10)}`)
    const small = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
    assert.equal(small.exitCode, 0, '兄弟目录的 200 行不应计入')

    // 项目内超阈值：触发
    writeFileSync(path.join(app, 'src/a.ts'), `export const a = 1\n${lines(60)}`)
    const big = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
    assert.equal(big.exitCode, 1)
    assert.ok(big.report.violations.some((violation) => violation.ruleId === 'diff-size/lines'))

    // 未跟踪文件同样只算项目内
    writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(gitRoot, 'other/new.ts'), lines(200))
    writeFileSync(path.join(app, 'src/new.ts'), lines(60))
    const untracked = await runCheckCore({ root: app, mode: 'full', config: loadConfig(app) })
    assert.equal(untracked.exitCode, 1)
    assert.ok(untracked.report.violations.some((violation) => violation.ruleId === 'diff-size/lines'))
  } finally {
    rmSync(gitRoot, { recursive: true, force: true })
  }
})

test('重命名迁移 + --verify 子目录根：账本键相对项目根，HEAD 账本可读', () => {
  const { gitRoot, app } = makeSubdirRepo({ checks: { deps: { enabled: true }, metrics: { enabled: true } } })
  try {
    writeFileSync(path.join(app, 'src/a.ts'), `import { x } from 'ghost-pkg'\nexport const y = x\n${lines(600)}\n`)
    assert.equal(cli(app, ['baseline']).code, 0)
    assert.equal(cli(app, ['check']).code, 0)
    git(gitRoot, ['add', '-A'])
    git(gitRoot, ['commit', '-qm', 'with baseline'])
    const baseSha = git(gitRoot, ['rev-parse', 'HEAD'])
    const before = JSON.parse(readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8'))
    assert.ok(before.entries['src/a.ts'], '账本键应相对项目根')
    const since = before.firstSeen['src/a.ts::deps/phantom']

    git(gitRoot, ['mv', 'app/src/a.ts', 'app/src/renamed.ts'])
    assert.equal(cli(app, ['check']).code, 1)
    const migrated = cli(app, ['baseline', '--follow-renames'])
    assert.equal(migrated.code, 0, migrated.out)
    const after = JSON.parse(readFileSync(path.join(app, 'fe-guard.baseline.json'), 'utf8'))
    assert.equal(after.entries['src/a.ts'], undefined)
    assert.ok(after.entries['src/renamed.ts']['deps/phantom'] >= 1)
    assert.equal(after.firstSeen['src/renamed.ts::deps/phantom'], since, 'HEAD 账本补回应读到子目录下的 baseline')
    assert.equal(cli(app, ['check']).code, 0)

    git(gitRoot, ['add', '-A'])
    git(gitRoot, ['commit', '-qm', 'rename + migration'])
    const verify = cli(app, ['baseline', '--verify', '--base', baseSha])
    assert.equal(verify.code, 0, verify.out)
  } finally {
    rmSync(gitRoot, { recursive: true, force: true })
  }
})

test('--diff-only 子目录根：兄弟目录改动不进入检查范围', async () => {
  const { gitRoot, app } = makeSubdirRepo()
  try {
    writeFileSync(path.join(gitRoot, 'other/b.ts'), `import { x } from 'ghost-pkg'\nexport const b = x\n`)
    const { report, exitCode } = await runCheckCore({ root: app, mode: 'diff-only', config: loadConfig(app) })
    assert.equal(exitCode, 0)
    assert.ok(report.skipped, '项目内无改动应跳过，而不是把兄弟目录的违规算进来')
  } finally {
    rmSync(gitRoot, { recursive: true, force: true })
  }
})
