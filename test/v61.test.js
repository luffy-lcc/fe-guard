import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverage, reduce } from '../src/workflow/state.js'
import { callTool } from '../src/workflow/tools.js'
import { checkTestFile, testBlockers } from '../src/workflow/tests.js'
import { migrateRenames } from '../src/baseline.js'
import { tokenize, duplicationScores } from '../src/metrics.js'
import { normalizeConfig, loadConfig } from '../src/config.js'
import { runCheckCore } from '../src/check-core.js'

const at = (index) => `2026-01-01T00:00:0${index}.000Z`
const events = (list) => list.map((item, index) => ({ seq: index + 1, at: at(index), ...item }))

// ------------------------------------------------------------------ Step 1：testFile 语义绑定

test('testFile 只接受仓库内相对路径', () => {
  assert.equal(checkTestFile('test/a.test.js'), 'test/a.test.js')
  assert.equal(checkTestFile('  test/a.test.js  '), 'test/a.test.js')
  assert.throws(() => checkTestFile('../outside.test.js'), /testFile/)
  assert.throws(() => checkTestFile('/abs/test.js'), /testFile/)
  assert.throws(() => checkTestFile('a/../../b.js'), /testFile/)
  assert.throws(() => checkTestFile(''), /testFile/)
  assert.throws(() => checkTestFile(42), /testFile/)
})

const base = [
  { type: 'task.started', taskId: 'T-1', title: 't', goal: 'g' },
  {
    type: 'criteria.declared',
    criteria: [
      { id: 'C1', text: 'a', testFile: 'test/a.test.mjs' },
      { id: 'C2', text: 'b' },
    ],
  },
  { type: 'plan.written', steps: ['s'] },
]

const gate = (seq, ok, tests) => ({
  type: 'gate.recorded',
  evidence: {
    id: `E${seq}`,
    ok,
    exitCode: ok ? 0 : 1,
    summary: { known: 0, new: 0, newErrors: 0 },
    ...(tests ? { tests } : {}),
  },
})

test('挂 testFile 的条件必须测试通过才覆盖（enforce），warn 不阻断', () => {
  const pass = reduce(events([...base, gate(4, true, [{ criterionId: 'C1', file: 'test/a.test.mjs', ok: true, exitCode: 0 }])]))
  assert.equal(coverage(pass, 'enforce').filter((item) => item.evidence).length, 2)

  const fail = reduce(events([...base, gate(4, true, [{ criterionId: 'C1', file: 'test/a.test.mjs', ok: false, exitCode: 1 }])]))
  const covered = coverage(fail, 'enforce')
  assert.equal(covered[0].evidence, null, 'C1 测试失败不应被覆盖')
  assert.ok(covered[1].evidence, '未挂测试的 C2 不受影响')
  assert.equal(coverage(fail, 'warn').filter((item) => item.evidence).length, 2, 'warn 允许降级覆盖')

  const noTests = reduce(events([...base, gate(4, true)]))
  assert.equal(coverage(noTests, 'enforce')[0].evidence, null, '证据里没有测试记录不算覆盖')
})

test('workflow.gate 测试配置：默认值与非法取值', () => {
  const config = normalizeConfig({})
  assert.equal(config.workflow.gate.testCommand, 'node --test')
  assert.equal(config.workflow.gate.testTimeoutMs, 120000)
  assert.throws(() => normalizeConfig({ workflow: { gate: { testCommand: '   ' } } }), /testCommand/)
  assert.throws(() => normalizeConfig({ workflow: { gate: { testTimeoutMs: -1 } } }), /testTimeoutMs/)
  const custom = normalizeConfig({ workflow: { gate: { testCommand: 'npx vitest run', testTimeoutMs: 5000 } } })
  assert.equal(custom.workflow.gate.testCommand, 'npx vitest run')
  assert.equal(custom.workflow.gate.testTimeoutMs, 5000)
})

test('testBlockers 给出可修复的原因', () => {
  const blockers = testBlockers([
    { criterionId: 'C1', file: 't/a.mjs', ok: false, exitCode: null, reason: 'missing' },
    { criterionId: 'C2', file: 't/b.mjs', ok: false, exitCode: 1 },
    { criterionId: 'C3', file: 't/c.mjs', ok: true, exitCode: 0 },
  ])
  assert.equal(blockers.length, 2)
  assert.match(blockers[0], /C1.*测试文件不存在/)
  assert.match(blockers[1], /C2.*退出码 1/)
})

