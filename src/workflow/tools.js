import path from 'node:path'
import { loadConfig, stageLevel } from '../config.js'
import { runCheckCore } from '../check-core.js'
import { buildInventory, lookupComponents, readInventory, writeInventory } from '../inventory.js'
import {
  appendEvent,
  archiveTask,
  completion,
  coverage,
  emptyTask,
  loadTask,
  needsLesson,
  reduce,
  saveTask,
} from './state.js'
import { countByType, isAssumption, normalizeCriteriaList, verifyMode } from './criteria.js'
import { testBlockers } from './tests.js'
import { TOOL_DEFINITIONS, listTools } from './definitions.js'
import { ToolError } from './errors.js'
import { pendingAssumptions, taskGate } from './gate.js'
import { appendLesson } from './lessons.js'
import { runPreflight } from './preflight.js'

export { TOOL_DEFINITIONS, listTools, ToolError }

const DEFAULT_INVENTORY = '.fe-guard/ui-inventory.json'

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const isText = (value) => typeof value === 'string' && value.trim().length > 0

function assertKeys(args, allowed, tool) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolError(`${tool} 不接受参数 "${key}"。允许的参数：${allowed.length ? allowed.join(', ') : '无'}`)
    }
  }
}

function readContext(root) {
  const data = loadTask(root)
  return { data, state: reduce(data.events) }
}

// ------------------------------------------------------------------ 工具实现

async function taskStart({ root, config, args }) {
  assertKeys(args, ['title', 'goal', 'outOfScope', 'constraints'], 'task_start')
  if (!isText(args.title) || !isText(args.goal)) throw new ToolError('task_start 需要 title 和 goal（非空字符串）')

  const { data, state } = readContext(root)
  if (state.taskId && !state.delivered) {
    throw new ToolError(
      `已有进行中的任务 ${state.taskId}（stage=${state.stage}）。先把当前任务走到交付；若要放弃，运行 npx fe-guard task reset --yes`,
    )
  }
  // 环境不对就不开始：预检失败不创建任务，也不动已经交付的旧任务。
  const preflight = await runPreflight({ root, config })
  if (!preflight.ok) {
    return {
      ok: false,
      stage: state.stage,
      preflight,
      next: 'task_start',
      hint: '环境预检未通过，未创建任务；修复后重试。',
    }
  }
  // 上一个任务已交付：自动归档后开启新任务，不必让用户手动清理。
  let task = data
  if (state.delivered) {
    archiveTask(root, data)
    task = emptyTask()
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 4)
  const taskId = `T-${stamp}-${suffix}`
  appendEvent(task, 'task.started', {
    taskId,
    title: clip(args.title, 120),
    goal: clip(args.goal, 600),
    outOfScope: clip(args.outOfScope ?? '', 400),
    constraints: clip(args.constraints ?? '', 400),
    preflight,
  })
  task.taskId = taskId
  saveTask(root, task)
  return {
    ok: true,
    taskId,
    stage: 'contract',
    next: 'task_criteria',
    hint: '下一步：调用 task_criteria 写至少 1 条验收条件。',
    ...(preflight.configured ? { preflight } : {}),
  }
}

