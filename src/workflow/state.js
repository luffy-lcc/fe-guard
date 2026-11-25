import path from 'node:path'
import { readJsonFile, toPosix, writeJsonFile, UserError } from '../utils.js'
import { verifyMode } from './criteria.js'

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
    confirmations: [],
    deferrals: [],
    lessons: [],
    preflight: null,
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
        state.preflight = event.preflight ?? null
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
        // 门禁每次都会复检预检：成功门禁也刷新「最近一次预检结果」。
        if (event.evidence?.preflight) state.preflight = event.evidence.preflight
        break
      case 'task.delivered':
        state.delivered = { at: event.at, seq: event.seq, degraded: Boolean(event.degraded) }
        break
      case 'criterion.confirmed':
        if (event.criterionId) {
          state.confirmations.push({
            criterionId: event.criterionId,
            note: event.note ?? '',
            seq: event.seq,
            at: event.at,
          })
        }
        break
      case 'criterion.deferred':
        if (event.criterionId) {
          state.deferrals.push({
            criterionId: event.criterionId,
            reason: event.reason ?? '',
            seq: event.seq,
            at: event.at,
          })
        }
        break
      case 'lesson.recorded':
        if (event.lesson) state.lessons.push({ ...event.lesson, seq: event.seq, at: event.at })
        break
      case 'preflight.failed':
        state.preflight = event.preflight ?? null
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

/** 确认事件必须晚于条件创建才有效：不能拿旧任务的确认记录放行新条件。 */
export function isConfirmed(state, criterion) {
  return (state.confirmations ?? []).some(
    (item) => item.criterionId === criterion.id && item.seq > (criterion.seq ?? 0),
  )
}

/** defer 同理：只认条件创建之后的人工决定。 */
export function isDeferred(state, criterion) {
  return (state.deferrals ?? []).some(
    (item) => item.criterionId === criterion.id && item.seq > (criterion.seq ?? 0),
  )
}

/**
 * 最近一次失败门禁之后是否还缺复盘：
 * 失败门禁只认 evidence.ok=false（预检失败不产生证据，不在此列）；
 * 复盘事件必须晚于那次失败，否则视为「失败之后没有复盘」。
 */
export function needsLesson(state) {
  const lastFailed = (state.evidence ?? []).filter((item) => !item.ok).at(-1)
  if (!lastFailed) return false
  const lastLesson = (state.lessons ?? []).at(-1)
  return !lastLesson || lastLesson.seq < lastFailed.seq
}

/**
 * 验收条件的覆盖情况由「条件创建之后的门禁证据」决定。
 * enforce 模式要求证据本身通过；warn/off 模式允许失败的证据覆盖（并标记 degraded）。
 * test 条件要求该条件的测试真实跑过且通过；manual 条件要求手工证据存在且非空（strict）。
 * deferred 的条件不要求证据，但状态会是 deferred，不计入完成。
 */
export function coverage(state, level = 'enforce') {
  const strict = level === 'enforce'
  return state.criteria.map((criterion) => {
    const deferred = isDeferred(state, criterion)
    const evidence = state.evidence.find((item) => {
      if (item.seq <= criterion.seq || (strict && !item.ok)) return false
      if (strict) {
        const mode = verifyMode(criterion)
        if (mode === 'test') {
          return (item.tests ?? []).some((test) => test.criterionId === criterion.id && test.ok)
        }
        if (mode === 'manual') {
          return (item.manual ?? []).some((result) => result.criterionId === criterion.id && result.ok)
        }
      }
      return true
    })
    const status = deferred ? 'deferred' : evidence ? 'covered' : 'pending'
    return { criterion, evidence: evidence ?? null, deferred, status }
  })
}

/**
 * 完成度：covered 才算完成；deferred 单列待办；其余是 remaining。
 * 这样「2 完成 / 1 待办」不会被误读为全部完成。
 */
export function completion(state, level = 'enforce') {
  const covered = coverage(state, level)
  const deferrals = state.deferrals ?? []
  return {
    achieved: covered.filter((item) => item.status === 'covered').length,
    total: covered.length,
    remaining: covered
      .filter((item) => item.status === 'pending')
      .map((item) => ({ id: item.criterion.id, text: item.criterion.text })),
    deferred: covered
      .filter((item) => item.status === 'deferred')
      .map((item) => {
        const record = deferrals.filter((entry) => entry.criterionId === item.criterion.id).at(-1)
        return { id: item.criterion.id, text: item.criterion.text, reason: record?.reason ?? '' }
      }),
  }
}
