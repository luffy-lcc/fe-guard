import path from 'node:path'
import { writeJsonFile } from './utils.js'
import { effectiveSeverity } from './config.js'
import { CHECK_LABELS, activeChecks } from './runners/index.js'

export const REPORT_SCHEMA_VERSION = 2

export function buildReport({
  config,
  mode,
  scope,
  evaluation,
  exitCode,
  baseline,
  baselineStatus,
  note,
  skipped = false,
  timings,
  workspace,
  checkStatus,
  staged,
  profile,
}) {
  // 按配置里的 level 归一化后再统计，避免"已降级为 warn 但仍显示 error"的误导。
  const violations = (evaluation?.violations ?? []).map((violation) => ({
    ...violation,
    severity: effectiveSeverity(violation, config),
  }))
  const summary = {
    total: violations.length,
    known: evaluation?.knownCount ?? 0,
    new: evaluation?.newCount ?? 0,
    newErrors: violations.filter((v) => v.status === 'new' && v.severity === 'error').length,
    newWarnings: violations.filter((v) => v.status === 'new' && v.severity === 'warn').length,
    tightened: evaluation?.tightened.length ?? 0,
    removed: evaluation?.removed.length ?? 0,
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ok: exitCode === 0,
    exitCode,
    mode,
    generatedAt: new Date().toISOString(),
    skipped,
    note: note ?? null,
    checks: activeChecks(config).map((key) => ({
      id: key,
      label: CHECK_LABELS[key],
      level: config.checks[key].level,
      status: checkStatus?.[key] ?? (skipped ? 'skipped' : 'ran'),
    })),
    profile: profile ?? {
      name: config.profile ?? 'full',
      description: '',
      checks: activeChecks(config),
      skipped: [],
    },
    scope,
    workspace: workspace ?? null,
    staged: staged ?? null,
    timings: timings ?? null,
    summary,
    violations: violations.map((violation) => ({
      ruleId: violation.ruleId,
      file: violation.file,
      line: violation.line,
      severity: violation.severity,
      status: violation.status,
      ...(typeof violation.value === 'number' ? { value: violation.value } : {}),
      ...(violation.allowed !== undefined ? { allowed: violation.allowed } : {}),
      message: violation.message,
      fix: violation.fix,
    })),
    baseline: {
      path: config.baseline.path,
      autoTighten: config.baseline.autoTighten,
      tightened: evaluation?.tightened ?? [],
      removed: evaluation?.removed ?? [],
      wroteBack: Boolean(baselineStatus?.written),
      current: baseline?.entries ?? {},
      ratchets: baseline?.ratchets ?? {},
    },
  }
}

export function writeReport(root, config, report) {
  const file = path.join(root, config.report.path)
  writeJsonFile(file, report)
  return path.relative(root, file)
}

const MAX_LISTED = 20

export function printReport(report, { reportFile, baselineChanged, baselineWritten, showKnown = false }) {
  const lines = [`fe-guard  mode=${report.mode}  ${report.skipped ? '（跳过）' : ''}`.trim()]
  lines.push(...headerLines(report))

  if (report.skipped) {
    lines.push(`- ${report.note}`)
    lines.push('结果：通过（退出码 0）')
    console.log(lines.join('\n'))
    return
  }

  lines.push(...violationLines(report, showKnown))
  lines.push(...baselineLines(report, { baselineChanged, baselineWritten }))
  lines.push(`报告: ${reportFile}`)
  if (report.ok) lines.push('结果：通过（退出码 0）')
  else if (report.exitCode === 2) lines.push('结果：失败（退出码 2，检查未真正执行或配置/环境有误）')
  else lines.push(`结果：失败（退出码 ${report.exitCode}，存在新增违规）`)
  console.log(lines.join('\n'))
}

/** 检查项、档位、staged 范围、workspace 与“未真正执行”提示。 */
function headerLines(report) {
  const lines = [`checks: ${report.checks.map((check) => `${check.label}=${check.level}`).join(', ') || '无'}`]
  if (report.profile) {
    const skippedLabels = (report.profile.skipped ?? []).map((key) => CHECK_LABELS[key] ?? key)
    lines.push(
      `profile: ${report.profile.name}` + (skippedLabels.length > 0 ? `（本档位跳过：${skippedLabels.join(' / ')}）` : ''),
    )
    if (skippedLabels.length > 0) {
      lines.push('  跳过 ≠ 通过：这些检查本次没有执行。需要全档请用 check --full（或 --profile full）。')
    }
  }
  if (report.staged) {
    const content = report.staged.contentChecks.join(' / ') || '无'
    const working = report.staged.workingTreeChecks.join(' / ')
    lines.push(
      `--staged: ${content} 检查暂存区快照` +
        (working ? `；${working} 读取工作区（无法用影子目录）` : '；typescript / boundaries / diff-size 本次未启用'),
    )
  }
  const unavailable = report.checks.filter((check) => check.status === 'unavailable')
  if (unavailable.length > 0) {
    lines.push(
      `检查未真正执行: ${unavailable.map((check) => check.label).join('、')}` +
        '（报告里 status=unavailable，相关违规不可入账）',
    )
  }
  if (report.note && !report.skipped) lines.push(`- ${report.note}`)
  if (report.scope) lines.push(`scope: ${report.scope.length} 个变更文件`)
  if (report.workspace?.isWorkspace) {
    lines.push(
      `workspace: ${report.workspace.source}，${report.workspace.packages.length} 个 package` +
        '（ESLint / TypeScript 按 package 分别执行）',
    )
  }
  return lines
}