async function taskCriteria({ root, config, args }) {
  assertKeys(args, ['criteria'], 'task_criteria')

  const { data, state } = readContext(root)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')

  const level = stageLevel(config, 'contract')
  if (state.stage !== 'contract' && level === 'enforce') {
    throw new ToolError(`验收条件只能在 contract 阶段写入（当前 ${state.stage}）。如需改条件，请新建任务。`)
  }

  let criteria
  try {
    criteria = normalizeCriteriaList({
      items: args.criteria,
      existingIds: new Set(state.criteria.map((criterion) => criterion.id)),
      nextIndex: { value: state.criteria.length },
    })
  } catch (error) {
    throw new ToolError(error.message)
  }

  appendEvent(data, 'criteria.declared', { criteria })
  saveTask(root, data)

  const nextState = reduce(data.events)
  const warnings = []
  if (state.stage !== 'contract') {
    warnings.push(`合同阶段为 ${level}，已允许在 ${state.stage} 阶段追加条件`)
  }
  if (nextState.criteria.length > 0 && nextState.criteria.every((criterion) => criterion.type === 'ui')) {
    warnings.push('当前条件全部为 ui：请检查是否漏了交互、数据、埋点、兼容或性能类条件')
  }

  return {
    ok: true,
    ids: criteria.map((criterion) => criterion.id),
    stage: nextState.stage,
    next: 'task_plan',
    types: countByType(nextState.criteria),
    assumptions: nextState.criteria.filter((criterion) => isAssumption(criterion.source)).map((criterion) => criterion.id),
    ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
  }
}

async function taskPlan({ root, config, args }) {
  assertKeys(args, ['steps'], 'task_plan')
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw new ToolError('task_plan 需要非空的 steps 数组')
  if (args.steps.length > 15) throw new ToolError('计划最多 15 步，请合并')

  const { data, state } = readContext(root)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')
  if (state.plan) throw new ToolError('计划已写入，不能重复写入。修改计划请新建任务。')

  const level = stageLevel(config, 'contract')
  if (state.criteria.length === 0 && level === 'enforce') {
    throw new ToolError('必须先写验收条件（task_criteria）再写计划；这是不允许跳过的合同阶段。')
  }

  const steps = args.steps.map((step, index) => {
    if (!isText(step)) throw new ToolError(`第 ${index + 1} 步内容为空`)
    return clip(step, 160)
  })
  appendEvent(data, 'plan.written', { steps })
  saveTask(root, data)
  return {
    ok: true,
    steps: steps.length,
    stage: 'implement',
    next: 'task_gate',
    hint: '下一步：实现代码，然后调用 task_gate 跑真实门禁。',
  }
}

async function taskNext({ root, config, args }) {
  assertKeys(args, [], 'task_next')
  const { state } = readContext(root)
  if (!state.taskId) {
    return {
      stage: 'none',
      status: 'idle',
      nextTool: 'task_start',
      nextAction: '调用 task_start 写入 title/goal（以及不做的事、约束）。',
      blockers: [],
    }
  }

  const level = stageLevel(config, 'verify')
  const progress = completion(state, level)
  const blockers = []

  if (state.preflight && !state.preflight.ok) {
    blockers.push('最近一次环境预检未通过：先修复环境，否则门禁不会执行')
  }

  if (state.stage === 'verify') {
    const last = state.evidence[state.evidence.length - 1]
    if (!last?.ok) blockers.push(`最近一次门禁未通过（新增 ${last?.summary?.new ?? '?'} 条），需修复后重跑`)
    const missing = progress.remaining.map((item) => item.id)
    if (missing.length > 0) blockers.push(`未完成的条件：${missing.slice(0, 5).join(', ')}`)
    const assumptions = pendingAssumptions(state, level)
    if (assumptions.length > 0) {
      blockers.push(
        `推断项未确认：${assumptions.slice(0, 3).map((criterion) => criterion.id).join(', ')}` +
          '（运行 npx fe-guard task confirm <id> --note "..." --yes）',
      )
    }
    blockers.push(...testBlockers(last?.tests ?? []))
  }
  if (state.criteria.length === 0) blockers.push('还没有验收条件')

  const guide = {
    contract: ['task_criteria', '写至少 1 条可被门禁证据覆盖的验收条件。'],
    plan: ['task_plan', '把实现拆成 1-15 步写入计划。'],
    implement: ['task_gate', '实现代码后调用 task_gate 跑真实门禁。'],
    verify: ['task_gate', '按 blockers 修复，然后再次调用 task_gate。'],
    deliver: ['task_start', '任务已交付；有新需求可直接调用 task_start（旧任务会自动归档）。'],
  }[state.stage] ?? ['task_status', '用 task_status 查看当前状态。']

  return {
    stage: state.stage,
    status: state.delivered ? 'delivered' : 'active',
    nextTool: guide[0],
    nextAction: guide[1],
    criteria: { total: progress.total, achieved: progress.achieved },
    blockers: blockers.slice(0, 5),
  }
}

