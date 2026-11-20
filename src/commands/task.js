import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  TASK_FILE,
  archiveTask,
  coverage,
  emptyTask,
  loadTask,
  reduce,
  saveTask,
} from '../workflow/state.js'
import { loadConfig, stageLevel } from '../config.js'
import { UserError } from '../utils.js'

const ACTIONS = ['status', 'events', 'reset']

/**
 * 任务审计入口。只读 + 重置，不提供"推进阶段"的能力：
 * 阶段永远由 events 推导，命令行也不能把任务标成完成。
 */
export async function taskCommand({ root, action = 'status', yes, json, summary }) {
  if (!ACTIONS.includes(action)) {
    throw new UserError(`task 只支持 ${ACTIONS.join(' / ')}，当前为 "${action}"`)
  }
  if (summary && action !== 'events') {
    throw new UserError('--summary 只用于 task events')
  }

  const file = path.join(root, TASK_FILE)
  if (action === 'reset') {
    if (!yes) throw new UserError('重置会归档当前任务事件。确认请加 --yes')
    if (!existsSync(file)) {
      console.log('没有进行中的任务，无需重置。')
      return 0
    }
    const data = loadTask(root)
    const archive = archiveTask(root, data)
    saveTask(root, emptyTask())
    console.log(archive ? `已归档到 ${archive}，任务状态已清空。` : '任务状态已清空（没有事件可归档）。')
    return 0
  }

  const data = loadTask(root)
  const state = reduce(data.events)

  if (action === 'events') {
    if (summary) {
      const level = stageLevel(tryConfig(root), 'verify')
      const digest = summarizeEvents(data, state, level)
      if (json) {
        console.log(JSON.stringify(digest, null, 2))
      } else if (data.events.length === 0) {
        console.log('没有事件。')
      } else {
        console.log(formatSummary(digest))
      }
      return 0
    }
    if (json) {
      console.log(JSON.stringify({ taskId: data.taskId, events: data.events }, null, 2))
      return 0
    }
    if (data.events.length === 0) {
      console.log('没有事件。')
      return 0
    }
    console.log(`任务 ${data.taskId ?? '(无)'} 共 ${data.events.length} 个事件：`)
    data.events.forEach((event) => {
      const extra =
        event.type === 'gate.recorded'
          ? `ok=${event.evidence?.ok} new=${event.evidence?.summary?.new}`
          : event.type === 'tool.rejected'
            ? `${event.tool}: ${event.reason}`
            : event.type === 'criteria.declared'
              ? event.criteria?.map((criterion) => criterion.id).join(',')
              : event.type === 'plan.written'
                ? `${event.steps?.length} 步`
                : ''
      console.log(`  #${event.seq} ${event.at} ${event.type}${extra ? `  ${extra}` : ''}`)
    })
    return 0
  }

  if (json) {
    console.log(JSON.stringify(state, null, 2))
    return 0
  }

  if (!state.taskId) {
    console.log('没有进行中的任务。在 AI IDE 里调用 task_start，或直接运行 npx fe-guard check。')
    return 0
  }

  const level = stageLevel(tryConfig(root), 'verify')
  const covered = coverage(state, level)
  const achieved = covered.filter((item) => item.evidence).length
  console.log(`任务 ${state.taskId}  ${state.title}`)
  console.log(`阶段: ${state.stage}   状态: ${state.delivered ? 'delivered' : 'active'}   事件: ${state.eventCount}`)
  console.log(`验收条件: ${achieved}/${covered.length} 有门禁证据`)
  covered.forEach((item) => {
    const test = item.criterion.testFile ? `  [test ${item.criterion.testFile}]` : ''
    console.log(`  ${item.evidence ? '✓' : '·'} ${item.criterion.id} ${item.criterion.text}${test}${item.evidence ? `  (${item.evidence.id})` : ''}`)
  })
  console.log(`门禁证据: ${state.evidence.length} 条${state.evidence.length > 0 ? `，最近一次 ${state.evidence.at(-1).ok ? '通过' : '未通过'}` : ''}`)
  if (state.rejections > 0) console.log(`被拒绝的工具调用: ${state.rejections} 次（见 npx fe-guard task events）`)
  return 0
}