/** 最小可过门禁的临时仓库：只开 metrics，源码干净。 */
function makeRepo(workflow = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-v61-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'test'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'util.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(
    path.join(root, 'fe-guard.config.json'),
    JSON.stringify({
      checks: { metrics: { enabled: true, roots: ['src'] } },
      workflow: { enabled: true, gate: { mode: 'full' }, ...workflow },
    }),
  )
  return root
}

const passingTest = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/util.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n"
const failingTest = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/util.mjs'\ntest('add', () => assert.equal(add(1, 2), 4))\n"

async function startTaskWithTest(root) {
  await callTool({ root, name: 'task_start', args: { title: 'add', goal: 'add 正确' } })
  await callTool({ root, name: 'task_criteria', args: { criteria: [{ text: 'add(1,2)=3', testFile: 'test/add.test.mjs' }] } })
  await callTool({ root, name: 'task_plan', args: { steps: ['实现 add', '写测试'] } })
}

test('端到端：测试文件缺失→拦截；测试通过→交付', async () => {
  const root = makeRepo()
  try {
    await startTaskWithTest(root)
    const missing = await callTool({ root, name: 'task_gate' })
    assert.equal(missing.ok, false)
    assert.equal(missing.stage, 'verify')
    assert.ok(missing.blockers.some((item) => /测试文件不存在/.test(item)), JSON.stringify(missing.blockers))

    writeFileSync(path.join(root, 'test', 'add.test.mjs'), passingTest)
    const pass = await callTool({ root, name: 'task_gate' })
    assert.equal(pass.ok, true)
    assert.equal(pass.stage, 'deliver')
    assert.deepEqual(pass.criteria, { total: 1, achieved: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：测试失败停在 verify，修复后交付', async () => {
  const root = makeRepo()
  try {
    await startTaskWithTest(root)
    writeFileSync(path.join(root, 'test', 'add.test.mjs'), failingTest)
    const fail = await callTool({ root, name: 'task_gate' })
    assert.equal(fail.ok, false)
    assert.equal(fail.stage, 'verify')
    assert.ok(fail.blockers.some((item) => /测试未通过/.test(item)), JSON.stringify(fail.blockers))

    writeFileSync(path.join(root, 'test', 'add.test.mjs'), passingTest)
    const pass = await callTool({ root, name: 'task_gate' })
    assert.equal(pass.stage, 'deliver')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：verify=warn 时失败测试可交付但标 degraded', async () => {
  const root = makeRepo({ stages: { contract: 'enforce', plan: 'enforce', verify: 'warn' } })
  try {
    await startTaskWithTest(root)
    writeFileSync(path.join(root, 'test', 'add.test.mjs'), failingTest)
    const gate = await callTool({ root, name: 'task_gate' })
    assert.equal(gate.stage, 'deliver')
    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.task.deliveredDegraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：非法 testFile 被拒绝且不写入条件', async () => {
  const root = makeRepo()
  try {
    await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    await assert.rejects(
      () => callTool({ root, name: 'task_criteria', args: { criteria: [{ text: 'x', testFile: '../evil.mjs' }] } }),
      /testFile/,
    )
    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.criteria.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ Step 2：重命名迁移

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

test('migrateRenames：键迁移与合并语义（求和 / 取 max / 最早日期）', () => {
  const ledger = {
    entries: { 'src/a.ts::deps/phantom': 2, 'src/b.ts::deps/phantom': 3 },
    ratchets: { 'src/a.ts::metrics/file-lines': 600, 'src/b.ts::metrics/file-lines': 550 },
    firstSeen: {
      'src/a.ts::deps/phantom': '2026-01-01',
      'src/b.ts::deps/phantom': '2026-02-01',
      'src/a.ts::metrics/file-lines': '2026-01-01',
      'src/b.ts::metrics/file-lines': '2026-02-01',
    },
  }
  const { entries, ratchets, firstSeen, moved } = migrateRenames(ledger, [{ from: 'src/a.ts', to: 'src/b.ts' }])
  assert.equal(entries['src/a.ts::deps/phantom'], undefined)
  assert.equal(entries['src/b.ts::deps/phantom'], 5)
  assert.equal(ratchets['src/b.ts::metrics/file-lines'], 600)
  assert.equal(firstSeen['src/b.ts::deps/phantom'], '2026-01-01')
  assert.equal(firstSeen['src/b.ts::metrics/file-lines'], '2026-01-01')
  assert.equal(moved.length, 2)
  // 原账本不被就地修改
  assert.equal(ledger.entries['src/a.ts::deps/phantom'], 2)
})

test('端到端：重命名→check 失败→--follow-renames 迁移→check/--verify 通过', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-rename-'))
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true })
    const lines = Array.from({ length: 510 }, (_, index) => `// line ${index}`).join('\n')
    writeFileSync(path.join(root, 'src/a.ts'), `import { x } from 'ghost-pkg'\nexport const y = x\n${lines}\n`)
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', private: true, dependencies: {} }))
    writeFileSync(
      path.join(root, 'fe-guard.config.json'),
      JSON.stringify({ checks: { deps: { enabled: true }, metrics: { enabled: true } } }),
    )
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 't@t.local'])
    git(root, ['config', 'user.name', 't'])

    assert.equal(cli(root, ['baseline']).code, 0)
    assert.equal(cli(root, ['check']).code, 0)
    const before = JSON.parse(readFileSync(path.join(root, 'fe-guard.baseline.json'), 'utf8'))
    assert.ok(before.entries['src/a.ts'], '旧路径应已入账')
    const since = before.firstSeen['src/a.ts::deps/phantom']

    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'init'])
    const baseSha = git(root, ['rev-parse', 'HEAD'])

    git(root, ['mv', 'src/a.ts', 'src/renamed.ts'])
    assert.equal(cli(root, ['baseline']).code, 2, '不带 --follow-renames 应拒绝放宽')
    assert.equal(cli(root, ['check']).code, 1, '重命名后新路径应被判新增')

    const migrated = cli(root, ['baseline', '--follow-renames'])
    assert.equal(migrated.code, 0, migrated.out)
    const after = JSON.parse(readFileSync(path.join(root, 'fe-guard.baseline.json'), 'utf8'))
    assert.equal(after.entries['src/a.ts'], undefined)
    assert.ok(after.entries['src/renamed.ts']['deps/phantom'] >= 1)
    assert.ok(after.ratchets['src/renamed.ts']['metrics/file-lines'] >= 510)
    assert.equal(after.firstSeen['src/renamed.ts::deps/phantom'], since, 'firstSeen 应保留首次入账日期')
    assert.ok(after.widenLog.some((event) => event.type === 'rename-migration'), 'widenLog 应留痕')
    assert.equal(cli(root, ['check']).code, 0)

    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'rename + migration'])
    const verify = cli(root, ['baseline', '--verify', '--base', baseSha])
    assert.equal(verify.code, 0, verify.out)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ Step 3：重复检测抗改名

test('tokenize：标识符归一化保留关键字与结构', () => {
  const a = 'function alpha(x) { if (x > 1) { return x + 1 } return 0 }'
  const b = 'function beta(y) { if (y > 1) { return y + 1 } return 0 }'
  assert.notDeepEqual(tokenize(a), tokenize(b), '默认不归一化：名字不同即不同')
  const na = tokenize(a, { normalizeIdentifiers: true })
  const nb = tokenize(b, { normalizeIdentifiers: true })
  assert.deepEqual(na, nb, '归一化后：同构代码 token 序列一致')
  for (const keyword of ['function', 'if', 'return']) assert.ok(na.includes(keyword), `关键字 ${keyword} 应保留`)
})

test('duplicationScores：归一化开关决定「复制改名」是否命中', () => {
  const body = (name, arg) =>
    Array.from({ length: 30 }, (_, i) => `function ${name}${i}(${arg}) { if (${arg} > ${i}) { return ${arg} + ${i} } return ${i} }`).join('\n')
  const files = [
    { file: 'src/a.ts', text: body('alpha', 'x') },
    { file: 'src/b.ts', text: body('beta', 'y') },
  ]
  const options = { windowTokens: 20, minTokens: 50 }
  const off = duplicationScores(files, options)
  const on = duplicationScores(files, { ...options, normalizeIdentifiers: true })
  assert.ok(off.get('src/a.ts').ratio < 0.1, '关闭时改名复制不应命中')
  assert.ok(on.get('src/a.ts').ratio > 0.5, '开启时改名复制应命中')
})

test('normalizeIdentifiers 配置：默认 false，非法值报错', () => {
  assert.equal(normalizeConfig({ checks: { metrics: {} } }).checks.metrics.duplication.normalizeIdentifiers, false)
  const on = normalizeConfig({ checks: { metrics: { duplication: { normalizeIdentifiers: true } } } })
  assert.equal(on.checks.metrics.duplication.normalizeIdentifiers, true)
  assert.throws(
    () => normalizeConfig({ checks: { metrics: { duplication: { normalizeIdentifiers: 'yes' } } } }),
    /normalizeIdentifiers/,
  )
})

test('端到端：配置开关贯通到 check 的重复判定', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-dup-'))
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true })
    const body = (name, arg) =>
      Array.from({ length: 30 }, (_, i) => `export function ${name}${i}(${arg}) { if (${arg} > ${i}) { return ${arg} + ${i} } return ${i} }`).join('\n')
    writeFileSync(path.join(root, 'src/a.js'), body('alpha', 'x'))
    writeFileSync(path.join(root, 'src/b.js'), body('beta', 'y'))
    const writeConfig = (normalizeIdentifiers) =>
      writeFileSync(
        path.join(root, 'fe-guard.config.json'),
        JSON.stringify({ checks: { metrics: { enabled: true, duplication: { windowTokens: 20, minTokens: 50, maxRatio: 0.5, normalizeIdentifiers } } } }),
      )
    writeConfig(false)
    assert.equal(cli(root, ['check']).code, 0, '关闭时不应报重复')
    writeConfig(true)
    const hit = cli(root, ['check'])
    assert.equal(hit.code, 1, '开启时应报重复')
    assert.match(hit.out, /metrics\/duplication/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ Step 4：按目录前缀覆盖阈值

test('metrics.overrides 配置：默认空，未知字段 / 非法值报错', () => {
  assert.deepEqual(normalizeConfig({ checks: { metrics: {} } }).checks.metrics.overrides, {})
  const ok = normalizeConfig({
    checks: { metrics: { overrides: { 'apps/legacy': { maxFileLines: 800, duplication: { maxRatio: 0.6 } } } } },
  })
  assert.equal(ok.checks.metrics.overrides['apps/legacy'].maxFileLines, 800)
  assert.equal(ok.checks.metrics.overrides['apps/legacy'].duplication.maxRatio, 0.6)
  assert.throws(
    () => normalizeConfig({ checks: { metrics: { overrides: { 'apps/x': { maxLines: 800 } } } } }),
    /不支持字段/,
  )
  assert.throws(
    () => normalizeConfig({ checks: { metrics: { overrides: { 'apps/x': { maxFileLines: -5 } } } } }),
    /maxFileLines/,
  )
  assert.throws(
    () => normalizeConfig({ checks: { metrics: { overrides: { 'apps/x': { duplication: { windowTokens: 10 } } } } } }),
    /maxRatio/,
  )
})

test('端到端：overrides 按最长目录前缀生效，边界不误匹配', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-override-'))
  try {
    const big = (name) => Array.from({ length: 600 }, (_, index) => `export const ${name}${index} = ${index}`).join('\n')
    for (const dir of ['apps/legacy', 'apps/new', 'apps/legacy2']) {
      mkdirSync(path.join(root, dir), { recursive: true })
      writeFileSync(path.join(root, dir, 'big.js'), big(dir.replace(/[/-]/g, '_')))
    }
    writeFileSync(
      path.join(root, 'fe-guard.config.json'),
      JSON.stringify({
        checks: { metrics: { enabled: true, roots: ['apps'], overrides: { 'apps/legacy': { maxFileLines: 800 } } } },
      }),
    )
    const result = cli(root, ['check'])
    assert.equal(result.code, 1)
    assert.match(result.out, /apps\/new\/big\.js/, '未覆盖目录应按默认阈值报违规')
    assert.match(result.out, /apps\/legacy2\/big\.js/, '前缀边界：legacy2 不应匹配 legacy')
    assert.doesNotMatch(result.out, /apps\/legacy\/big\.js/, '被覆盖目录应豁免')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ Step 5：boundaries 假通过防护

test('boundaries：Vue 仓库未解析任何 .vue → not-executed，拒绝假通过', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-boundaries-'))
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true })
    writeFileSync(path.join(root, 'src/App.vue'), '<template><div /></template>\n')
    writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1\n')
    const fakeDepcruise = (modules) => {
      const file = path.join(root, 'fake-depcruise.sh')
      writeFileSync(file, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ summary: { violations: [] }, modules })}'\n`)
      chmodSync(file, 0o755)
    }
    writeFileSync(
      path.join(root, 'fe-guard.config.json'),
      JSON.stringify({ checks: { boundaries: { enabled: true, bin: './fake-depcruise.sh', args: ['src'] } } }),
    )

    fakeDepcruise([{ source: 'src/a.js' }])
    const broken = await runCheckCore({ root, mode: 'full', config: loadConfig(root) })
    assert.equal(broken.exitCode, 1)
    assert.ok(broken.report.violations.some((v) => v.ruleId === 'boundaries/not-executed'), JSON.stringify(broken.report.violations))

    fakeDepcruise([{ source: 'src/a.js' }, { source: 'src/App.vue' }])
    const ok = await runCheckCore({ root, mode: 'full', config: loadConfig(root) })
    assert.equal(ok.exitCode, 0)
    assert.ok(!ok.report.violations.some((v) => v.ruleId === 'boundaries/not-executed'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
