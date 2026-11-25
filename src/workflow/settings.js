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
    throw new UserError(`${source} 中 workflow.preflight 必须是对象（{ command, timeoutMs }）`)
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
    preflight: { command: (preflight.command ?? '').trim(), timeoutMs: preflightTimeoutMs },
    distill,
  }
}