/** 配置坏了也不该让 task status 崩掉，只是拿不到 verify 的降级等级。 */
function tryConfig(root) {
  try {
    return loadConfig(root)
  } catch {
    return { workflow: { stages: { verify: 'enforce' } } }
  }
}

/** task events --summary：只读聚合，不新增任何状态。 */
export function summarizeEvents(data, state, level = 'enforce') {
  const byType = {}
  for (const event of data.events) byType[event.type] = (byType[event.type] ?? 0) + 1

  const gates = state.evidence
  const modes = {}
  for (const gate of gates) modes[gate.mode ?? 'unknown'] = (modes[gate.mode ?? 'unknown'] ?? 0) + 1
  const newCounts = gates.map((gate) => gate.summary?.new ?? 0)

  const byTool = {}
  const reasons = new Map()
  let rejected = 0
  for (const event of data.events) {
    if (event.type !== 'tool.rejected') continue
    rejected += 1
    byTool[event.tool] = (byTool[event.tool] ?? 0) + 1
    const key = `${event.tool ?? '?'} — ${event.reason ?? '未给出原因'}`
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  const topReasons = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5)

  const covered = coverage(state, level)
  const achieved = covered.filter((item) => item.evidence).length

  return {
    taskId: data.taskId,
    eventCount: data.events.length,
    firstAt: data.events[0]?.at ?? null,
    lastAt: data.events.at(-1)?.at ?? null,
    byType,
    gates: {
      total: gates.length,
      passed: gates.filter((gate) => gate.ok).length,
      failed: gates.filter((gate) => !gate.ok).length,
      modes,
      lastOk: gates.length > 0 ? Boolean(gates.at(-1).ok) : null,
      maxNew: newCounts.length > 0 ? Math.max(...newCounts) : 0,
      totalNew: newCounts.reduce((sum, count) => sum + count, 0),
    },
    rejections: { total: rejected, byTool, topReasons },
    criteria: {
      declared: state.criteria.length,
      covered: achieved,
      withTest: state.criteria.filter((criterion) => criterion.testFile).length,
      level,
    },
    delivery: {
      delivered: Boolean(state.delivered),
      degraded: Boolean(state.delivered?.degraded),
      gatesBeforeDelivery: state.delivered ? gates.filter((gate) => gate.seq < state.delivered.seq).length : null,
    },
  }
}

function formatSummary(digest) {
  const gates = digest.gates
  const lines = [
    `任务 ${digest.taskId ?? '(无)'} 事件摘要：${digest.eventCount} 个事件` +
      (digest.firstAt ? `（${digest.firstAt} → ${digest.lastAt}）` : ''),
    `事件构成: ${Object.entries(digest.byType).map(([type, count]) => `${type} ${count}`).join('、') || '无'}`,
    gates.total > 0
      ? `门禁: ${gates.total} 次（通过 ${gates.passed} / 失败 ${gates.failed}），` +
        `mode: ${Object.entries(gates.modes).map(([mode, count]) => `${mode} ${count}`).join('、') || '未知'}；` +
        `最近一次${gates.lastOk ? '通过' : '未通过'}；单次新增最多 ${gates.maxNew} 条，累计 ${gates.totalNew} 条`
      : '门禁: 还没有记录',
    `拒绝: ${digest.rejections.total} 次` +
      (Object.keys(digest.rejections.byTool).length > 0
        ? `（${Object.entries(digest.rejections.byTool).map(([tool, count]) => `${tool} ${count}`).join('、')}）`
        : ''),
  ]
  digest.rejections.topReasons.forEach((item) => lines.push(`  ${item.reason}  ×${item.count}`))
  lines.push(
    `条件: ${digest.criteria.declared} 条，${digest.criteria.covered} 条有门禁证据` +
      `${digest.criteria.withTest > 0 ? `，${digest.criteria.withTest} 条挂测试` : ''}（${digest.criteria.level}）`,
  )
  lines.push(
    digest.delivery.delivered
      ? `交付: 已交付${digest.delivery.degraded ? '（degraded：门禁未完全通过或测试未过）' : ''}，` +
        `交付前门禁 ${digest.delivery.gatesBeforeDelivery} 次`
      : '交付: 尚未交付',
  )
  return lines.join('\n')
}
