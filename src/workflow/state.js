import path from 'node:path'
import { readJsonFile, toPosix, writeJsonFile, UserError } from '../utils.js'

export const TASK_FILE = '.fe-guard/task.json'
export const ARCHIVE_DIR = '.fe-guard/tasks'

/**
 * 任务状态只存"事件"，当前阶段/条件达成情况全部由 reduce() 从事件推导。
 * 这样模型无法直接写 stage；任何人重放事件都能得到同一结果（可审计、可回放）。
 */
export function loadTask(root) {
  const raw = readJsonFile(path.join(root, TASK_FILE), { version: 1, taskId: null, events: [] })
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) {
    throw new UserError(`${TASK_FILE} 格式损坏：缺少 events 数组`)
  }
  return { version: 1, taskId: raw.taskId ?? null, events: raw.events }
}

export function saveTask(root, data) {
  writeJsonFile(path.join(root, TASK_FILE), {
    version: 1,
    taskId: data.taskId,
    updatedAt: new Date().toISOString(),
    events: data.events,
  })
}

export function appendEvent(data, type, payload = {}) {
  const event = { seq: data.events.length + 1, at: new Date().toISOString(), type, ...payload }
  data.events.push(event)
  return event
}

export function emptyTask() {
  return { version: 1, taskId: null, events: [] }
}

/** 归档到 .fe-guard/tasks/，保证"重来"不会丢失历史事件（可审计）。 */
export function archiveTask(root, data) {
  if (!data?.events?.length) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const relative = path.join(ARCHIVE_DIR, `${data.taskId ?? 'untitled'}-${stamp}.json`)
  writeJsonFile(path.join(root, relative), {
    version: 1,
    taskId: data.taskId ?? null,
    archivedAt: new Date().toISOString(),
    events: data.events,
  })
  return toPosix(relative)
}

export function reduce(events) {
  const state = {
    taskId: null,
    title: '',
    goal: '',
    outOfScope: '',
    constraints: '',
    startedAt: null,
    criteria: [],
    plan: null,
    evidence: [],
    delivered: null,
    rejections: 0,
    eventCount: events.length,
  }

  for (const event of events) {
    switch (event.type) {
      case 'task.started':
        state.taskId = event.taskId
        state.title = event.title
        state.goal = event.goal
        state.outOfScope = event.outOfScope ?? ''
        state.constraints = event.constraints ?? ''
        state.startedAt = event.at
        break
      case 'criteria.declared':
        for (const criterion of event.criteria ?? []) {
          state.criteria.push({ ...criterion, seq: event.seq, createdAt: event.at })
        }
        break
      case 'plan.written':
        state.plan = { steps: event.steps ?? [], seq: event.seq, createdAt: event.at }
        break
      case 'gate.recorded':
        if (event.evidence) state.evidence.push({ ...event.evidence, seq: event.seq, at: event.at })
        break
      case 'task.delivered':
        state.delivered = { at: event.at, seq: event.seq, degraded: Boolean(event.degraded) }
        break
      case 'tool.rejected':
        state.rejections += 1
        break
      default:
        break
    }
  }

  state.stage = deriveStage(state)
  return state
}

/** 阶段完全由事件推导：没有"把阶段设为 X"的入口。 */
export function deriveStage(state) {
  if (!state.taskId) return 'none'
  if (state.delivered) return 'deliver'
  if (state.evidence.length > 0) return 'verify'
  if (state.plan) return 'implement'
  if (state.criteria.length > 0) return 'plan'
  return 'contract'
}

/**
 * 验收条件只能由「条件创建之后产生的门禁证据」覆盖。
 * enforce 模式要求证据本身通过；warn/off 模式允许失败的证据覆盖（并标记 degraded）。
 * 挂 testFile 的条件在 enforce 下还要求该条件的测试真实跑过且通过（语义绑定）。
 */
export function coverage(state, level = 'enforce') {
  const strict = level === 'enforce'
  return state.criteria.map((criterion) => {
    const evidence = state.evidence.find((item) => {
      if (item.seq <= criterion.seq || (strict && !item.ok)) return false
      if (strict && criterion.testFile) {
        return (item.tests ?? []).some((test) => test.criterionId === criterion.id && test.ok)
      }
      return true
    })
    return { criterion, evidence: evidence ?? null }
  })
}