async function taskStatus({ root, config, args }) {
  assertKeys(args, [], 'task_status')
  const { state } = readContext(root)
  if (!state.taskId) {
    return { active: false, hint: '没有进行中的任务，调用 task_start 开始。' }
  }

  const level = stageLevel(config, 'verify')
  const covered = coverage(state, level)
  const progress = completion(state, level)
  const deferredReasons = new Map(progress.deferred.map((item) => [item.id, item.reason]))

  return {
    active: true,
    task: {
      id: state.taskId,
      title: state.title,
      goal: clip(state.goal, 200),
      stage: state.stage,
      status: state.delivered ? 'delivered' : 'active',
      deliveredDegraded: state.delivered?.degraded ?? false,
    },
    criteria: covered.slice(0, 12).map((item) => ({
      id: item.criterion.id,
      text: clip(item.criterion.text, 80),
      type: item.criterion.type ?? 'unknown',
      source: clip(item.criterion.source ?? '', 80),
      verify: verifyMode(item.criterion),
      status: item.status,
      achievedBy: item.evidence?.id ?? null,
      ...(item.status === 'deferred' ? { deferReason: clip(deferredReasons.get(item.criterion.id) ?? '', 80) } : {}),
      ...(item.criterion.testFile ? { testFile: item.criterion.testFile } : {}),
      ...(item.criterion.evidenceFile ? { evidenceFile: item.criterion.evidenceFile } : {}),
    })),
    completion: progress,
    types: countByType(state.criteria),
    assumptions: state.criteria.filter((criterion) => isAssumption(criterion.source)).map((criterion) => criterion.id),
    confirmations: state.confirmations.map((item) => item.criterionId),
    deferred: progress.deferred.map((item) => item.id),
    lastEvidencePath: state.evidence.at(-1)?.evidencePath ?? null,
    lessons: state.lessons.slice(-3).map((item) => ({
      id: item.id,
      text: clip(item.text, 120),
      scope: item.scope,
      at: item.at,
    })),
    lessonRequired: needsLesson(state),
    preflight: state.preflight ?? null,
    planSteps: state.plan?.steps.length ?? 0,
    evidence: state.evidence.slice(-3).map((item) => ({
      id: item.id,
      ok: item.ok,
      exitCode: item.exitCode,
      mode: item.mode,
      at: item.at,
      summary: item.summary,
      ...(item.evidencePath ? { evidencePath: item.evidencePath } : {}),
      ...(item.manual?.length ? { manual: item.manual } : {}),
      ...(item.trend ? { trend: item.trend } : {}),
    })),
    rejectedCalls: state.rejections,
    events: state.eventCount,
    report: config.report.path,
  }
}

/**
 * 复盘：最近一次失败门禁之后必须写一条有证据的结论，否则 enforce 下不能交付。
 * 只记录，不自动生成规则/技能：落地方式（scope）由人决定，避免把偶发问题固化成规范。
 */
