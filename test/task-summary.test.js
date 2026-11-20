import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 0.3.x B3：task events --summary 只读聚合一件事：事件构成、门禁、拒绝、条件、交付。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-summary-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeTask(app, events) {
  mkdirSync(path.join(app, '.fe-guard'), { recursive: true })
  writeFileSync(
    path.join(app, '.fe-guard/task.json'),
    `${JSON.stringify({ version: 1, taskId: events.length > 0 ? 'T1' : null, events }, null, 2)}\n`,
  )
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const EVENTS = [
  { seq: 1, at: '2026-11-20T01:00:00.000Z', type: 'task.started', taskId: 'T1', title: 'demo', goal: 'g' },
  {
    seq: 2,
    at: '2026-11-20T01:01:00.000Z',
    type: 'criteria.declared',
    criteria: [
      { id: 'C1', text: 'a' },
      { id: 'C2', text: 'b', testFile: 'test/x.test.js' },
    ],
  },
  { seq: 3, at: '2026-11-20T01:02:00.000Z', type: 'plan.written', steps: [{ text: 'step' }] },
  {
    seq: 4,
    at: '2026-11-20T01:03:00.000Z',
    type: 'gate.recorded',
    evidence: { id: 'E1', kind: 'gate', mode: 'staged', ok: false, exitCode: 1, summary: { known: 0, new: 2, newErrors: 2 } },
  },
  { seq: 5, at: '2026-11-20T01:04:00.000Z', type: 'tool.rejected', tool: 'task_gate', reason: '验收条件未全部覆盖' },
  {
    seq: 6,
    at: '2026-11-20T01:05:00.000Z',
    type: 'gate.recorded',
    evidence: { id: 'E2', kind: 'gate', mode: 'full', ok: true, exitCode: 0, summary: { known: 0, new: 0, newErrors: 0 } },
  },
  { seq: 7, at: '2026-11-20T01:06:00.000Z', type: 'task.delivered', degraded: false },
]

test('事件摘要：事件构成 / 门禁 / 拒绝 / 条件 / 交付', () => {
  const app = tempDir('digest')
  writeTask(app, EVENTS)

  const run = cli(app, ['task', 'events', '--summary', '--json'])
  assert.equal(run.code, 0, run.err)
  const digest = JSON.parse(run.out)
  assert.equal(digest.taskId, 'T1')
  assert.equal(digest.eventCount, 7)
  assert.equal(digest.byType['gate.recorded'], 2)
  assert.equal(digest.byType['tool.rejected'], 1)
  assert.equal(digest.gates.total, 2)
  assert.equal(digest.gates.passed, 1)
  assert.equal(digest.gates.failed, 1)
  assert.deepEqual(digest.gates.modes, { staged: 1, full: 1 })
  assert.equal(digest.gates.lastOk, true)
  assert.equal(digest.gates.maxNew, 2)
  assert.equal(digest.gates.totalNew, 2)
  assert.equal(digest.rejections.total, 1)
  assert.equal(digest.rejections.byTool.task_gate, 1)
  assert.equal(digest.rejections.topReasons[0].count, 1)
  assert.match(digest.rejections.topReasons[0].reason, /验收条件未全部覆盖/)
  assert.equal(digest.criteria.declared, 2)
  assert.equal(digest.criteria.withTest, 1)
  assert.equal(digest.criteria.covered, 1, '只有 C1 被通过的门禁覆盖；C2 挂了测试但证据里没有测试结果')
  assert.equal(digest.delivery.delivered, true)
  assert.equal(digest.delivery.degraded, false)
  assert.equal(digest.delivery.gatesBeforeDelivery, 2)

  const text = cli(app, ['task', 'events', '--summary'])
  assert.equal(text.code, 0)
  assert.match(text.out, /事件摘要：7 个事件/)
  assert.match(text.out, /门禁: 2 次（通过 1 \/ 失败 1）/)
  assert.match(text.out, /拒绝: 1 次/)
  assert.match(text.out, /交付: 已交付/)
})

test('没有事件时保持原文案', () => {
  const app = tempDir('empty')
  writeTask(app, [])
  const run = cli(app, ['task', 'events', '--summary'])
  assert.equal(run.code, 0)
  assert.match(run.out, /没有事件。/)
})

test('--summary 只能搭配 events', () => {
  const app = tempDir('wrong-action')
  writeTask(app, EVENTS)
  const run = cli(app, ['task', 'status', '--summary'])
  assert.equal(run.code, 2)
  assert.match(run.err, /--summary 只用于 task events/)
})
