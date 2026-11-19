import path from 'node:path'
import {
  adapterOfRule,
  checkEnabled,
  effectiveSeverity,
  isBaselineExempt,
  loadConfig,
  SUPPORTED_CHECKS,
} from './config.js'
import { DEFAULT_PROFILE, isProfileName, PROFILES, PROFILE_NAMES } from './profiles.js'
import { UserError } from './utils.js'
import { changedFiles, createStagedSnapshot } from './git.js'
import {
  evaluate,
  evaluateRatchets,
  loadBaseline,
  partitionEntries,
  partitionRatchets,
  sameEntries,
  saveBaseline,
} from './baseline.js'
import { activeChecks, runChecks, STAGED_CONTENT_CHECKS } from './runners/index.js'
import { buildReport, writeReport } from './report.js'
import { detectWorkspace } from './workspace.js'
import { createTimings } from './timing.js'
import { isNotExecutedRule, notExecuted } from './not-executed.js'

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.vue']

/** 变更文件里，哪些能被当前启用的检查覆盖；其余（md、json 等）直接忽略。 */
function inspectableExtensions(config) {
  const extensions = new Set()
  if (checkEnabled(config, 'eslint')) {
    (config.checks.eslint.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.vue']).forEach((ext) => extensions.add(ext))
  }
  if (checkEnabled(config, 'typescript')) TS_EXTENSIONS.forEach((ext) => extensions.add(ext))
  if (checkEnabled(config, 'boundaries')) TS_EXTENSIONS.forEach((ext) => extensions.add(ext))
  if (checkEnabled(config, 'deps')) {
    (config.checks.deps.extensions ?? []).forEach((ext) => extensions.add(ext))
    // 依赖登记只在 package.json 变更时触发，所以要把它留在 scope 里。
    extensions.add('package.json')
  }
  if (checkEnabled(config, 'ui')) (config.checks.ui.extensions ?? []).forEach((ext) => extensions.add(ext))
  if (checkEnabled(config, 'metrics')) (config.checks.metrics.extensions ?? []).forEach((ext) => extensions.add(ext))
  return [...extensions]
}

function isExempt(violation) {
  return isBaselineExempt(violation.ruleId)
}

/** 每个启用项到底跑没跑：ran / skipped / unavailable。 */
function computeStatuses(config, timings, violations, override = {}) {
  const statuses = {}
  for (const key of activeChecks(config)) {
    if (override[key]) {
      statuses[key] = override[key]
      continue
    }
    const hasNotExecuted = violations.some(
      (violation) => adapterOfRule(violation.ruleId) === key && isNotExecutedRule(violation.ruleId),
    )
    const timing = timings?.checks?.[key]
    const packages = (timings?.packages ?? []).filter((pkg) => pkg.check === key)
    if (hasNotExecuted || timing?.status === 'failed' || timing?.status === 'missing' || timing?.status === 'timeout') {
      statuses[key] = 'unavailable'
    } else if (timing?.status === 'skipped') {
      statuses[key] = 'skipped'
    } else if (packages.length > 0 && packages.every((pkg) => pkg.status === 'skipped')) {
      statuses[key] = 'skipped'
    } else {
      statuses[key] = 'ran'
    }
  }
  return statuses
}

function allStatuses(config, status) {
  return Object.fromEntries(activeChecks(config).map((key) => [key, status]))
}

function stagedInfo(config) {
  return {
    contentChecks: activeChecks(config).filter((key) => STAGED_CONTENT_CHECKS.has(key)),
    workingTreeChecks: activeChecks(config).filter((key) => !STAGED_CONTENT_CHECKS.has(key)),
  }
}

/**
 * 档位只决定“跑哪些检查”，不改用户配置里的 enabled。
 * 返回派生配置（内存里），并记录被本档位跳过的检查，供报告原样展示。
 */
export function applyProfile(config, name = config.profile ?? DEFAULT_PROFILE) {
  if (!isProfileName(name)) {
    throw new UserError(`未知档位 "${name}"。可选：${PROFILE_NAMES.join(' / ')}`)
  }
  const profile = PROFILES[name]
  const allowed = new Set(profile.checks)
  const skipped = SUPPORTED_CHECKS.filter(
    (key) => config.enabled && config.checks[key]?.enabled && !allowed.has(key),
  )
  const checks = {}
  for (const [key, value] of Object.entries(config.checks)) {
    checks[key] = { ...value, enabled: Boolean(value.enabled) && allowed.has(key) }
  }
  return {
    config: { ...config, profile: name, checks },
    profile: { name, description: profile.description, checks: profile.checks, skipped },
  }
}

/**
 * 检查内核：CLI（fe-guard check）和 MCP 门禁（task_gate）共用同一套逻辑，
 * 保证"对话里跑的门禁"和"CI 里跑的检查"是同一条命令、同一份 baseline。
 * 只返回结果，不负责打印。
 *
 * --staged 时，内容检查（eslint/deps/ui/metrics）在暂存区快照上执行；
 * typescript/boundaries/diff-size 仍读取工作区，并在报告里明确标注，不假装一致。
 */
export async function runCheckCore({ root, mode = 'full', config, configPath, profile }) {
  const baseConfig = config ?? loadConfig(root, { configPath })
  const resolved = applyProfile(baseConfig, profile ?? baseConfig.profile)
  const cfg = resolved.config

  const finish = (options) => {
    const report = buildReport({ config: cfg, mode, profile: resolved.profile, ...options })
    const reportFile = writeReport(root, cfg, report)
    return { report, reportFile, exitCode: options.exitCode }
  }

  if (!cfg.enabled) {
    return finish({
      scope: null,
      exitCode: 0,
      skipped: true,
      note: 'fe-guard.config.json 中 enabled=false，检查已全局关闭（紧急止血开关，不应该出现在 CI 里）',
      checkStatus: allStatuses(cfg, 'skipped'),
    })
  }
  if (activeChecks(cfg).length === 0) {
    // 全关 == 没有门禁。绝不能返回 0，否则删掉配置段就能让 CI 变绿。
    return finish({
      scope: null,
      exitCode: 2,
      skipped: false,
      note:
        '没有启用任何检查项（checks.*.enabled 全是 false 或整段缺失），拒绝判定为通过。\n' +
        '  下一步: 至少启用一项检查；确实要紧急止血请显式设置 enabled:false，并在恢复后立刻改回。',
      checkStatus: {},
    })
  }

  let scope = null
  let snapshot = null
  try {
    if (mode !== 'full') {
      const extensions = inspectableExtensions(cfg)
      const changed = await changedFiles({ root, mode, base: cfg.diff.base })
      scope = changed.filter((file) => extensions.some((ext) => file.endsWith(ext)))
      if (scope.length === 0) {
        return finish({
          scope: [],
          exitCode: 0,
          skipped: true,
          note: `本次改动（${mode}）没有需要检查的源文件，跳过执行工具`,
          checkStatus: allStatuses(cfg, 'skipped'),
        })
      }
    }

    let inspectRoot = root
    if (mode === 'staged') {
      snapshot = await createStagedSnapshot({ root, workspace: detectWorkspace(root) })
      inspectRoot = snapshot.inspectDir ?? snapshot.dir
    }

    const timings = createTimings()
    const workspace = detectWorkspace(inspectRoot)
    let violations
    try {
      violations = await runChecks({
        root: inspectRoot,
        realRoot: root,
        gitRoot: root,
        config: cfg,
        changedFiles: scope,
        mode,
        timings,
        workspace,
      })
    } catch (error) {
      writeInterruptedReport({ root, cfg, mode, scope, timings, workspace, profile: resolved.profile, error })
      throw error
    }

    const result = evaluateRun({ root, cfg, scope, violations })
    return finish({
      scope,
      evaluation: result.evaluation,
      exitCode: result.exitCode,
      baseline: result.baseline,
      baselineStatus: result.baselineStatus,
      timings,
      staged: mode === 'staged' ? stagedInfo(cfg) : null,
      checkStatus: computeStatuses(cfg, timings, result.scopedViolations),
      workspace: {
        isWorkspace: workspace.isWorkspace,
        source: workspace.source,
        patterns: workspace.patterns,
        packages: workspace.packages.map((pkg) => ({ name: pkg.name, dir: pkg.rel })),
      },
    })
  } finally {
    snapshot?.cleanup()
  }
}

/** 检查项本身抛错（例如 ESLint 配置坏了）：先写一份可审计报告，再由调用方保持退出码 2。 */
function writeInterruptedReport({ root, cfg, mode, scope, timings, workspace, profile, error }) {
  const failure = notExecuted(error.check ?? 'check', {
    file: 'package.json',
    message: `检查执行中断：${error.message}`,
    fix: '按上面的错误修好配置或环境后重跑；如果该项确实不需要，请显式关闭并在评审里说明。',
  })
  const report = buildReport({
    config: cfg,
    mode,
    scope,
    exitCode: 2,
    note: `${error.message}\n报告已写出，但本次结果不可用：所有检查状态标记为 unavailable。`,
    checkStatus: allStatuses(cfg, 'unavailable'),
    staged: mode === 'staged' ? stagedInfo(cfg) : null,
    profile,
    timings,
    workspace: {
      isWorkspace: workspace.isWorkspace,
      source: workspace.source,
      patterns: workspace.patterns,
      packages: workspace.packages.map((pkg) => ({ name: pkg.name, dir: pkg.rel })),
    },
    evaluation: { violations: [{ ...failure, status: 'new' }], tightened: [], removed: [], knownCount: 0, newCount: 1 },
  })
  writeReport(root, cfg, report)
}

/** 对比 baseline、写回收紧、计算退出码。把“计算”从主流程里拆出来，便于单独读和测。 */
function evaluateRun({ root, cfg, scope, violations }) {
  const scopedViolations = scope
    ? violations.filter((violation) => scope.includes(violation.file) || isExempt(violation))
    : violations

  // 三种违规：条数型（eslint/ts/…）、值型（metrics）、豁免 baseline 的（diff-size/未执行）。
  const counted = scopedViolations.filter((violation) => typeof violation.value !== 'number' && !isExempt(violation))
  const measured = scopedViolations.filter((violation) => typeof violation.value === 'number' && !isExempt(violation))
  const exempt = scopedViolations.filter(isExempt)

  const baselinePath = path.join(root, cfg.baseline.path)
  const baseline = loadBaseline(baselinePath)
  const inScope = (file, ruleId) => {
    const adapter = adapterOfRule(ruleId)
    if (!checkEnabled(cfg, adapter)) return false
    if (isBaselineExempt(ruleId)) return false
    return scope ? scope.includes(file) : true
  }

  const scopedEntries = partitionEntries(baseline.entries, inScope)
  const scopedRatchets = partitionRatchets(baseline.ratchets, inScope)
  const countEval = evaluate(counted, scopedEntries.scoped)
  const ratchetEval = evaluateRatchets(measured, scopedRatchets.scoped)
  const evaluation = {
    violations: [
      ...countEval.violations,
      ...ratchetEval.violations,
      ...exempt.map((violation) => ({ ...violation, status: 'new' })),
    ],
    tightened: [...countEval.tightened, ...ratchetEval.tightened],
    removed: [...countEval.removed, ...ratchetEval.removed],
    knownCount: countEval.knownCount + ratchetEval.knownCount,
    newCount: countEval.newCount + ratchetEval.newCount + exempt.length,
  }

  const nextEntries = { ...scopedEntries.rest, ...countEval.nextEntries }
  const nextRatchets = { ...scopedRatchets.rest, ...ratchetEval.nextRatchets }
  const baselineChanged =
    !sameEntries(baseline.entries, nextEntries) || !sameEntries(baseline.ratchets, nextRatchets)
  const baselineWritten = baselineChanged && cfg.baseline.autoTighten
  if (baselineWritten) {
    saveBaseline(baselinePath, nextEntries, nextRatchets, {
      firstSeen: baseline.firstSeen,
      widenLog: baseline.widenLog,
    })
  }

  const failures = evaluation.violations.filter(
    (violation) => violation.status === 'new' && effectiveSeverity(violation, cfg) === 'error',
  )
  return {
    evaluation,
    scopedViolations,
    exitCode: failures.length > 0 ? 1 : 0,
    baseline: { entries: baseline.entries, ratchets: baseline.ratchets },
    baselineStatus: { written: baselineWritten, changed: baselineChanged },
  }
}
