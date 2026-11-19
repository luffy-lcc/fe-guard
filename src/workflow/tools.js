import path from 'node:path'
import { loadConfig, stageLevel } from '../config.js'
import { runCheckCore } from '../check-core.js'
import { buildInventory, lookupComponents, readInventory, writeInventory } from '../inventory.js'
import { appendEvent, archiveTask, coverage, emptyTask, loadTask, reduce, saveTask } from './state.js'
import { checkTestFile, runCriterionTests, testBlockers } from './tests.js'

const DEFAULT_INVENTORY = '.fe-guard/ui-inventory.json'

export class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolError'
  }
}

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

// ------------------------------------------------------------------ 工具定义

export const TOOL_DEFINITIONS = [
  {
    name: 'task_start',
    description: '开始一个任务并写入需求合同（目标、不做的事、约束）。任何开发任务的第一步；已有进行中的任务会被拒绝。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话说明这次要做什么' },
        goal: { type: 'string', description: '完成标准的目标描述' },
        outOfScope: { type: 'string', description: '明确不做什么，防止范围膨胀' },
        constraints: { type: 'string', description: '技术或业务约束' },
      },
      required: ['title', 'goal'],
    },
  },
  {
    name: 'task_criteria',
    description: '在 contract 阶段写入验收条件。条件是否达成由门禁证据推导，不接受模型自报 status/achieved。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        criteria: {
          type: 'array',
          description: '验收条件列表，至少 1 条，最多 20 条',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '可选，缺省自动编号 C1、C2…' },
              text: { type: 'string', description: '可被验证的一句话' },
              testFile: { type: 'string', description: '可选：仓库内测试文件相对路径，门禁会真跑它，通过才覆盖该条件' },
            },
            required: ['text'],
          },
        },
      },
      required: ['criteria'],
    },
  },
  {
    name: 'task_plan',
    description: '写入实现计划（步骤列表）。写入后合同锁定，阶段进入 implement；之后修改条件需要新任务。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          description: '实现步骤，1-15 条，每条一句话',
          items: { type: 'string' },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'task_next',
    description: '查询当前阶段、阻塞项和下一步该调用的工具。不确定下一步时先调用它。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'task_gate',
    description: '执行真实门禁检查（复用 fe-guard check），把结果写入证据。只有通过且验收条件都有证据才会进入 deliver。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'task_status',
    description: '查询任务、验收条件达成情况与门禁证据摘要。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'ui_lookup',
    description: '按名称或关键词查已有组件的 props、emits 和文件路径。写新组件前先查，避免重造已有组件。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '组件名或关键词；省略时返回清单前 5 个' },
      },
    },
  },
]

export function listTools(config) {
  if (config?.workflow?.enabled === false) {
    // 流程层关闭时只保留门禁，退回 v1 的纯检查能力。
    return TOOL_DEFINITIONS.filter((tool) => tool.name === 'task_gate')
  }
  return TOOL_DEFINITIONS
}

// ------------------------------------------------------------------ 工具实现

async function taskStart({ root, args }) {
  assertKeys(args, ['title', 'goal', 'outOfScope', 'constraints'], 'task_start')
  if (!isText(args.title) || !isText(args.goal)) throw new ToolError('task_start 需要 title 和 goal（非空字符串）')

  const { data, state } = readContext(root)
  if (state.taskId && !state.delivered) {
    throw new ToolError(
      `已有进行中的任务 ${state.taskId}（stage=${state.stage}）。先把当前任务走到交付；若要放弃，运行 npx fe-guard task reset --yes`,
    )
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
  })
  task.taskId = taskId
  saveTask(root, task)
  return {
    ok: true,
    taskId,
    stage: 'contract',
    next: 'task_criteria',
    hint: '下一步：调用 task_criteria 写至少 1 条验收条件。',
  }
}

