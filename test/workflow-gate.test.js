import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../src/config.js'
import { loadTask, reduce } from '../src/workflow/state.js'
import { compareGateEvidence, violationKey } from '../src/workflow/evidence.js'
import { collectStats } from '../src/workflow/statistics.js'
import { callTool } from '../src/workflow/tools.js'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO_ROOT, 'bin', 'fe-guard.js')

const PREFLIGHT_SCRIPT = `
import { existsSync, readFileSync } from 'node:fs'
const file = new URL('./.preflight-mode', import.meta.url)
const mode = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'ok'
if (mode === 'fail') {
  console.error('预检失败：环境未就绪')
  process.exit(3)
}
if (mode === 'slow') setInterval(() => {}, 1000)
else {
  console.log('环境正常')
  process.exit(0)
}
`

/** 最小可过门禁的临时仓库：只开 metrics，源码干净。 */
function makeRepo(workflow = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-gate-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'util.mjs'), 'export const add = (a, b) => a + b\n')
  writeConfig(root, workflow)
  return root
}

function writeConfig(root, workflow = {}) {
  writeFileSync(
    path.join(root, 'fe-guard.config.json'),
    `${JSON.stringify(
      {
        checks: { metrics: { enabled: true, roots: ['src'] } },
        workflow: { enabled: true, gate: { mode: 'full' }, ...workflow },
      },
      null,
      2,
    )}\n`,
  )
}

function withPreflight(root, { timeoutMs = 15000 } = {}) {
  writeFileSync(path.join(root, 'preflight.mjs'), PREFLIGHT_SCRIPT)
  writeConfig(root, { preflight: { command: 'node preflight.mjs', timeoutMs } })
}

const setPreflightMode = (root, mode) => writeFileSync(path.join(root, '.preflight-mode'), `${mode}\n`)

/** 触发 metrics/any：显式 any 21 处，超过默认阈值 20。 */
function anyFile(name = 'bad.ts') {
  return {
    file: name,
    text: `${Array.from({ length: 21 }, (_, index) => `export const a${index}: any = ${index}`).join('\n')}\n`,
  }
}

async function startContract(root, criteria) {
  await callTool({ root, name: 'task_start', args: { title: '门禁测试', goal: '验证预检与复盘' } })
  await callTool({ root, name: 'task_criteria', args: { criteria } })
  await callTool({ root, name: 'task_plan', args: { steps: ['实现'] } })
}

const gateCriteria = [{ text: '全量检查通过', type: 'compat', source: '仓库约定：交付前跑检查' }]

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// ------------------------------------------------------------------ 配置

test('workflow 配置：preflight 与 distill 的默认值与非法值', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config.workflow.preflight, { command: '', timeoutMs: 60000 })
  assert.deepEqual(config.workflow.visualDiff, { command: '', timeoutMs: 120000 })
  assert.equal(config.workflow.distill, 'enforce')

  const custom = normalizeConfig({
    workflow: { preflight: { command: '  node preflight.mjs  ', timeoutMs: 5000 }, distill: 'warn' },
  })
  assert.deepEqual(custom.workflow.preflight, { command: 'node preflight.mjs', timeoutMs: 5000 })
  assert.equal(custom.workflow.distill, 'warn')

  assert.throws(() => normalizeConfig({ workflow: { preflight: { command: true } } }), /preflight\.command/)
  assert.throws(() => normalizeConfig({ workflow: { preflight: { timeoutMs: 0 } } }), /preflight\.timeoutMs/)
  assert.throws(() => normalizeConfig({ workflow: { distill: 'sometimes' } }), /workflow\.distill/)
})

