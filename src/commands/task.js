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
export async function taskCommand({ root, action = 'status', yes, json }) {
  if (!ACTIONS.includes(action)) {
    throw new UserError(`task 只支持 ${ACTIONS.join(' / ')}，当前为 "${action}"`)
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
