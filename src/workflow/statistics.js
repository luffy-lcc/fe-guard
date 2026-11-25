import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ARCHIVE_DIR, TASK_FILE, completion, reduce } from './state.js'

const MAX_TOP_BLOCKERS = 5

/** 读取一个任务文件的事件数组；不存在、不是 JSON 或没有 events 时返回 null（由调用方计入 corrupt）。 */
function readEvents(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || !Array.isArray(raw.events)) return null
    return raw.events
  } catch {
    return null
  }
}

/**
 * 工作流效果统计：只读聚合当前任务与 .fe-guard/tasks/ 归档，不写任何文件。
 * 交付/降级、门禁失败率、平均门禁次数、top blocker、复盘与待办数量都从事件流重放得到，
 * 因此和 task.json 永远一致，也不会篡改状态。
 */
export function collectStats(root, { level = 'enforce' } = {}) {
  const tasks = []
  const blockerCounts = new Map()
  let corrupt = 0

  const record = (events, current) => {
    const state = reduce(events)
    if (!state.taskId) return
    const delivered = Boolean(state.delivered)
    // 历史事件可能没有 degraded 字段：交付时仍有未完成条件也按降级处理。
    const degraded = delivered && (state.delivered.degraded || completion(state, level).remaining.length > 0)
    tasks.push({
      id: state.taskId,
      current,
      delivered,
      degraded,
      gates: state.evidence.length,
      failedGates: state.evidence.filter((item) => !item.ok).length,
      lessons: state.lessons.length,
      deferred: state.deferrals.length,
    })
    for (const evidence of state.evidence) {
      for (const violation of evidence.violations ?? []) {
        if (!violation?.ruleId) continue
        blockerCounts.set(violation.ruleId, (blockerCounts.get(violation.ruleId) ?? 0) + 1)
      }
    }
  }

  const currentFile = path.join(root, TASK_FILE)
  if (existsSync(currentFile)) {
    const events = readEvents(currentFile)
    if (events) record(events, true)
    else corrupt += 1
  }

  const archiveDir = path.join(root, ARCHIVE_DIR)
  if (existsSync(archiveDir)) {
    const files = readdirSync(archiveDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const name of files) {
      const events = readEvents(path.join(archiveDir, name))
      if (!events) {
        corrupt += 1
        continue
      }
      record(events, false)
    }
  }

  const totals = {
    tasks: tasks.length,
    delivered: tasks.filter((item) => item.delivered).length,
    degraded: tasks.filter((item) => item.degraded).length,
    active: tasks.filter((item) => !item.delivered).length,
    gates: tasks.reduce((sum, item) => sum + item.gates, 0),
    failedGates: tasks.reduce((sum, item) => sum + item.failedGates, 0),
    lessons: tasks.reduce((sum, item) => sum + item.lessons, 0),
    deferred: tasks.reduce((sum, item) => sum + item.deferred, 0),
    corrupt,
    failureRate: 0,
    avgGatesPerTask: 0,
  }
  totals.failureRate = totals.gates > 0 ? totals.failedGates / totals.gates : 0
  totals.avgGatesPerTask = totals.tasks > 0 ? totals.gates / totals.tasks : 0

  const topBlockers = [...blockerCounts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
    .slice(0, MAX_TOP_BLOCKERS)

  return { tasks, totals, topBlockers }
}