test('workflow 配置：preflight.steps 与 visualDiff 的归一化与互斥校验', () => {
  const config = normalizeConfig({
    workflow: {
      preflight: {
        timeoutMs: 5000,
        steps: [
          { name: 'server', command: ' node server.mjs ', timeoutMs: 1000 },
          { name: 'proxy', command: 'node proxy.mjs' },
        ],
      },
      visualDiff: { command: ' npm run visual:diff ', timeoutMs: 9000 },
    },
  })
  assert.equal(config.workflow.preflight.command, '')
  assert.deepEqual(config.workflow.preflight.steps, [
    { name: 'server', command: 'node server.mjs', timeoutMs: 1000 },
    { name: 'proxy', command: 'node proxy.mjs', timeoutMs: 5000 },
  ])
  assert.deepEqual(config.workflow.visualDiff, { command: 'npm run visual:diff', timeoutMs: 9000 })

  assert.throws(
    () => normalizeConfig({ workflow: { preflight: { command: 'node a.mjs', steps: [{ name: 'a', command: 'node a.mjs' }] } } }),
    /二选一/,
  )
  assert.throws(() => normalizeConfig({ workflow: { preflight: { steps: [] } } }), /不能为空数组/)
  assert.throws(
    () => normalizeConfig({ workflow: { preflight: { steps: [{ name: 'a', command: 'node a.mjs' }, { name: 'a', command: 'node b.mjs' }] } } }),
    /不能重复/,
  )
  assert.throws(
    () => normalizeConfig({ workflow: { preflight: { steps: [{ name: 'a', command: 'node a.mjs', extra: true }] } } }),
    /不接受字段/,
  )
  assert.throws(() => normalizeConfig({ workflow: { visualDiff: { command: true } } }), /visualDiff\.command/)
})

// ------------------------------------------------------------------ 环境预检

