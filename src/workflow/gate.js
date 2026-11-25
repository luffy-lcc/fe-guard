import { stageLevel } from '../config.js'
import { runCheckCore } from '../check-core.js'
import {
  appendEvent,
  completion,
  isConfirmed,
  isDeferred,
  loadTask,
  needsLesson,
  reduce,
  saveTask,
} from './state.js'
import { isAssumption } from './criteria.js'
import { runCriterionTests, testBlockers } from './tests.js'
import {
  buildGateEvidence,
  collectManualEvidence,
  compareGateEvidence,
  fingerprintViolations,
  manualEvidenceBlockers,
} from './evidence.js'
import { runPreflight } from './preflight.js'
import { ToolError } from './errors.js'

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** enforce 下未确认、且没有 defer 的推断项：门禁不放行。 */
export function pendingAssumptions(state, level) {
  if (level !== 'enforce') return []
  return state.criteria.filter(
    (criterion) => isAssumption(criterion.source) && !isDeferred(state, criterion) && !isConfirmed(state, criterion),
  )
}

/** 预检失败原因：给模型可修复的方向，不回传整份日志。 */
function preflightDetail(preflight, config) {
  if (preflight.timedOut) return `超时（${config.workflow.preflight.timeoutMs}ms）`
  if (preflight.missing) return `命令不可用：${preflight.command}`
  return preflight.output || `退出码 ${preflight.exitCode}`
}

/** 跑真实检查与条件级证据；报告 skipped 时直接拒绝，避免"没执行"被当成通过。 */
async function collectOutcome({ root, config, state }) {
  const { report, exitCode } = await runCheckCore({ root, mode: config.workflow.gate.mode, config })
  if (report.skipped) {
    throw new ToolError(`门禁未真正执行：${report.note}。请先恢复检查，否则结果不能作为证据。`)
  }
  // 检查本身失败时不再跑测试/收集手工证据：结果不可信，也避免无谓的外部命令。
  const tests = report.ok ? await runCriterionTests({ root, config, criteria: state.criteria }) : []
  const manual = report.ok ? collectManualEvidence({ root, criteria: state.criteria }) : []
  return {
    report,
    exitCode,
    tests,
    manual,
    testsOk: tests.every((test) => test.ok),
    manualOk: manual.every((item) => item.ok),
    violations: fingerprintViolations(report.violations),
  }
}

/** 门禁 blockers：顺序即优先级，回归提示和真实违规排在最前面。 */
function buildBlockers({
  previous,
  trend,
  report,
  tests,
  manual,
  assumptionsPending,
  distillation,
  lessonMissing,
  finalCompletion,
}) {
  const blockers = []
  if (previous && !previous.ok && trend.introduced > 0) {
    // 上一轮已经失败，这一轮还冒出新问题：优先怀疑「为了修一个问题引入了新问题」。
    blockers.push(
      `本轮引入了 ${trend.introduced} 条上轮没有的违规，先确认是否改坏了（是否为了修一个问题引入了新问题）`,
    )
  }
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
  blockers.push(...manualEvidenceBlockers(manual).slice(0, 2))
  for (const criterion of assumptionsPending.slice(0, 2)) {
    blockers.push(
      `推断项 ${criterion.id} 未确认（${clip(criterion.source, 60)}）：请人工运行 npx fe-guard task confirm ${criterion.id} --note "..." --yes`,
    )
  }
  if (distillation === 'enforce' && lessonMissing) {
    blockers.push('最近一次门禁失败后还没有复盘：调用 task_lesson 写下有证据的结论（text/evidence/scope）')
  }
  if (finalCompletion.total === 0) {
    blockers.push('没有验收条件：请先补 task_criteria（contract 阶段被跳过）')
  } else if (finalCompletion.remaining.length > 0) {
    const missing = finalCompletion.remaining.map((item) => item.id)
    blockers.push(`验收条件未覆盖：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`)
  }
  return blockers
}

/** 组装并落盘本轮证据：先预演完成度，再写快照，保证 task.json 与快照字段一致。 */
function writeGate({ root, config, state, level, evidenceId, report, exitCode, tests, manual, violations, trend, preflight }) {
  // 先按"这条证据已入账"预演覆盖情况，快照才能写入本轮真实完成度。
  const previewState = {
    ...state,
    evidence: [...state.evidence, { id: evidenceId, ok: report.ok, seq: state.eventCount + 1, tests, manual }],
  }
  const completionValue = completion(previewState, level)
  const criteriaSummary = { total: completionValue.total, achieved: completionValue.achieved }
  const result = buildGateEvidence({
    root,
    taskId: state.taskId,
    evidenceId,
    report,
    exitCode,
    tests,
    manual,
    violations,
    criteria: criteriaSummary,
    completion: completionValue,
    reportPath: config.report.path,
    preflight,
    trend,
  })
  return { ...result, criteriaSummary }
}