/** 存量/新增摘要、逐条新增违规、可选的存量逐条、跳过 package。 */
function violationLines(report, showKnown) {
  const lines = []
  const scopeNote = report.scope ? '，本次范围内' : ''
  const knownHint = report.scope ? '' : '，默认不逐条展示；--all 看全部，fe-guard baseline --show 按文件看'
  lines.push(
    `存量违规 ${report.summary.known} 条（baseline 允许${scopeNote}${report.summary.known > 0 ? knownHint : ''}），` +
      `新增 ${report.summary.new} 条（error ${report.summary.newErrors} / warn ${report.summary.newWarnings}）`,
  )

  const fresh = report.violations.filter((violation) => violation.status === 'new')
  fresh.slice(0, MAX_LISTED).forEach((violation) => {
    lines.push(`  [new] ${where(violation)}  ${violation.ruleId} (${violation.severity})`)
    lines.push(`        ${violation.message}`)
    if (violation.fix) lines.push(`        fix: ${violation.fix}`)
  })
  if (fresh.length > MAX_LISTED) lines.push(`  ...还有 ${fresh.length - MAX_LISTED} 条新增违规，见报告文件`)

  if (showKnown && report.summary.known > 0) {
    const known = report.violations.filter((violation) => violation.status === 'known')
    known.slice(0, MAX_LISTED).forEach((violation) => {
      lines.push(`  [known] ${where(violation)}  ${violation.ruleId} (${violation.severity})`)
    })
    if (known.length > MAX_LISTED) lines.push(`  ...还有 ${known.length - MAX_LISTED} 条存量违规，见报告文件`)
  }

  const skipped = (report.timings?.packages ?? []).filter((pkg) => pkg.status === 'skipped')
  if (skipped.length > 0) {
    const names = [...new Set(skipped.map((pkg) => pkg.dir || pkg.package))]
    const shown = names.slice(0, 5).join('、')
    lines.push(
      `已跳过 ${skipped.length} 项检查（没有对应配置，或配置把全部文件忽略）：${shown}${names.length > 5 ? ' 等' : ''}`,
    )
  }
  const timings = timingLine(report.timings)
  if (timings) lines.push(`耗时: ${timings}`)
  return lines
}

/** baseline 收紧/写回，以及首次接入提示。 */
function baselineLines(report, { baselineChanged, baselineWritten }) {
  const lines = []
  const { tightened } = report.baseline
  if (tightened.length > 0) {
    const label = report.baseline.wroteBack
      ? 'baseline 已自动收紧'
      : `baseline 可收紧 ${tightened.length} 项（autoTighten=false，未写回）`
    lines.push(`${label}:`)
    tightened.forEach((item) => lines.push(`  ${item.file}  ${item.ruleId}  ${item.from} -> ${item.to}`))
    if (report.baseline.wroteBack && tightened.some((item) => item.to > 0)) {
      lines.push(`  已写回 ${report.baseline.path}`)
    }
  } else if (baselineChanged && !baselineWritten) {
    lines.push('baseline 有变化但未写回（autoTighten=false）')
  }

  const baselineEmpty =
    Object.keys(report.baseline.current ?? {}).length === 0 &&
    Object.keys(report.baseline.ratchets ?? {}).length === 0
  if (baselineEmpty && (report.summary.new > 0 || report.summary.known > 0)) {
    lines.push('')
    lines.push('第一次接入：上面这些都是存量问题，不是这次改坏的。')
    lines.push('  下一步: npx fe-guard baseline   # 记入账本；之后默认只展示新增')
  }
  return lines
}

function where(violation) {
  return violation.line ? `${violation.file}:${violation.line}` : violation.file
}

function timingLine(timings) {
  if (!timings?.checks) return ''
  return Object.entries(timings.checks)
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([id, item]) => `${CHECK_LABELS[id] ?? id} ${formatMs(item.ms)}${item.status === 'failed' ? '(失败)' : ''}`)
    .join('、')
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}
