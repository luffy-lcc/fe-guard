import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  TASK_FILE,
  appendEvent,
  archiveTask,
  completion,
  coverage,
  emptyTask,
  isConfirmed,
  isDeferred,
  loadTask,
  needsLesson,
  reduce,
  saveTask,
} from '../workflow/state.js'
import { isAssumption, verifyMode } from '../workflow/criteria.js'
import { collectStats } from '../workflow/statistics.js'
import { loadConfig, stageLevel } from '../config.js'
import { UserError } from '../utils.js'

const ACTIONS = ['status', 'events', 'reset', 'confirm', 'defer', 'stats']

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * 任务审计入口。status/events/reset 只读或重置；
 * confirm/defer 只追加人工决策事件，不提供"推进阶段"的能力：
 * 阶段永远由 events 推导，命令行也不能把任务标成完成。
 */
export async function taskCommand({ root, action = 'status', yes, json, summary, criterionId, note, reason }) {
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

  if (action === 'confirm') {
    return confirmCriterion(root, { yes, json, criterionId, note })
  }
  if (action === 'defer') {
    return deferCriterion(root, { yes, json, criterionId, reason })
  }
  // 统计是只读的：不要求当前存在进行中的任务，也不修改任何状态。
  if (action === 'stats') {
    return taskStats(root, { json })
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
      const extra = eventExtra(event)
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

  printStatus(root, state)
  return 0
}

/** task status 的人类可读输出；抽出来是为了让 taskCommand 只负责分派与校验。 */
function printStatus(root, state) {
  const level = stageLevel(tryConfig(root), 'verify')
  const covered = coverage(state, level)
  const progress = completion(state, level)
  const deferredReasons = new Map(progress.deferred.map((item) => [item.id, item.reason]))

  console.log(`任务 ${state.taskId}  ${state.title}`)
  console.log(`阶段: ${state.stage}   状态: ${state.delivered ? 'delivered' : 'active'}   事件: ${state.eventCount}`)
  console.log(
    `验收条件: ${progress.achieved}/${progress.total} 完成` +
      `${progress.deferred.length > 0 ? `，${progress.deferred.length} 条待办` : ''}` +
      `${progress.remaining.length > 0 ? `，${progress.remaining.length} 条未完成` : ''}`,
  )
  covered.forEach((item) => {
    const criterion = item.criterion
    const mark = item.status === 'covered' ? '✓' : item.status === 'deferred' ? '⏸' : '·'
    const meta = `[${criterion.type ?? 'unknown'}/${verifyMode(criterion)}]`
    const test = criterion.testFile ? `  [test ${criterion.testFile}]` : ''
    const evidenceFile = criterion.evidenceFile ? `  [evidence ${criterion.evidenceFile}]` : ''
    const tail =
      item.status === 'deferred'
        ? `  (待办：${clip(deferredReasons.get(criterion.id) ?? '', 80)})`
        : item.evidence
          ? `  (${item.evidence.id})`
          : ''
    console.log(`  ${mark} ${criterion.id} ${criterion.text} ${meta}${test}${evidenceFile}${tail}`)
    if (
      item.status !== 'deferred' &&
      isAssumption(criterion.source) &&
      !isConfirmed(state, criterion)
    ) {
      console.log(`      ⚠ 推断项待人工确认：npx fe-guard task confirm ${criterion.id} --note "..." --yes`)
    }
  })
  console.log(`门禁证据: ${state.evidence.length} 条${state.evidence.length > 0 ? `，最近一次 ${state.evidence.at(-1).ok ? '通过' : '未通过'}` : ''}`)
  if (state.lessons.length > 0) {
    console.log(`复盘: ${state.lessons.length} 条，最近 ${clip(state.lessons.at(-1).text, 80)}`)
  } else if (needsLesson(state)) {
    console.log('复盘: 最近一次失败门禁后还没有复盘（在 AI IDE 里调用 task_lesson）')
  }
  if (state.preflight?.configured) {
    console.log(`环境预检: ${state.preflight.ok ? '通过' : '未通过'}（${state.preflight.command}）`)
  }
  if (state.rejections > 0) console.log(`被拒绝的工具调用: ${state.rejections} 次（见 npx fe-guard task events）`)
}

/** 只读统计：当前任务 + 归档，用数字看流程效果。 */
function taskStats(root, { json }) {
  const stats = collectStats(root, { level: stageLevel(tryConfig(root), 'verify') })
  if (json) {
    console.log(JSON.stringify(stats, null, 2))
    return 0
  }

  const totals = stats.totals
  console.log(
    `任务统计: ${totals.tasks} 个（交付 ${totals.delivered} / 降级 ${totals.degraded} / 进行中 ${totals.active}）`,
  )
  console.log(
    `门禁: ${totals.gates} 次，失败 ${totals.failedGates} 次（失败率 ${(totals.failureRate * 100).toFixed(1)}%），` +
      `平均每任务 ${totals.avgGatesPerTask.toFixed(2)} 次`,
  )
  console.log(
    `复盘: ${totals.lessons} 条；待办: ${totals.deferred} 条` +
      `${totals.corrupt > 0 ? `；损坏文件: ${totals.corrupt} 个（已跳过）` : ''}`,
  )
  if (stats.topBlockers.length === 0) {
    console.log('top blocker: 无')
  } else {
    console.log('top blocker:')
    stats.topBlockers.forEach((item) => console.log(`  ${item.ruleId} ×${item.count}`))
  }
  return 0
}

/** 人工确认推断项：只接受 assumption 条件，且确认必须发生在条件创建之后。 */
function confirmCriterion(root, { yes, json, criterionId, note }) {
  if (!yes) throw new UserError('确认推断项会让任务可以交付。确认请加 --yes')
  const text = String(note ?? '').trim()
  if (!text) throw new UserError('task confirm 需要 --note 说明人工确认的依据')
  const id = String(criterionId ?? '').trim()
  if (!id) throw new UserError('task confirm 需要条件 id，例如：npx fe-guard task confirm C2 --note "..." --yes')

  const data = loadTask(root)
  const state = reduce(data.events)
  if (!state.taskId) throw new UserError('没有进行中的任务。')
  if (state.delivered) throw new UserError('任务已交付，不能修改条件状态。')
  const criterion = state.criteria.find((item) => item.id === id)
  if (!criterion) {
    throw new UserError(`没有验收条件 "${id}"。可用：${state.criteria.map((item) => item.id).join(', ') || '无'}`)
  }
  if (!isAssumption(criterion.source)) {
    throw new UserError(`条件 ${id} 的 source 不是 assumption，不需要人工确认`)
  }
  if (isConfirmed(state, criterion)) throw new UserError(`条件 ${id} 已经确认过`)

  appendEvent(data, 'criterion.confirmed', { criterionId: id, note: clip(text, 300) })
  saveTask(root, data)
  if (json) {
    console.log(JSON.stringify({ ok: true, action: 'confirm', criterionId: id, note: clip(text, 300) }, null, 2))
  } else {
    console.log(`已确认推断项 ${id}：${clip(text, 300)}`)
  }
  return 0
}

/** 明确放弃 / 转上线待办：只针对还没有门禁证据的条件，交付会标记 degraded。 */
function deferCriterion(root, { yes, json, criterionId, reason }) {
  if (!yes) throw new UserError('转为待办后交付会标记 degraded。确认请加 --yes')
  const text = String(reason ?? '').trim()
  if (!text) throw new UserError('task defer 需要 --reason 说明放弃或转待办的原因')
  const id = String(criterionId ?? '').trim()
  if (!id) throw new UserError('task defer 需要条件 id，例如：npx fe-guard task defer C3 --reason "..." --yes')

  const data = loadTask(root)
  const state = reduce(data.events)
  if (!state.taskId) throw new UserError('没有进行中的任务。')
  if (state.delivered) throw new UserError('任务已交付，不能修改条件状态。')
  const criterion = state.criteria.find((item) => item.id === id)
  if (!criterion) {
    throw new UserError(`没有验收条件 "${id}"。可用：${state.criteria.map((item) => item.id).join(', ') || '无'}`)
  }
  if (isDeferred(state, criterion)) throw new UserError(`条件 ${id} 已经转为待办`)
  const level = stageLevel(tryConfig(root), 'verify')
  const item = coverage(state, level).find((entry) => entry.criterion.id === id)
  if (item?.status === 'covered') {
    throw new UserError(`条件 ${id} 已有门禁证据覆盖，不需要转为待办`)
  }

  appendEvent(data, 'criterion.deferred', { criterionId: id, reason: clip(text, 300) })
  saveTask(root, data)
  if (json) {
    console.log(JSON.stringify({ ok: true, action: 'defer', criterionId: id, reason: clip(text, 300) }, null, 2))
  } else {
    console.log(`已把 ${id} 转为待办：${clip(text, 300)}`)
  }
  return 0
}

function eventExtra(event) {
  switch (event.type) {
    case 'gate.recorded':
      return `ok=${event.evidence?.ok} new=${event.evidence?.summary?.new}`
    case 'tool.rejected':
      return `${event.tool}: ${event.reason}`
    case 'criteria.declared':
      return event.criteria?.map((criterion) => criterion.id).join(',')
    case 'plan.written':
      return `${event.steps?.length} 步`
    case 'criterion.confirmed':
      return `${event.criterionId} ${event.note ?? ''}`
    case 'criterion.deferred':
      return `${event.criterionId} ${event.reason ?? ''}`
    case 'task.delivered':
      return event.degraded ? 'degraded' : 'ok'
    case 'lesson.recorded':
      return `${event.lesson?.id ?? '?'} ${event.lesson?.scope ?? ''} ${clip(event.lesson?.text ?? '', 60)}`
    case 'preflight.failed':
      return `${event.preflight?.command ?? ''} exit=${event.preflight?.exitCode ?? '?'}`
    case 'task.started':
      return event.preflight?.configured ? `预检 ${event.preflight.ok ? '通过' : '未通过'}` : ''
    default:
      return ''
  }
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

  const progress = completion(state, level)
  const byScope = {}
  for (const lesson of state.lessons) {
    const scope = lesson.scope ?? 'unknown'
    byScope[scope] = (byScope[scope] ?? 0) + 1
  }

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
    confirmations: state.confirmations.length,
    deferrals: state.deferrals.length,
    lessons: { total: state.lessons.length, byScope },
    criteria: {
      declared: state.criteria.length,
      covered: progress.achieved,
      deferred: progress.deferred.length,
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
      `${digest.criteria.deferred > 0 ? `，${digest.criteria.deferred} 条待办` : ''}` +
      `${digest.criteria.withTest > 0 ? `，${digest.criteria.withTest} 条挂测试` : ''}（${digest.criteria.level}）`,
  )
  lines.push(`确认/待办: ${digest.confirmations} 次确认，${digest.deferrals} 条待办`)
  lines.push(
    `复盘: ${digest.lessons.total} 条` +
      (Object.keys(digest.lessons.byScope).length > 0
        ? `（${Object.entries(digest.lessons.byScope).map(([scope, count]) => `${scope} ${count}`).join('、')}）`
        : ''),
  )
  lines.push(
    digest.delivery.delivered
      ? `交付: 已交付${digest.delivery.degraded ? '（degraded：存在待办或证据未完全通过）' : ''}，` +
        `交付前门禁 ${digest.delivery.gatesBeforeDelivery} 次`
      : '交付: 尚未交付',
  )
  return lines.join('\n')
}
