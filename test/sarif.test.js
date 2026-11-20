import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSarif, SARIF_SCHEMA } from '../src/sarif.js'

/**
 * 0.3.x B1：check --format sarif。
 * 只包含「新增违规 + 检查未执行」；boundaries 无行号时保持文件级；--json 行为不变。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-sarif-${name}-`))
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

function report(violations, { checks = [{ id: 'eslint', label: 'ESLint', status: 'ran' }], exitCode = 1 } = {}) {
  return { exitCode, checks, violations }
}

test('最小字段集：schema、driver、level、ruleIndex、行号', () => {
  const sarif = buildSarif(
    report([
      { ruleId: 'eslint/no-unused-vars', file: 'src/a.ts', line: 3, severity: 'error', status: 'new', message: 'unused' },
      { ruleId: 'boundaries/no-cycles', file: 'src/b.ts', line: null, severity: 'warn', status: 'new', message: 'cycle' },
    ]),
    { version: '9.9.9' },
  )

  assert.equal(sarif.$schema, SARIF_SCHEMA)
  assert.equal(sarif.version, '2.1.0')
  const run = sarif.runs[0]
  assert.equal(run.tool.driver.name, 'fe-guard')
  assert.equal(run.tool.driver.version, '9.9.9')
  assert.equal(run.invocations[0].executionSuccessful, true)
  assert.equal(run.invocations[0].exitCode, 1)

  const [first, second] = run.results
  assert.equal(first.level, 'error')
  assert.equal(first.message.text, 'unused')
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, 'src/a.ts')
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uriBaseId, '%SRCROOT%')
  assert.equal(first.locations[0].physicalLocation.region.startLine, 3)

  assert.equal(second.level, 'warning')
  assert.equal(second.locations[0].physicalLocation.region, undefined, '没有行号时不伪造 region')

  assert.deepEqual(
    run.tool.driver.rules.map((rule) => rule.id),
    ['boundaries/no-cycles', 'eslint/no-unused-vars'],
    'rules 去重并按 id 排序',
  )
  assert.equal(run.tool.driver.rules[first.ruleIndex].id, first.ruleId)
})

test('存量违规不输出，仅新增与“检查未执行”进入 SARIF', () => {
  const sarif = buildSarif(
    report([
      { ruleId: 'eslint/no-unused-vars', file: 'src/a.ts', line: 1, severity: 'error', status: 'known', message: 'legacy' },
      { ruleId: 'eslint/eqeqeq', file: 'src/b.ts', line: 2, severity: 'error', status: 'new', message: 'new' },
    ]),
  )
  assert.deepEqual(
    sarif.runs[0].results.map((result) => result.ruleId),
    ['eslint/eqeqeq'],
  )
})

test('检查未执行：无位置结果 + executionSuccessful=false + 通知', () => {
  const sarif = buildSarif(
    report(
      [
        {
          ruleId: 'typescript/not-executed',
          file: '(check)',
          line: null,
          severity: 'error',
          status: 'new',
          message: '找不到 tsc',
        },
      ],
      { checks: [{ id: 'typescript', label: '类型检查', status: 'unavailable' }], exitCode: 1 },
    ),
  )

  const run = sarif.runs[0]
  assert.equal(run.invocations[0].executionSuccessful, false)
  assert.equal(run.results[0].ruleId, 'typescript/not-executed')
  assert.equal(run.results[0].level, 'error')
  assert.equal(run.results[0].locations, undefined, '伪路径不带位置')
  assert.equal(run.invocations[0].toolExecutionNotifications[0].level, 'error')
  assert.equal(run.invocations[0].toolExecutionNotifications[0].message.text, '找不到 tsc')
  assert.equal(run.invocations[0].toolExecutionNotifications[0].descriptor.id, 'typescript/not-executed')
})

test('子目录前缀与 URI 编码', () => {
  const sarif = buildSarif(
    report([{ ruleId: 'eslint/x', file: 'src/my file#1.js', line: 1, severity: 'error', status: 'new', message: 'm' }]),
    { pathPrefix: 'frontend/' },
  )
  assert.equal(
    sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    'frontend/src/my%20file%231.js',
  )
})

test('真实 tsc：SARIF 可解析、带行号；--json 行为不变；入账后结果为空', () => {
  const app = tempDir('e2e')
  writeJson(app, 'package.json', { name: 'sarif-e2e', private: true })
  writeJson(app, 'tsconfig.json', { compilerOptions: { strict: true, noEmit: true }, include: ['src'] })
  writeFile(app, 'src/a.ts', 'export const bad: number = "text"\n')
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'sarif@fe-guard.local'],
    ['config', 'user.name', 'sarif'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  }
  assert.equal(cli(app, ['init']).code, 0)

  const sarifRun = cli(app, ['check', '--profile', 'full', '--format', 'sarif'])
  assert.equal(sarifRun.code, 1, sarifRun.err || sarifRun.out)
  const sarif = JSON.parse(sarifRun.out)
  assert.equal(sarif.runs[0].tool.driver.name, 'fe-guard')
  const typeError = sarif.runs[0].results.find((result) => result.ruleId === 'typescript/TS2322')
  assert.ok(typeError, `应包含 TS2322：${sarifRun.out}`)
  assert.equal(typeError.locations[0].physicalLocation.artifactLocation.uri, 'src/a.ts')
  assert.equal(typeError.locations[0].physicalLocation.region.startLine, 1)

  // --json 仍是原来的报告对象，且与落盘的 report.json 一致。
  const jsonRun = cli(app, ['check', '--profile', 'full', '--json'])
  assert.equal(jsonRun.code, 1)
  const parsed = JSON.parse(jsonRun.out)
  assert.equal(parsed.schemaVersion, 2)
  const fileReport = JSON.parse(readFileSync(path.join(app, '.fe-guard', 'report.json'), 'utf8'))
  assert.deepEqual(parsed, fileReport)

  // baseline 入账后，没有新增：SARIF 结果为空且退出码 0。
  assert.equal(cli(app, ['baseline']).code, 0)
  const clean = cli(app, ['check', '--profile', 'full', '--format', 'sarif'])
  assert.equal(clean.code, 0, clean.err || clean.out)
  assert.deepEqual(JSON.parse(clean.out).runs[0].results, [])
})

test('参数校验：未知 format、--json 与其它 format 冲突', () => {
  const app = tempDir('args')
  writeJson(app, 'package.json', { name: 'args', private: true })
  const unknown = cli(app, ['check', '--format', 'xml'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /--format 只支持 text \/ json \/ sarif/)

  const conflict = cli(app, ['check', '--json', '--format', 'sarif'])
  assert.equal(conflict.code, 2)
  assert.match(conflict.err, /不能与其它 --format 值同时使用/)
})