async function taskLesson({ root, args }) {
  assertKeys(args, ['text', 'evidence', 'scope', 'scopeReason'], 'task_lesson')
  if (!isText(args.text)) throw new ToolError('task_lesson 需要 text：写下验证过的结论')
  if (!isText(args.evidence)) throw new ToolError('task_lesson 需要 evidence：写出结论的依据（门禁记录、日志或文件）')
  const scope = String(args.scope ?? '').trim()
  if (!['skill', 'rule', 'none'].includes(scope)) {
    throw new ToolError('task_lesson 的 scope 只能是 skill / rule / none')
  }
  const scopeReason = clip(args.scopeReason ?? '', 300)
  if (scope === 'none' && !scopeReason) throw new ToolError('scope=none 时必须写 scopeReason：为什么不落地')

  const { data, state } = readContext(root)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')
  if (state.delivered) throw new ToolError('任务已交付，不能再追加复盘。')

  const lesson = {
    id: `L${state.lessons.length + 1}`,
    text: clip(args.text, 600),
    evidence: clip(args.evidence, 400),
    scope,
    ...(scopeReason ? { scopeReason } : {}),
  }
  appendEvent(data, 'lesson.recorded', { lesson })
  saveTask(root, data)
  // JSONL 台账只是可读副本：写失败不影响事件流（事件仍是唯一权威来源）。
  const record = appendLesson(root, { taskId: state.taskId, lessonId: lesson.id, ...lesson })
  return {
    ok: true,
    lessonId: lesson.id,
    scope,
    ledger: Boolean(record),
    lessons: state.lessons.length + 1,
    next: 'task_gate',
  }
}

/**
 * 组件清单按需查询：返回短摘要，不把整份清单塞进上下文。
 * 这是无状态的源码查询，和任务生命周期无关，所以没有并进 task_* 工具。
 */
async function uiLookup({ root, config, args }) {
  assertKeys(args, ['query'], 'ui_lookup')
  const relative = config.checks.ui?.inventory ?? DEFAULT_INVENTORY
  const file = path.join(root, relative)

  let inventory = readInventory(file)
  if (!inventory) {
    inventory = buildInventory(root, config.checks.ui)
    try {
      writeInventory(root, relative, inventory)
    } catch {
      // 只读文件系统里仍允许查询，只是清单下次再生成。
    }
  }

  const result = lookupComponents(inventory, args.query, 5)
  return {
    total: result.total,
    matches: result.matches,
    hint:
      result.total === 0
        ? '清单里没有匹配组件。可以新建，但提交前跑一次 npx fe-guard check，确认没有重复实现。'
        : '优先复用上面列出的文件；确需新建请改名，并在提交说明里写清与已有组件的差异。',
  }
}

const HANDLERS = {
  task_start: taskStart,
  task_criteria: taskCriteria,
  task_plan: taskPlan,
  task_next: taskNext,
  task_gate: taskGate,
  task_status: taskStatus,
  task_lesson: taskLesson,
  ui_lookup: uiLookup,
}

export async function callTool({ root, name, args = {} }) {
  const handler = HANDLERS[name]
  if (!handler) {
    throw new ToolError(`未知工具 "${name}"。可用工具：${Object.keys(HANDLERS).join(', ')}`)
  }
  const config = loadConfig(root)
  if (!config.workflow.enabled && name !== 'task_gate') {
    throw new ToolError(
      '流程层已关闭（workflow.enabled=false）。当前为 v1 纯检查模式：请直接运行 npx fe-guard check，或调用 task_gate。',
    )
  }
  if (config.workflow.enabled === false && name === 'task_gate') {
    // 关闭流程层时，门禁只做检查，不写任务证据。
    const { report, exitCode } = await runCheckCore({ root, mode: config.workflow.gate.mode, config })
    return {
      ok: report.ok,
      exitCode,
      mode: report.mode,
      summary: {
        known: report.summary.known,
        new: report.summary.new,
        newErrors: report.summary.newErrors,
      },
      workflow: 'disabled',
      report: config.report.path,
    }
  }
  return handler({ root, config, args })
}

/** 把被拒绝的调用写入事件流，便于审计"模型试图怎么绕过流程"。 */
export function recordRejection(root, tool, reason) {
  try {
    const data = loadTask(root)
    if (!data.taskId) return
    appendEvent(data, 'tool.rejected', { tool, reason: clip(reason, 300) })
    saveTask(root, data)
  } catch {
    // 审计失败不应影响主错误返回
  }
}
