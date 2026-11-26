import { UserError, normalizeTimeout } from '../utils.js'

const WORKFLOW_LEVELS = ['enforce', 'warn', 'off']
const GATE_MODES = ['full', 'diff-only', 'staged']
const DISTILL_LEVELS = ['enforce', 'warn', 'off']

/**
 * 流程层配置。默认全开；`enabled: false` 一行退回 v1 纯检查模式。
 * 每个有约束的阶段可以单独 enforce / warn / off（deliver 是终态，implement 的约束由 plan 承担）。
 * 抽到独立文件，避免 config.js 随着流程能力增长超过单文件行数上限。
 */
export function normalizeWorkflow(raw = {}, source) {
  const stages = {}
  for (const stage of ['contract', 'plan', 'verify']) {
    const level = raw.stages?.[stage] ?? 'enforce'
    if (!WORKFLOW_LEVELS.includes(level)) {
      throw new UserError(
        `${source} 中 workflow.stages.${stage} 只能是 ${WORKFLOW_LEVELS.join(' / ')}，当前为 "${level}"`,
      )
    }
    stages[stage] = level
  }
  const mode = raw.gate?.mode ?? 'full'
  if (!GATE_MODES.includes(mode)) {
    throw new UserError(`${source} 中 workflow.gate.mode 只能是 ${GATE_MODES.join(' / ')}，当前为 "${mode}"`)
  }
  const testCommand = raw.gate?.testCommand ?? 'node --test'
  if (typeof testCommand !== 'string' || testCommand.trim() === '') {
    throw new UserError(`${source} 中 workflow.gate.testCommand 必须是非空字符串，例如 "node --test" 或 "npx vitest run"`)
  }
  const testTimeoutMs = normalizeTimeout(raw.gate?.testTimeoutMs, 120000, 'workflow.gate.testTimeoutMs', source)

  const preflight = raw.preflight ?? {}
  if (preflight === null || typeof preflight !== 'object' || Array.isArray(preflight)) {
    throw new UserError(`${source} 中 workflow.preflight 必须是对象（{ command, timeoutMs } 或 { steps, timeoutMs }）`)
  }
  // 空字符串 = 关闭预检；非字符串直接报错，避免把布尔值等误当成命令。
  if (preflight.command !== undefined && typeof preflight.command !== 'string') {
    throw new UserError(`${source} 中 workflow.preflight.command 必须是字符串（留空表示关闭）`)
  }
  const preflightTimeoutMs = normalizeTimeout(
    preflight.timeoutMs,
    60000,
    'workflow.preflight.timeoutMs',
    source,
  )
  const preflightSteps = normalizePreflightSteps(preflight.steps, preflightTimeoutMs, source)
  const preflightCommand = (preflight.command ?? '').trim()
  if (preflightSteps.length > 0 && preflightCommand) {
    throw new UserError(`${source} 中 workflow.preflight.command 与 steps 只能二选一：多步请只写 steps`)
  }

  const visualDiff = raw.visualDiff ?? {}
  if (visualDiff === null || typeof visualDiff !== 'object' || Array.isArray(visualDiff)) {
    throw new UserError(`${source} 中 workflow.visualDiff 必须是对象（{ command, timeoutMs }）`)
  }
  if (visualDiff.command !== undefined && typeof visualDiff.command !== 'string') {
    throw new UserError(`${source} 中 workflow.visualDiff.command 必须是字符串（留空表示关闭）`)
  }
  const visualDiffTimeoutMs = normalizeTimeout(
    visualDiff.timeoutMs,
    120000,
    'workflow.visualDiff.timeoutMs',
    source,
  )

  const distill = raw.distill ?? 'enforce'
  if (!DISTILL_LEVELS.includes(distill)) {
    throw new UserError(
      `${source} 中 workflow.distill 只能是 ${DISTILL_LEVELS.join(' / ')}，当前为 "${distill}"`,
    )
  }

  return {
    enabled: raw.enabled !== false,
    gate: { mode, testCommand: testCommand.trim(), testTimeoutMs },
    stages,
    preflight: {
      command: preflightCommand,
      timeoutMs: preflightTimeoutMs,
      ...(preflightSteps.length > 0 ? { steps: preflightSteps } : {}),
    },
    visualDiff: { command: (visualDiff.command ?? '').trim(), timeoutMs: visualDiffTimeoutMs },
    distill,
  }
}

/** 多步预检：顺序执行，失败即停；每步可用自己的 timeoutMs 覆盖默认值。 */
function normalizePreflightSteps(value, defaultTimeoutMs, source) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new UserError(`${source} 中 workflow.preflight.steps 必须是数组`)
  }
  if (value.length === 0) {
    throw new UserError(`${source} 中 workflow.preflight.steps 不能为空数组；关闭预检请留空 command`)
  }
  if (value.length > 10) {
    throw new UserError(`${source} 中 workflow.preflight.steps 最多 10 步`)
  }
  const names = new Set()
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new UserError(`${source} 中 workflow.preflight.steps[${index}] 必须是对象`)
    }
    const extra = Object.keys(step).filter((key) => !['name', 'command', 'timeoutMs'].includes(key))
    if (extra.length > 0) {
      throw new UserError(`${source} 中 workflow.preflight.steps[${index}] 不接受字段 ${extra.join(', ')}`)
    }
    const name = typeof step.name === 'string' ? step.name.trim() : ''
    if (!name) throw new UserError(`${source} 中 workflow.preflight.steps[${index}].name 必须是非空字符串`)
    if (names.has(name)) throw new UserError(`${source} 中 workflow.preflight.steps 的 name 不能重复：${name}`)
    names.add(name)
    const command = typeof step.command === 'string' ? step.command.trim() : ''
    if (!command) {
      throw new UserError(`${source} 中 workflow.preflight.steps[${index}].command 必须是非空字符串`)
    }
    const timeoutMs = normalizeTimeout(
      step.timeoutMs,
      defaultTimeoutMs,
      `workflow.preflight.steps[${index}].timeoutMs`,
      source,
    )
    return { name, command, timeoutMs }
  })
}
