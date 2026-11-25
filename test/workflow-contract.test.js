import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { completion, coverage, isConfirmed, reduce } from '../src/workflow/state.js'
import { normalizeCriteriaList } from '../src/workflow/criteria.js'
import { collectManualEvidence, writeEvidenceSnapshot } from '../src/workflow/evidence.js'
import { callTool } from '../src/workflow/tools.js'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO_ROOT, 'bin', 'fe-guard.js')

const at = (index) => `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`
const events = (list) => list.map((item, index) => ({ seq: index + 1, at: at(index), ...item }))

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** 最小可过门禁的临时仓库：只开 metrics，源码干净。 */
function makeRepo(workflow = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-contract-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
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

async function startTask(root, criteria) {
  await callTool({ root, name: 'task_start', args: { title: '合同测试', goal: '验证验收条件合同' } })
  const declared = await callTool({ root, name: 'task_criteria', args: { criteria } })
  await callTool({ root, name: 'task_plan', args: { steps: ['实现'] } })
  return declared
}

// ------------------------------------------------------------------ 字段校验

test('验收条件必须带 type / source，且验收方式与字段一致', () => {
  const make = (item) => normalizeCriteriaList({ items: [item] })
  assert.throws(() => make({ text: 'x' }), /type/)
  assert.throws(() => make({ text: 'x', type: 'ui' }), /source/)
  assert.throws(() => make({ text: 'x', type: 'unknown', source: '需求' }), /type/)
  assert.throws(() => make({ text: 'x', type: 'ui', source: '需求', verify: 'bogus' }), /verify/)
  assert.throws(() => make({ text: 'x', type: 'ui', source: '需求', verify: 'test' }), /testFile/)
  assert.throws(() => make({ text: 'x', type: 'ui', source: '需求', verify: 'manual' }), /evidenceFile/)
  assert.throws(
    () => make({ text: 'x', type: 'ui', source: '需求', verify: 'gate', testFile: 'test/a.mjs' }),
    /testFile/,
  )
  assert.throws(
    () => make({ text: 'x', type: 'ui', source: '需求', testFile: 'test/a.mjs', evidenceFile: 'evidence/a.txt' }),
    /二选一|同时/,
  )

  assert.equal(make({ text: 'x', type: 'ui', source: '需求', testFile: 'test/a.mjs' })[0].verify, 'test')
  assert.equal(make({ text: 'x', type: 'ui', source: '需求', evidenceFile: 'evidence/a.txt' })[0].verify, 'manual')
  assert.equal(make({ text: 'x', type: 'ui', source: '需求' })[0].verify, 'gate')
})

test('task_criteria 返回 types / assumptions，全 UI 时给 warning 但不阻断', async () => {
  const root = makeRepo()
  try {
    await callTool({ root, name: 'task_start', args: { title: 't', goal: 'g' } })
    await assert.rejects(
      () => callTool({ root, name: 'task_criteria', args: { criteria: [{ text: '缺字段' }] } }),
      /type/,
    )
    const declared = await callTool({
      root,
      name: 'task_criteria',
      args: {
        criteria: [
          { text: '按钮可点击', type: 'ui', source: '需求：按钮交互' },
          { text: '空态文案', type: 'ui', source: 'assumption: 设计稿未画空态' },
        ],
      },
    })
    assert.deepEqual(declared.types, { ui: 2 })
    assert.deepEqual(declared.assumptions, ['C2'])
    assert.match(declared.warning, /全部为 ui/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('历史事件缺少 type/source/verify 仍能 reduce、coverage 与 completion', () => {
  const state = reduce(
    events([
      { type: 'task.started', taskId: 'T-1', title: 't', goal: 'g' },
      { type: 'criteria.declared', criteria: [{ id: 'C1', text: '旧条件' }] },
      { type: 'plan.written', steps: ['s'] },
      { type: 'gate.recorded', evidence: { id: 'E1', ok: true, exitCode: 0, summary: { known: 0, new: 0, newErrors: 0 } } },
    ]),
  )
  const covered = coverage(state, 'enforce')
  assert.equal(covered[0].status, 'covered')
  assert.equal(covered[0].criterion.type, undefined)
  assert.deepEqual(completion(state, 'enforce'), { achieved: 1, total: 1, remaining: [], deferred: [] })
})

// ------------------------------------------------------------------ 推断项确认

test('推断项未确认时门禁不交付；人工确认后可交付', async () => {
  const root = makeRepo()
  try {
    const declared = await startTask(root, [
      { text: '空态文案', type: 'ui', source: 'assumption: 设计稿未画空态' },
    ])
    assert.deepEqual(declared.assumptions, ['C1'])

    const blocked = await callTool({ root, name: 'task_gate' })
    assert.equal(blocked.stage, 'verify')
    assert.deepEqual(blocked.completion.remaining, [], '门禁证据已覆盖条件')
    assert.ok(blocked.blockers.some((item) => /task confirm C1/.test(item)), JSON.stringify(blocked.blockers))

    const pendingStatus = cli(root, ['task', 'status'])
    assert.equal(pendingStatus.code, 0, pendingStatus.err)
    assert.match(pendingStatus.out, /推断项待人工确认/)
    assert.match(pendingStatus.out, /task confirm C1/)

    const again = await callTool({ root, name: 'task_gate' })
    assert.equal(again.stage, 'verify', '未确认时重复门禁仍不能交付')

    const confirmed = cli(root, ['task', 'confirm', 'C1', '--note', '已与产品确认按最小文案实现', '--yes'])
    assert.equal(confirmed.code, 0, confirmed.err)

    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')

    const status = await callTool({ root, name: 'task_status' })
    assert.deepEqual(status.confirmations, ['C1'])
    assert.deepEqual(status.assumptions, ['C1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('确认早于条件不算、非 assumption 不能确认、缺少 --note/--yes 被拒', async () => {
  const early = reduce(
    events([
      { type: 'task.started', taskId: 'T-1', title: 't', goal: 'g' },
      { type: 'criterion.confirmed', criterionId: 'C1', note: '确认得太早' },
      { type: 'criteria.declared', criteria: [{ id: 'C1', text: 'x', type: 'ui', source: 'assumption: x' }] },
    ]),
  )
  assert.equal(early.confirmations.length, 1)
  assert.equal(isConfirmed(early, early.criteria[0]), false, '确认事件早于条件时无效')

  const root = makeRepo()
  try {
    await startTask(root, [{ text: '普通条件', type: 'ui', source: '需求：按钮' }])

    const noYes = cli(root, ['task', 'confirm', 'C1', '--note', 'x'])
    assert.equal(noYes.code, 2)
    assert.match(noYes.err, /--yes/)

    const noNote = cli(root, ['task', 'confirm', 'C1', '--yes'])
    assert.equal(noNote.code, 2)
    assert.match(noNote.err, /--note/)

    const unknown = cli(root, ['task', 'confirm', 'C9', '--note', 'x', '--yes'])
    assert.equal(unknown.code, 2)
    assert.match(unknown.err, /没有验收条件/)

    const notAssumption = cli(root, ['task', 'confirm', 'C1', '--note', 'x', '--yes'])
    assert.equal(notAssumption.code, 2)
    assert.match(notAssumption.err, /assumption/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 明确放弃 / 待办

test('defer 后交付 degraded 并单列待办；未 defer 阻止交付；理由必填', async () => {
  const root = makeRepo()
  try {
    await startTask(root, [
      { text: '全量检查通过', type: 'compat', source: '仓库约定：交付前跑检查' },
      {
        text: '接口联调完成',
        type: 'interaction',
        source: '需求：联调记录',
        verify: 'manual',
        evidenceFile: 'evidence/api.txt',
      },
    ])

    const blocked = await callTool({ root, name: 'task_gate' })
    assert.equal(blocked.stage, 'verify', '未 defer 的未完成条件仍会阻止交付')

    const coveredDefer = cli(root, ['task', 'defer', 'C1', '--reason', '已有证据', '--yes'])
    assert.equal(coveredDefer.code, 2)
    assert.match(coveredDefer.err, /已有门禁证据/)

    const noReason = cli(root, ['task', 'defer', 'C2', '--yes'])
    assert.equal(noReason.code, 2)
    assert.match(noReason.err, /--reason/)

    const deferred = cli(root, ['task', 'defer', 'C2', '--reason', '后端接口未联调，转上线待办', '--yes'])
    assert.equal(deferred.code, 0, deferred.err)

    const eventLog = cli(root, ['task', 'events'])
    assert.match(eventLog.out, /criterion\.deferred\s+C2/)
    const digest = JSON.parse(cli(root, ['task', 'events', '--summary', '--json']).out)
    assert.equal(digest.deferrals, 1)

    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')
    assert.deepEqual(delivered.completion.deferred.map((item) => item.id), ['C2'])
    assert.equal(delivered.completion.achieved, 1)
    assert.equal(delivered.completion.total, 2)

    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.task.deliveredDegraded, true)
    assert.deepEqual(status.deferred, ['C2'])
    assert.equal(status.criteria.find((item) => item.id === 'C2').status, 'deferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 手工证据

test('collectManualEvidence：缺失 / 空文件 / 正常文件（bytes + sha256）', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-evidence-'))
  try {
    writeFileSync(path.join(root, 'shot.txt'), '截图说明：空态居中\n')
    writeFileSync(path.join(root, 'empty.txt'), '')
    const content = readFileSync(path.join(root, 'shot.txt'))
    const results = collectManualEvidence({
      root,
      criteria: [
        { id: 'C1', verify: 'manual', evidenceFile: 'shot.txt' },
        { id: 'C2', verify: 'manual', evidenceFile: 'empty.txt' },
        { id: 'C3', verify: 'manual', evidenceFile: 'missing.txt' },
        { id: 'C4', verify: 'gate' },
      ],
    })

    assert.equal(results.length, 3, '只收集 manual 或挂了 evidenceFile 的条件')
    assert.equal(results[0].ok, true)
    assert.equal(results[0].bytes, content.length)
    assert.equal(results[0].sha256, createHash('sha256').update(content).digest('hex'))
    assert.equal(results[1].ok, false)
    assert.equal(results[1].reason, 'empty')
    assert.equal(results[2].ok, false)
    assert.equal(results[2].reason, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('coverage 严格模式要求 manual 证据 ok；warn 允许降级覆盖', () => {
  const base = [
    { type: 'task.started', taskId: 'T-1', title: 't', goal: 'g' },
    {
      type: 'criteria.declared',
      criteria: [
        { id: 'C1', text: '手工验证', type: 'ui', source: '设计稿', verify: 'manual', evidenceFile: 'shot.txt' },
      ],
    },
    { type: 'plan.written', steps: ['s'] },
  ]
  const manualOk = (ok) => ({ type: 'gate.recorded', evidence: { id: 'E1', ok: true, manual: [{ criterionId: 'C1', file: 'shot.txt', ok }] } })

  const good = reduce(events([...base, manualOk(true)]))
  assert.equal(coverage(good, 'enforce')[0].status, 'covered')

  const bad = reduce(events([...base, manualOk(false)]))
  assert.equal(coverage(bad, 'enforce')[0].status, 'pending')
  assert.equal(coverage(bad, 'warn')[0].status, 'covered')
})

test('门禁要求手工证据：缺失/为空被拦，补齐后交付并写快照', async () => {
  const root = makeRepo()
  try {
    const evidenceFile = 'evidence/empty-state.txt'
    await startTask(root, [
      { text: '空态截图已确认', type: 'ui', source: '设计稿', verify: 'manual', evidenceFile },
    ])

    const missing = await callTool({ root, name: 'task_gate' })
    assert.equal(missing.stage, 'verify')
    assert.ok(missing.blockers.some((item) => /手工证据 C1/.test(item)), JSON.stringify(missing.blockers))

    mkdirSync(path.join(root, 'evidence'), { recursive: true })
    writeFileSync(path.join(root, evidenceFile), '')
    const empty = await callTool({ root, name: 'task_gate' })
    assert.equal(empty.stage, 'verify', '空文件不能作为证据')

    const text = '截图说明：空态居中，已与设计确认\n'
    writeFileSync(path.join(root, evidenceFile), text)
    const delivered = await callTool({ root, name: 'task_gate' })
    assert.equal(delivered.stage, 'deliver')
    assert.ok(delivered.evidencePath, '门禁应返回快照路径')

    const snapshotFile = path.join(root, delivered.evidencePath)
    assert.ok(existsSync(snapshotFile))
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    assert.equal(snapshot.evidenceId, delivered.evidenceId)
    assert.equal(snapshot.manual[0].file, evidenceFile)
    assert.equal(snapshot.manual[0].bytes, Buffer.byteLength(text))
    assert.match(snapshot.manual[0].sha256, /^[0-9a-f]{64}$/)
    assert.ok(snapshot.completion)
    assert.ok(Array.isArray(snapshot.violations))

    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.lastEvidencePath, delivered.evidencePath)
    assert.equal(status.evidence.at(-1).manual[0].bytes, Buffer.byteLength(text))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify=warn 时手工证据缺失允许交付但标记 degraded', async () => {
  const root = makeRepo({ stages: { contract: 'enforce', plan: 'enforce', verify: 'warn' } })
  try {
    await startTask(root, [
      { text: '视觉走查', type: 'ui', source: '设计稿', verify: 'manual', evidenceFile: 'evidence/shot.txt' },
    ])
    const gate = await callTool({ root, name: 'task_gate' })
    assert.equal(gate.stage, 'deliver')
    const status = await callTool({ root, name: 'task_status' })
    assert.equal(status.task.deliveredDegraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('快照写入失败只返回 null，不改变门禁结论', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-snapshot-'))
  try {
    const notDir = path.join(root, 'not-a-dir')
    writeFileSync(notDir, 'x')
    const result = writeEvidenceSnapshot({
      root: notDir,
      taskId: 'T-1',
      evidence: { evidenceId: 'E1', ok: true },
    })
    assert.equal(result, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
