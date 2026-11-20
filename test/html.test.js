import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { htmlReportPath, renderHtmlReport } from '../src/html.js'

/**
 * 0.3.x B2：`check --format html` 的静态报告。
 * 约束：单文件、内联资源、零外链、无 JS 也可读、列出新增/存量/未执行。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-html-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeFile(app, file, text) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
  writeFileSync(path.join(app, file), text)
}

function sampleReport(overrides = {}) {
  return {
    schemaVersion: 2,
    ok: false,
    exitCode: 1,
    mode: 'full',
    generatedAt: '2026-11-20T00:00:00.000Z',
    skipped: false,
    note: null,
    checks: [
      { id: 'eslint', label: 'ESLint', level: 'error', status: 'ran' },
      { id: 'typescript', label: '类型检查', level: 'error', status: 'unavailable' },
      { id: 'ui', label: '组件规范', level: 'warn', status: 'skipped' },
    ],
    profile: { name: 'full', description: '', checks: ['eslint'], skipped: ['ui'] },
    scope: ['src/a.ts'],
    workspace: null,
    staged: null,
    timings: { checks: { eslint: { ms: 1200, status: 'ok' }, typescript: { ms: 30, status: 'failed' } }, packages: [] },
    summary: { total: 3, known: 1, new: 2, newErrors: 2, newWarnings: 0, tightened: 1, removed: 0 },
    violations: [
      {
        ruleId: 'eslint/no-unused-vars',
        file: 'src/a.ts',
        line: 2,
        severity: 'error',
        status: 'new',
        message: 'unused <img src=x onerror=1>',
        fix: '删掉未使用的变量',
      },
      {
        ruleId: 'boundaries/no-cycles',
        file: 'src/b.ts',
        line: null,
        severity: 'warn',
        status: 'known',
        message: 'cycle </script><script>alert(1)</script>',
        fix: null,
      },
      {
        ruleId: 'typescript/not-executed',
        file: '(check)',
        line: null,
        severity: 'error',
        status: 'new',
        message: '找不到 tsc',
        fix: 'npm i -D typescript',
      },
    ],
    baseline: {
      path: 'fe-guard.baseline.json',
      autoTighten: true,
      tightened: [{ file: 'src/a.ts', ruleId: 'eslint/no-unused-vars', from: 2, to: 1 }],
      removed: [],
      wroteBack: true,
      current: { 'src/a.ts|eslint/no-unused-vars': 1 },
      ratchets: {},
    },
    ...overrides,
  }
}

test('覆盖新增 / 存量 / 未执行、检查状态与汇总数字', () => {
  const html = renderHtmlReport(sampleReport(), { version: '9.9.9' })
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /fe-guard 报告/)
  assert.match(html, /新增违规/)
  assert.match(html, /data-kind="new"/)
  assert.match(html, /data-kind="known"/)
  assert.match(html, /data-kind="not-executed"/)
  assert.match(html, /<code>src\/a\.ts:2<\/code>/)
  assert.match(html, /<code>src\/b\.ts<\/code>/, '没有行号时只显示文件')
  assert.match(html, /未真正执行（不可入账）/)
  assert.match(html, /跳过（跳过 ≠ 通过）/)
  assert.match(html, /baseline 已自动收紧/)
  assert.match(html, /fe-guard 9\.9\.9/)
})

test('转义报告文本，不产生可执行注入', () => {
  const html = renderHtmlReport(sampleReport())
  assert.ok(!html.includes('<img src=x'), '文件名/说明里的标签必须被转义')
  assert.ok(!html.includes('</script><script>alert(1)'), '说明里的脚本必须被转义')
  assert.match(html, /&lt;img src=x/)
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert\(1\)/)
})

test('零外链：没有外部资源与外部跳转', () => {
  const html = renderHtmlReport(sampleReport())
  // 报告文本里的 "src=" 会被转义成纯文本，这里只禁止真正的外部引用。
  for (const pattern of [/https?:\/\//i, /@import/i, /<link\b/i, /<img\b/i, /<a\s/i, /<script[^>]+src=/i, /url\(/i]) {
    assert.ok(!pattern.test(html), `不应包含 ${pattern}`)
  }
  assert.equal((html.match(/<script>/g) ?? []).length, 1, '只有一段内联脚本')
})

test('无 JS 也可读：违规行直接写在 HTML 里', () => {
  const report = sampleReport()
  const html = renderHtmlReport(report)
  const start = html.indexOf('id="violations"')
  const body = html.slice(start, html.indexOf('</table>', start))
  for (const violation of report.violations) {
    assert.ok(body.includes(violation.ruleId), `表格应包含 ${violation.ruleId}`)
  }
})

test('报告路径跟随 report.path', () => {
  assert.equal(htmlReportPath({ report: { path: '.fe-guard/report.json' } }), '.fe-guard/report.html')
  assert.equal(htmlReportPath({ report: { path: 'reports/ci.json' } }), 'reports/ci.html')
  assert.equal(htmlReportPath({ report: { path: 'reports/ci' } }), 'reports/ci.html')
  assert.equal(htmlReportPath({}), '.fe-guard/report.html')
})

test('真实 tsc：HTML 落盘、stdout 只打路径；入账后仍展示存量', () => {
  const app = tempDir('e2e')
  writeFile(app, 'package.json', '{"name":"html-e2e","private":true}\n')
  writeFile(app, 'tsconfig.json', '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}\n')
  writeFile(app, 'src/a.ts', 'export const bad: number = "text"\n')
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'html@fe-guard.local'],
    ['config', 'user.name', 'html'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    const result = spawnSync('git', args, { cwd: app, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  }
  for (const args of [['init'], ['check', '--profile', 'full'], ['baseline']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
    if (args[0] === 'check') assert.equal(result.status, 1, result.stdout + result.stderr)
    else assert.equal(result.status, 0, result.stdout + result.stderr)
  }

  const run = spawnSync(process.execPath, [CLI, 'check', '--profile', 'full', '--format', 'html'], {
    cwd: app,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), 'HTML 报告: .fe-guard/report.html', 'stdout 只打印路径')
  const file = path.join(app, '.fe-guard/report.html')
  assert.equal(existsSync(file), true)
  const html = readFileSync(file, 'utf8')
  assert.match(html, /<!doctype html>/)
  assert.match(html, /typescript\/TS2322/)
  assert.match(html, /<code>src\/a\.ts:1<\/code>/)
  assert.match(html, /data-kind="known"/, 'baseline 入账后显示为存量')
})
