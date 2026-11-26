import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { toPosix } from '../utils.js'
import { evidenceKindOf } from './criteria.js'

export const EVIDENCE_DIR = '.fe-guard/evidence'
export const MAX_FINGERPRINTS = 100

/** 手工证据失败原因的统一文案，供门禁 blocker 复用。 */
export const MANUAL_REASONS = {
  missing: '文件不存在',
  empty: '文件为空',
  unreadable: '文件不可读',
  'missing-file': '条件没有提供 evidenceFile',
}

/**
 * 校验 verify=manual（或显式挂了 evidenceFile）的条件证据文件。
 * 只证明"有落盘证据"，不判断内容语义是否正确；hash 用于事后追溯同一份文件。
 * 返回 [{ criterionId, file, ok, bytes?, sha256?, reason? }]。
 */
export function collectManualEvidence({ root, criteria = [] }) {
  const targets = criteria.filter((criterion) => criterion?.verify === 'manual' || criterion?.evidenceFile)
  return targets.map((criterion) => {
    const criterionId = criterion.id
    const file = criterion.evidenceFile
    const kind = evidenceKindOf(criterion)
    if (!file) return { criterionId, file: null, kind, ok: false, reason: 'missing-file' }
    const absolute = path.join(root, file)
    if (!existsSync(absolute)) return { criterionId, file, kind, ok: false, reason: 'missing' }
    try {
      const buffer = readFileSync(absolute)
      if (buffer.length === 0) return { criterionId, file, kind, ok: false, bytes: 0, reason: 'empty' }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      return { criterionId, file, kind, ok: true, bytes: buffer.length, sha256 }
    } catch {
      return { criterionId, file, kind, ok: false, reason: 'unreadable' }
    }
  })
}

/**
 * 门禁违规指纹：只保留本轮新增与"未执行"，用于后续任务对比修好/改坏。
 * 最多 100 条，避免证据文件无限膨胀。
 */
export function fingerprintViolations(violations = []) {
  return violations
    .filter((violation) => violation?.status === 'new' || violation?.status === 'not-executed')
    .slice(0, MAX_FINGERPRINTS)
    .map((violation) => ({
      ruleId: violation.ruleId,
      file: violation.file,
      line: violation.line ?? null,
      status: violation.status,
    }))
}

/** 违规的稳定指纹：规则 + 文件 + 行 + 状态，用来判断两轮之间是同一批问题。 */
export function violationKey(violation) {
  return `${violation?.status ?? ''}|${violation?.ruleId ?? ''}|${violation?.file ?? ''}|${violation?.line ?? ''}`
}

/**
 * 对比上一轮门禁与本轮指纹：fixed = 上轮有、本轮没有；introduced = 本轮新冒出来的。
 * previous 可能不存在（首轮），此时 previousNew 为 null，fixed 为 0。
 */
export function compareGateEvidence(previous, violations = []) {
  const before = new Set((previous?.violations ?? []).map(violationKey))
  const after = new Set((violations ?? []).map(violationKey))
  let fixed = 0
  for (const key of before) if (!after.has(key)) fixed += 1
  let introduced = 0
  for (const key of after) if (!before.has(key)) introduced += 1
  return { previousNew: previous?.summary?.new ?? null, fixed, introduced }
}

/**
 * 组装并落盘一次门禁证据。task.json 与快照共用同一份字段，避免两处不一致。
 * 返回 { evidence, evidencePath, summary }；快照写入失败时 evidencePath 为 null。
 */
export function buildGateEvidence({
  root,
  taskId,
  evidenceId,
  report,
  exitCode,
  tests,
  manual,
  violations,
  criteria,
  completion,
  reportPath,
  preflight,
  trend,
  visualDiff,
}) {
  const summary = {
    known: report.summary.known,
    new: report.summary.new,
    newErrors: report.summary.newErrors,
  }
  // trend 只在存在上一轮证据时才有意义；preflight 每次门禁都记录（未配置也会写清）。
  const extras = { preflight, ...(trend ? { trend } : {}), ...(visualDiff ? { visualDiff } : {}) }
  const evidencePath = writeEvidenceSnapshot({
    root,
    taskId,
    evidence: {
      taskId,
      evidenceId,
      at: new Date().toISOString(),
      mode: report.mode,
      ok: report.ok,
      exitCode,
      summary,
      criteria,
      completion,
      tests,
      manual,
      violations,
      ...extras,
      reportPath,
    },
  })
  const evidence = {
    id: evidenceId,
    kind: 'gate',
    mode: report.mode,
    ok: report.ok,
    exitCode,
    summary,
    report: reportPath,
    evidencePath,
    tests,
    manual,
    violations,
    ...extras,
  }
  return { evidence, evidencePath, summary }
}

/** 视觉对比输出落盘：与门禁快照放同一目录，便于按任务/证据 ID 追溯。 */
export function writeEvidenceOutput({ root, taskId, evidenceId, text, suffix = 'visual' }) {
  const safeTaskId = sanitize(taskId, 'unknown')
  const safeEvidenceId = sanitize(evidenceId, 'E1')
  const relative = path.join(EVIDENCE_DIR, safeTaskId, `${safeEvidenceId}-${suffix}.log`)
  try {
    const file = path.join(root, relative)
    const body = `${String(text ?? '')}`
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body, 'utf8')
    return {
      file: toPosix(relative),
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  } catch {
    return null
  }
}

/** 手工证据缺失或为空时给模型的 blocker（只给方向，不阻塞门禁结论本身）。 */
export function manualEvidenceBlockers(manual = []) {
  return manual
    .filter((item) => !item.ok)
    .map(
      (item) =>
        `手工证据 ${item.criterionId}${item.kind ? `（${item.kind}）` : ''} 不可用：${item.file ?? '(未提供)'}（${MANUAL_REASONS[item.reason] ?? item.reason}）`,
    )
}

/** 视觉对比的 blocker：只列可行动的原因，不把整段日志塞进上下文。 */
export function visualDiffBlockers(visualDiff) {
  if (!visualDiff || !visualDiff.needed) return []
  if (visualDiff.ok) return []
  if (visualDiff.reason === 'not-configured') {
    return ['视觉条件要求 evidenceKind=diff，但未配置 workflow.visualDiff.command']
  }
  if (visualDiff.reason === 'check-failed') return ['视觉对比未执行：门禁检查未通过']
  if (visualDiff.missing) return [`视觉对比未执行：命令不可用（${visualDiff.command}）`]
  if (visualDiff.timedOut) return [`视觉对比未执行：命令超时（${visualDiff.command}）`]
  if (visualDiff.reason === 'evidence-write-failed') return ['视觉对比未执行：证据文件写入失败']
  return [`视觉对比未通过：${visualDiff.command}（退出码 ${visualDiff.exitCode}）`]
}

/**
 * 落盘本次门禁快照：.fe-guard/evidence/<taskId>/<evidenceId>.json。
 * 写入失败不抛错（返回 null），门禁结论不受影响，只是少了一份可复查证据。
 */
export function writeEvidenceSnapshot({ root, taskId, evidence }) {
  const safeTaskId = sanitize(taskId, 'unknown')
  const safeEvidenceId = sanitize(evidence?.evidenceId ?? evidence?.id, 'E1')
  const relative = path.join(EVIDENCE_DIR, safeTaskId, `${safeEvidenceId}.json`)
  try {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    return toPosix(relative)
  } catch {
    return null
  }
}

function sanitize(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return text || fallback
}