async function taskCriteria({ root, config, args }) {
  assertKeys(args, ['criteria'], 'task_criteria')
  if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
    throw new ToolError('task_criteria 需要非空的 criteria 数组')
  }
  if (args.criteria.length > 20) throw new ToolError('一次最多写入 20 条验收条件')

  const { data, state } = readContext(root)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')

  const level = stageLevel(config, 'contract')
  if (state.stage !== 'contract' && level === 'enforce') {
    throw new ToolError(`验收条件只能在 contract 阶段写入（当前 ${state.stage}）。如需改条件，请新建任务。`)
  }

  const existing = new Set(state.criteria.map((criterion) => criterion.id))
  const nextIndex = { value: state.criteria.length }
  const criteria = args.criteria.map((item) => {
    if (!item || typeof item !== 'object') throw new ToolError('criteria 的每一项必须是对象')
    const extra = Object.keys(item).filter((key) => !['id', 'text', 'testFile'].includes(key))
    if (extra.length > 0) {
      throw new ToolError(
        `验收条件不接受字段 ${extra.join(', ')}：条件是否达成由门禁证据推导，模型不能自行标记为达成。`,
      )
    }
    if (!isText(item.text)) throw new ToolError('每条验收条件都需要非空 text')
    let testFile
    if (item.testFile !== undefined) {
      try { testFile = checkTestFile(item.testFile) } catch (error) { throw new ToolError(error.message) }
    }
    let id = item.id?.trim()
    if (id && !/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new ToolError(`验收条件 id "${id}" 不合法（1-16 位字母数字下划线）`)
    if (!id) {
      do {
        nextIndex.value += 1
        id = `C${nextIndex.value}`
      } while (existing.has(id))
    }
    if (existing.has(id)) throw new ToolError(`验收条件 id "${id}" 重复`)
    existing.add(id)
    return { id, text: clip(item.text, 200), ...(testFile ? { testFile } : {}) }
  })

  appendEvent(data, 'criteria.declared', { criteria })
  saveTask(root, data)
  const nextState = reduce(data.events)
  return {
    ok: true,
    ids: criteria.map((criterion) => criterion.id),
    stage: nextState.stage,
    next: 'task_plan',
    ...(state.stage !== 'contract' ? { warning: `合同阶段为 ${level}，已允许在 ${state.stage} 阶段追加条件` } : {}),
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

async function taskGate({ root, config, args }) {
  assertKeys(args, [], 'task_gate')
  const { data, state } = readContext(root)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')
  if (state.delivered) throw new ToolError('当前任务已交付。新的需求请先调用 task_start（旧任务会自动归档）。')

  if (!state.plan && stageLevel(config, 'plan') === 'enforce') {
    throw new ToolError('必须先写计划（task_plan）才能执行门禁；不允许跳过计划阶段。')
  }

  const level = stageLevel(config, 'verify')
  const { report, exitCode } = await runCheckCore({ root, mode: config.workflow.gate.mode, config })
  if (report.skipped) {
    throw new ToolError(`门禁未真正执行：${report.note}。请先恢复检查，否则结果不能作为证据。`)
  }
  const tests = report.ok ? await runCriterionTests({ root, config, criteria: state.criteria }) : []
  const testsOk = tests.every((test) => test.ok)

  const evidence = {
    id: `E${state.evidence.length + 1}`,
    kind: 'gate',
    mode: report.mode,
    ok: report.ok,
    exitCode,
    summary: {
      known: report.summary.known,
      new: report.summary.new,
      newErrors: report.summary.newErrors,
    },
    report: config.report.path,
    ...(tests.length > 0 ? { tests } : {}),
  }
  appendEvent(data, 'gate.recorded', { evidence })
  saveTask(root, data)

  let nextState = reduce(data.events)
  const covered = coverage(nextState, level)
  const achieved = covered.filter((item) => item.evidence).length
  const total = covered.length
  const canDeliver = total > 0 && achieved === total && (report.ok || level !== 'enforce')
  if (canDeliver) {
    appendEvent(data, 'task.delivered', { degraded: !report.ok || !testsOk })
    saveTask(root, data)
    nextState = reduce(data.events)
  }

  const blockers = []
  if (!report.ok) {
    blockers.push(`门禁未通过：新增 ${report.summary.new} 条违规（error ${report.summary.newErrors}）`)
    report.violations
      .filter((violation) => violation.status === 'new')
      .slice(0, 3)
      .forEach((violation) => {
        blockers.push(`${violation.ruleId} @ ${violation.file}${violation.line ? `:${violation.line}` : ''}`)
      })
  }
  blockers.push(...testBlockers(tests))
  if (total === 0) blockers.push('没有验收条件：请先补 task_criteria（contract 阶段被跳过）')
  if (achieved < total) {
    const missing = covered.filter((item) => !item.evidence).map((item) => item.criterion.id)
    blockers.push(`验收条件未覆盖：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`)
  }

  return {
    ok: report.ok && (testsOk || level !== 'enforce'),
    exitCode,
    stage: nextState.stage,
    evidenceId: evidence.id,
    summary: evidence.summary,
    criteria: { total, achieved },
    blockers: blockers.slice(0, 6),
    next: nextState.stage === 'deliver' ? 'task_status' : '修复问题后再次调用 task_gate',
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
  const covered = coverage(state, level)
  const achieved = covered.filter((item) => item.evidence).length
  const blockers = []

  if (state.stage === 'verify') {
    const last = state.evidence[state.evidence.length - 1]
    if (!last?.ok) blockers.push(`最近一次门禁未通过（新增 ${last?.summary?.new ?? '?'} 条），需修复后重跑`)
    const missing = covered.filter((item) => !item.evidence).map((item) => item.criterion.id)
    if (missing.length > 0) blockers.push(`未覆盖的验收条件：${missing.slice(0, 5).join(', ')}`)
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
    criteria: { total: state.criteria.length, achieved },
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
      achievedBy: item.evidence?.id ?? null,
      ...(item.criterion.testFile ? { testFile: item.criterion.testFile } : {}),
    })),
    planSteps: state.plan?.steps.length ?? 0,
    evidence: state.evidence.slice(-3).map((item) => ({
      id: item.id,
      ok: item.ok,
      exitCode: item.exitCode,
      mode: item.mode,
      at: item.at,
      summary: item.summary,
    })),
    rejectedCalls: state.rejections,
    events: state.eventCount,
    report: config.report.path,
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