test('未配置预检时 task_start 不执行外部命令，状态里记录关闭', async () => {
  const root = makeRepo()
  try {
    const started = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(started.ok, true)
    assert.equal(started.preflight, undefined, '未配置时不回传 preflight')

    const status = await callTool({ root, name: 'task_status' })
    assert.deepEqual(status.preflight, { configured: false, ok: true, command: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('预检失败时 task_start 不创建任务；修复后可以开始', async () => {
  const root = makeRepo()
  try {
    withPreflight(root)
    setPreflightMode(root, 'fail')

    const blocked = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.next, 'task_start')
    assert.equal(blocked.preflight.ok, false)
    assert.equal(blocked.preflight.exitCode, 3)
    assert.match(blocked.preflight.output, /预检失败/)
    assert.equal(loadTask(root).events.length, 0, '失败时不能写 task.started')

    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.active, false)

    setPreflightMode(root, 'ok')
    const started = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(started.ok, true)
    assert.equal(started.preflight.ok, true)
    assert.equal(loadTask(root).events[0].type, 'task.started')
    assert.equal(loadTask(root).events[0].preflight.configured, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('预检超时按失败处理（timedOut），不会开始任务', async () => {
  const root = makeRepo()
  try {
    withPreflight(root, { timeoutMs: 150 })
    setPreflightMode(root, 'slow')

    const blocked = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.preflight.timedOut, true)
    assert.equal(loadTask(root).events.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('预检命令不可用时按 missing 处理，不开始任务', async () => {
  const root = makeRepo()
  try {
    writeConfig(root, { preflight: { command: 'fe-guard-no-such-command-xyz', timeoutMs: 5000 } })
    const blocked = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.preflight.missing, true)
    assert.match(blocked.preflight.output, /找不到可执行文件/)
    assert.equal(loadTask(root).events.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('多步预检：失败步骤定位到 name，成功时记录每步结果', async () => {
  const root = makeRepo()
  try {
    writeFileSync(path.join(root, 'step1.mjs'), "console.log('step1 ok')\n")
    writeFileSync(
      path.join(root, 'step2.mjs'),
      "import { existsSync, readFileSync } from 'node:fs'\nconst file = new URL('./.step2-mode', import.meta.url)\nif (existsSync(file) && readFileSync(file, 'utf8').trim() === 'fail') { console.error('proxy down'); process.exit(5) }\nconsole.log('step2 ok')\n",
    )
    writeConfig(root, {
      preflight: {
        timeoutMs: 5000,
        steps: [
          { name: 'server', command: 'node step1.mjs' },
          { name: 'proxy', command: 'node step2.mjs', timeoutMs: 3000 },
        ],
      },
    })
    writeFileSync(path.join(root, '.step2-mode'), 'fail\n')

    const blocked = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.preflight.mode, 'steps')
    assert.equal(blocked.preflight.failedStep, 'proxy')
    assert.equal(blocked.preflight.exitCode, 5)
    assert.match(blocked.preflight.output, /proxy down/)
    assert.equal(loadTask(root).events.length, 0)
    assert.equal(blocked.preflight.steps[0].name, 'server')
    assert.equal(blocked.preflight.steps[0].ok, true)

    writeFileSync(path.join(root, '.step2-mode'), 'ok\n')
    const started = await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    assert.equal(started.ok, true)
    assert.equal(started.preflight.failedStep, null)
    assert.deepEqual(started.preflight.steps.map((step) => step.ok), [true, true])
    assert.match(started.preflight.steps[1].output, /step2 ok/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task_gate 预检失败：本次检查不执行、不写证据、条件不被覆盖', async () => {
  const root = makeRepo()
  try {
    withPreflight(root)
    setPreflightMode(root, 'ok')
    await startContract(root, gateCriteria)

    setPreflightMode(root, 'fail')
    const blocked = await callTool({ root, name: 'task_gate' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.exitCode, 1)
    assert.equal(blocked.stage, 'implement', '预检失败不推进阶段')
    assert.ok(blocked.blockers.some((item) => /本次检查未执行/.test(item)), JSON.stringify(blocked.blockers))

    const task = loadTask(root)
    assert.equal(task.events.filter((event) => event.type === 'gate.recorded').length, 0)
    assert.equal(task.events.filter((event) => event.type === 'preflight.failed').length, 1)
    assert.equal(existsSync(path.join(root, '.fe-guard', 'evidence')), false, '预检失败不能产出快照')

    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.evidence.length, 0)
    assert.equal(status.completion.achieved, 0)
    assert.equal(status.preflight.ok, false)

    const next = await callTool({ root, name: 'task_next' })
    assert.ok(next.blockers.some((item) => /环境预检未通过/.test(item)), JSON.stringify(next.blockers))

    setPreflightMode(root, 'ok')
    const passed = await callTool({ root, name: 'task_gate' })
    assert.equal(passed.stage, 'deliver')
    assert.equal(passed.preflight.ok, true)
    assert.ok(passed.evidencePath && existsSync(path.join(root, passed.evidencePath)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('视觉条件：命令失败不覆盖，修复后交付并落盘视觉证据', async () => {
  const root = makeRepo()
  try {
    writeFileSync(
      path.join(root, 'visual.mjs'),
      "import { existsSync, readFileSync } from 'node:fs'\nconst file = new URL('./.visual-mode', import.meta.url)\nconst mode = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'fail'\nif (mode === 'fail') { console.error('视觉差异 3 处'); process.exit(2) }\nconsole.log('视觉对比通过')\n",
    )
    writeConfig(root, { visualDiff: { command: 'node visual.mjs', timeoutMs: 5000 }, distill: 'off' })
    await callTool({ root, name: 'task_start', args: { title: '视觉任务', goal: '验证视觉条件' } })
    await callTool({
      root,
      name: 'task_criteria',
      args: {
        criteria: [
          { text: '首页视觉与设计稿一致', type: 'ui', source: '设计稿#首页', verify: 'gate', evidenceKind: 'diff' },
        ],
      },
    })
    await callTool({ root, name: 'task_plan', args: { steps: ['实现页面'] } })

    writeFileSync(path.join(root, '.visual-mode'), 'fail\n')
    const failed = await callTool({ root, name: 'task_gate' })
    assert.equal(failed.ok, false)
    assert.equal(failed.visualDiff.ran, true)
    assert.equal(failed.visualDiff.ok, false)
    assert.equal(failed.visualDiff.exitCode, 2)
    assert.ok(failed.visualDiff.file, '视觉输出应落盘')
    assert.ok(existsSync(path.join(root, failed.visualDiff.file)))
    assert.ok(failed.blockers.some((item) => /视觉对比未通过/.test(item)), JSON.stringify(failed.blockers))
    assert.equal(failed.completion.achieved, 0)
    assert.equal(failed.stage, 'verify')

    writeFileSync(path.join(root, '.visual-mode'), 'ok\n')
    const passed = await callTool({ root, name: 'task_gate' })
    assert.equal(passed.ok, true)
    assert.equal(passed.visualDiff.ok, true)
    assert.equal(passed.completion.achieved, 1)
    assert.equal(passed.stage, 'deliver')
    assert.ok(passed.evidencePath && existsSync(path.join(root, passed.evidencePath)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('视觉条件未配置 visualDiff.command：明确阻塞，不冒充通过', async () => {
  const root = makeRepo()
  try {
    await callTool({ root, name: 'task_start', args: { title: '视觉任务', goal: '验证缺少命令' } })
    await callTool({
      root,
      name: 'task_criteria',
      args: {
        criteria: [
          { text: '视觉一致', type: 'ui', source: '设计稿', verify: 'gate', evidenceKind: 'diff' },
        ],
      },
    })
    await callTool({ root, name: 'task_plan', args: { steps: ['实现'] } })
    const result = await callTool({ root, name: 'task_gate' })
    assert.equal(result.ok, false)
    assert.equal(result.visualDiff.reason, 'not-configured')
    assert.ok(result.blockers.some((item) => /未配置 workflow\.visualDiff\.command/.test(item)))
    assert.equal(result.completion.achieved, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('视觉命令不可用或超时：按未执行处理，不覆盖条件', async () => {
  const scenarios = [
    { name: 'missing', visualDiff: { command: 'fe-guard-no-such-visual-xyz', timeoutMs: 5000 }, flag: 'missing' },
    { name: 'timeout', visualDiff: { command: 'node slow-visual.mjs', timeoutMs: 120 }, flag: 'timedOut' },
  ]
  for (const scenario of scenarios) {
    const root = makeRepo()
    try {
      writeFileSync(path.join(root, 'slow-visual.mjs'), 'setInterval(() => {}, 1000)\n')
      writeConfig(root, { visualDiff: scenario.visualDiff, distill: 'off' })
      await callTool({ root, name: 'task_start', args: { title: '视觉任务', goal: scenario.name } })
      await callTool({
        root,
        name: 'task_criteria',
        args: { criteria: [{ text: '视觉一致', type: 'ui', source: '设计稿', verify: 'gate', evidenceKind: 'diff' }] },
      })
      await callTool({ root, name: 'task_plan', args: { steps: ['实现'] } })

      const result = await callTool({ root, name: 'task_gate' })
      assert.equal(result.ok, false, scenario.name)
      assert.equal(result.visualDiff.ok, false, scenario.name)
      assert.equal(result.visualDiff[scenario.flag], true, scenario.name)
      assert.equal(result.completion.achieved, 0, scenario.name)
      assert.ok(
        result.blockers.some((item) => /视觉对比未执行/.test(item)),
        `${scenario.name}: ${JSON.stringify(result.blockers)}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// ------------------------------------------------------------------ 返工对比

test('compareGateEvidence：首轮 / 修好 / 改坏 / 持平', () => {
  const previous = {
    ok: false,
    summary: { new: 2 },
    violations: [
      { ruleId: 'metrics/any', file: 'src/a.ts', line: null, status: 'new' },
      { ruleId: 'metrics/any', file: 'src/b.ts', line: null, status: 'new' },
    ],
  }
  assert.deepEqual(compareGateEvidence(undefined, [{ ruleId: 'x', file: 'f', line: 1, status: 'new' }]), {
    previousNew: null,
    fixed: 0,
    introduced: 1,
  })

  const fixedOnly = compareGateEvidence(previous, [
    { ruleId: 'metrics/any', file: 'src/b.ts', line: null, status: 'new' },
  ])
  assert.deepEqual(fixedOnly, { previousNew: 2, fixed: 1, introduced: 0 })

  const worse = compareGateEvidence(previous, [
    { ruleId: 'metrics/any', file: 'src/a.ts', line: null, status: 'new' },
    { ruleId: 'metrics/any', file: 'src/c.ts', line: null, status: 'new' },
  ])
  assert.deepEqual(worse, { previousNew: 2, fixed: 1, introduced: 1 })

  assert.deepEqual(compareGateEvidence(previous, previous.violations), { previousNew: 2, fixed: 0, introduced: 0 })
  assert.equal(violationKey({ status: 'new', ruleId: 'r', file: 'f', line: 3 }), 'new|r|f|3')
  assert.equal(violationKey({ status: 'new', ruleId: 'r', file: 'f' }), 'new|r|f|')
})

test('门禁趋势：首轮无 trend，修好 fixed，持平为 0', async () => {
  const root = makeRepo()
  try {
    await startContract(root, gateCriteria)

    const bad = anyFile()
    writeFileSync(path.join(root, 'src', bad.file), bad.text)
    const first = await callTool({ root, name: 'task_gate' })
    assert.equal(first.ok, false)
    assert.equal('trend' in first, false, '首轮没有上一轮证据，不能伪造 trend')
    assert.equal(first.lessonRequired, true)

    const task = loadTask(root)
    const firstEvidence = reduce(task.events).evidence.at(-1)
    assert.equal('trend' in firstEvidence, false)

    rmSync(path.join(root, 'src', bad.file))
    const fixed = await callTool({ root, name: 'task_gate' })
    assert.equal(fixed.ok, true)
    assert.deepEqual(fixed.trend, { previousNew: 1, fixed: 1, introduced: 0 })
    assert.equal(fixed.stage, 'verify', '失败后没复盘，enforce 下不能交付')
    assert.ok(fixed.blockers.some((item) => /task_lesson/.test(item)), JSON.stringify(fixed.blockers))

    await callTool({
      root,
      name: 'task_lesson',
      args: { text: '修复前先跑门禁定位问题', evidence: 'E1/E2 对比', scope: 'rule' },
    })
    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')
    assert.deepEqual(delivered.trend, { previousNew: 0, fixed: 0, introduced: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('上一轮失败后又引入新违规：blocker 提示先确认是否改坏', async () => {
  const root = makeRepo()
  try {
    await startContract(root, gateCriteria)
    const firstBad = anyFile('a.ts')
    writeFileSync(path.join(root, 'src', firstBad.file), firstBad.text)
    const first = await callTool({ root, name: 'task_gate' })
    assert.equal(first.ok, false)

    rmSync(path.join(root, 'src', firstBad.file))
    const secondBad = anyFile('b.ts')
    writeFileSync(path.join(root, 'src', secondBad.file), secondBad.text)
    const second = await callTool({ root, name: 'task_gate' })
    assert.equal(second.ok, false)
    assert.deepEqual(second.trend, { previousNew: 1, fixed: 1, introduced: 1 })
    assert.match(second.blockers[0], /本轮引入了 1 条上轮没有的违规/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 复盘

/** 制造一次失败门禁并修复源码，返回修复后的门禁响应。 */
async function failThenFix(root) {
  await startContract(root, gateCriteria)
  const bad = anyFile()
  writeFileSync(path.join(root, 'src', bad.file), bad.text)
  const failed = await callTool({ root, name: 'task_gate' })
  assert.equal(failed.ok, false)
  rmSync(path.join(root, 'src', bad.file))
  const afterFix = await callTool({ root, name: 'task_gate' })
  return { failed, afterFix }
}

test('distill=enforce：失败门禁后不交付，task_lesson 后交付并追加 lessons.jsonl', async () => {
  const root = makeRepo()
  try {
    const { afterFix } = await failThenFix(root)
    assert.equal(afterFix.ok, true)
    assert.equal(afterFix.stage, 'verify')
    assert.equal(afterFix.lessonRequired, true)
    assert.ok(afterFix.blockers.some((item) => /task_lesson/.test(item)), JSON.stringify(afterFix.blockers))

    const lesson = await callTool({
      root,
      name: 'task_lesson',
      args: { text: '修改前先复现违规，修完再跑门禁', evidence: 'E1 → E2 fixed=1', scope: 'skill' },
    })
    assert.equal(lesson.ok, true)
    assert.equal(lesson.lessonId, 'L1')
    assert.equal(lesson.ledger, true)
    assert.equal(lesson.lessons, 1)

    const ledger = path.join(root, '.fe-guard', 'lessons.jsonl')
    assert.ok(existsSync(ledger))
    const lines = readFileSync(ledger, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).scope, 'skill')

    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.lessonRequired, false)
    assert.equal(status.lessons.length, 1)
    assert.equal(status.lessons[0].scope, 'skill')

    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')
    assert.equal(delivered.lessonRequired, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('distill=warn：失败后未复盘仍可交付，但标记 degraded', async () => {
  const root = makeRepo({ distill: 'warn' })
  try {
    const { afterFix } = await failThenFix(root)
    assert.equal(afterFix.stage, 'deliver')
    assert.equal(afterFix.lessonRequired, true)
    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.task.deliveredDegraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('distill=off：失败后未复盘直接交付且不降级', async () => {
  const root = makeRepo({ distill: 'off' })
  try {
    const { afterFix } = await failThenFix(root)
    assert.equal(afterFix.stage, 'deliver')
    assert.equal(afterFix.distill, 'off')
    assert.equal(afterFix.blockers.some((item) => /task_lesson/.test(item)), false)
    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.task.deliveredDegraded, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task_lesson：scope=none 必须写理由；无任务/已交付被拒；参数白名单', async () => {
  const root = makeRepo()
  try {
    await assert.rejects(
      () => callTool({ root, name: 'task_lesson', args: { text: 't', evidence: 'e', scope: 'none' } }),
      /没有任务|scope=none/,
    )

    await startContract(root, gateCriteria)
    await assert.rejects(
      () => callTool({ root, name: 'task_lesson', args: { text: 't', evidence: 'e', scope: 'none' } }),
      /scopeReason/,
    )
    await assert.rejects(
      () => callTool({ root, name: 'task_lesson', args: { text: 't', evidence: 'e', scope: 'sometime' } }),
      /scope/,
    )
    await assert.rejects(
      () => callTool({ root, name: 'task_lesson', args: { text: 't', evidence: 'e', scope: 'rule', extra: 1 } }),
      /不接受参数/,
    )

    const lesson = await callTool({
      root,
      name: 'task_lesson',
      args: { text: '偶发环境问题不落地', evidence: '复现两次均失败', scope: 'none', scopeReason: '属于机器环境' },
    })
    assert.equal(lesson.ok, true)
    assert.equal(lesson.scope, 'none')

    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')
    await assert.rejects(
      () => callTool({ root, name: 'task_lesson', args: { text: 't', evidence: 'e', scope: 'rule' } }),
      /已交付/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 效果统计

function writeTaskFile(file, taskId, events) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ version: 1, taskId, events }, null, 2)}\n`)
}

const started = (taskId) => ({ seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'task.started', taskId, title: 't', goal: 'g' })

test('collectStats：无任务时全部为 0', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-stats-empty-'))
  try {
    const stats = collectStats(root)
    assert.deepEqual(stats.tasks, [])
    assert.equal(stats.totals.tasks, 0)
    assert.equal(stats.totals.failureRate, 0)
    assert.equal(stats.totals.avgGatesPerTask, 0)
    assert.deepEqual(stats.topBlockers, [])

    const run = cli(root, ['task', 'stats', '--json'])
    assert.equal(run.code, 0, run.out)
    assert.equal(JSON.parse(run.out).totals.tasks, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectStats：聚合当前任务、归档、损坏文件与 top blocker', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-stats-'))
  try {
    const anyViolation = (file) => ({ ruleId: 'metrics/any', file, line: null, status: 'new' })
    writeTaskFile(path.join(root, '.fe-guard', 'task.json'), 'T-current', [
      started('T-current'),
      {
        seq: 2,
        at: '2026-01-01T00:01:00.000Z',
        type: 'gate.recorded',
        evidence: { id: 'E1', ok: false, summary: { new: 2 }, violations: [anyViolation('src/a.ts')] },
      },
      { seq: 3, at: '2026-01-01T00:02:00.000Z', type: 'lesson.recorded', lesson: { id: 'L1', text: 'x', scope: 'rule' } },
      { seq: 4, at: '2026-01-01T00:03:00.000Z', type: 'criterion.deferred', criterionId: 'C2', reason: '待办' },
      {
        seq: 5,
        at: '2026-01-01T00:04:00.000Z',
        type: 'gate.recorded',
        evidence: { id: 'E2', ok: true, summary: { new: 0 }, violations: [] },
      },
    ])

    writeTaskFile(path.join(root, '.fe-guard', 'tasks', 'a.json'), 'T-a', [
      started('T-a'),
      {
        seq: 2,
        at: '2026-01-01T00:01:00.000Z',
        type: 'gate.recorded',
        evidence: {
          id: 'E1',
          ok: false,
          summary: { new: 2 },
          violations: [anyViolation('src/b.ts'), { ruleId: 'eslint/no-unused-vars', file: 'src/c.ts', line: 3, status: 'new' }],
        },
      },
    ])

    writeTaskFile(path.join(root, '.fe-guard', 'tasks', 'b.json'), 'T-b', [
      started('T-b'),
      { seq: 2, at: '2026-01-01T00:01:00.000Z', type: 'task.delivered', degraded: true },
    ])

    writeFileSync(path.join(root, '.fe-guard', 'tasks', 'broken.json'), '{not-json')

    const stats = collectStats(root)
    assert.equal(stats.totals.tasks, 3)
    assert.equal(stats.totals.delivered, 1)
    assert.equal(stats.totals.degraded, 1)
    assert.equal(stats.totals.active, 2)
    assert.equal(stats.totals.gates, 3)
    assert.equal(stats.totals.failedGates, 2)
    assert.equal(stats.totals.failureRate, 2 / 3)
    assert.equal(stats.totals.avgGatesPerTask, 1)
    assert.equal(stats.totals.lessons, 1)
    assert.equal(stats.totals.deferred, 1)
    assert.equal(stats.totals.corrupt, 1)
    assert.deepEqual(stats.topBlockers, [
      { ruleId: 'metrics/any', count: 2 },
      { ruleId: 'eslint/no-unused-vars', count: 1 },
    ])
    assert.equal(stats.tasks.find((item) => item.current).id, 'T-current')

    const run = cli(root, ['task', 'stats'])
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /任务统计: 3 个/)
    assert.match(run.out, /复盘: 1 条/)
    assert.match(run.out, /metrics\/any ×2/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectStats：当前 task.json 损坏时跳过并计入 corrupt', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-stats-broken-'))
  try {
    mkdirSync(path.join(root, '.fe-guard'), { recursive: true })
    writeFileSync(path.join(root, '.fe-guard', 'task.json'), 'not json')
    const stats = collectStats(root)
    assert.equal(stats.totals.tasks, 0)
    assert.equal(stats.totals.corrupt, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