/** 依据本轮证据判定能否交付；可以则追加 task.delivered 并回读最新状态。 */
function applyDelivery({ root, data, state, level, report, testsOk, manualOk, distillation }) {
  let nextState = state
  let finalCompletion = completion(nextState, level)
  const deferredIds = finalCompletion.deferred.map((item) => item.id)
  const assumptionsPending = pendingAssumptions(nextState, level)
  const lessonMissing = needsLesson(nextState)
  const canDeliver =
    finalCompletion.total > 0 &&
    finalCompletion.remaining.length === 0 &&
    (report.ok || level !== 'enforce') &&
    assumptionsPending.length === 0 &&
    (distillation !== 'enforce' || !lessonMissing)
  const degraded =
    !report.ok || !testsOk || !manualOk || deferredIds.length > 0 || (distillation === 'warn' && lessonMissing)
  if (canDeliver) {
    appendEvent(data, 'task.delivered', { degraded, deferred: deferredIds })
    saveTask(root, data)
    nextState = reduce(data.events)
    finalCompletion = completion(nextState, level)
  }
  return { nextState, finalCompletion, assumptionsPending, lessonMissing }
}

/**
 * 门禁：真实执行检查，并把结论写成不可篡改的证据。
 *
 * 顺序是固定的：环境预检 → 真实检查 → 条件测试 / 手工证据 → 违规对比 → 复盘要求 → 交付。
 * 预检失败时本次检查完全不执行（不覆盖条件、不写证据），避免把「环境坏了」误当成「代码没问题」。
 */
export async function taskGate({ root, config, args }) {
  for (const key of Object.keys(args)) {
    throw new ToolError(`task_gate 不接受参数 "${key}"。允许的参数：无`)
  }

  const data = loadTask(root)
  const state = reduce(data.events)
  if (!state.taskId) throw new ToolError('还没有任务。先调用 task_start')
  if (state.delivered) throw new ToolError('当前任务已交付。新的需求请先调用 task_start（旧任务会自动归档）。')

  if (!state.plan && stageLevel(config, 'plan') === 'enforce') {
    throw new ToolError('必须先写计划（task_plan）才能执行门禁；不允许跳过计划阶段。')
  }

  // 环境预检：失败 = 本次检查未执行。只追加审计事件，绝不产出可入账的证据。
  const preflight = await runPreflight({ root, config })
  if (!preflight.ok) {
    appendEvent(data, 'preflight.failed', { preflight })
    saveTask(root, data)
    return {
      ok: false,
      exitCode: 1,
      stage: state.stage,
      preflight,
      blockers: [`环境预检未通过，本次检查未执行：${clip(preflightDetail(preflight, config), 200)}`],
      next: '修复环境后再次调用 task_gate',
    }
  }

  const level = stageLevel(config, 'verify')
  const { report, exitCode, tests, manual, testsOk, manualOk, violations } = await collectOutcome({
    root,
    config,
    state,
  })

  // 返工对比：首轮没有上一轮证据，不伪造 trend；之后每轮都能看出修好/改坏。
  const previous = state.evidence.at(-1)
  const trend = previous ? compareGateEvidence(previous, violations) : null
  const evidenceId = `E${state.evidence.length + 1}`

  const { evidence, evidencePath, summary, criteriaSummary } = writeGate({
    root,
    config,
    state,
    level,
    evidenceId,
    report,
    exitCode,
    tests,
    manual,
    violations,
    trend,
    preflight,
  })
  appendEvent(data, 'gate.recorded', { evidence })
  saveTask(root, data)

  const distillation = config.workflow.distill
  const { nextState, finalCompletion, assumptionsPending, lessonMissing } = applyDelivery({
    root,
    data,
    state: reduce(data.events),
    level,
    report,
    testsOk,
    manualOk,
    distillation,
  })

  const blockers = buildBlockers({
    previous,
    trend,
    report,
    tests,
    manual,
    assumptionsPending,
    distillation,
    lessonMissing,
    finalCompletion,
  })

  return {
    ok: report.ok && (testsOk || level !== 'enforce'),
    exitCode,
    stage: nextState.stage,
    evidenceId,
    evidencePath,
    summary,
    criteria: criteriaSummary,
    completion: finalCompletion,
    preflight,
    ...(trend ? { trend } : {}),
    lessonRequired: lessonMissing,
    distill: distillation,
    blockers: blockers.slice(0, 6),
    next: nextState.stage === 'deliver' ? 'task_status' : '修复问题后再次调用 task_gate',
  }
}
