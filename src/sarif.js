import { isNotExecutedRule } from './not-executed.js'
import { CHECK_LABELS } from './runners/index.js'
import { TOOL_VERSION } from './version.js'

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'

/**
 * 把 check 报告转成 GitHub Code Scanning 能直接消费的 SARIF 2.1.0。
 *
 * 只输出「新增违规 + 检查未执行」：
 * - 存量违规已由 baseline 记账，全量上传会在首次接入时制造上千条告警，
 *   之后 baseline 收紧又会让它们批量消失，制造噪声；
 * - “检查未执行”绝不能缺席，否则 SARIF 侧看起来像通过。
 *
 * boundaries 没有行号，因此 region 省略（合法的文件级结果），不伪造行号。
 */
export function buildSarif(report, { pathPrefix = '', version = TOOL_VERSION } = {}) {
  const included = report.violations.filter(
    (violation) => violation.status === 'new' || isNotExecutedRule(violation.ruleId),
  )
  const ruleIds = [...new Set(included.map((violation) => violation.ruleId))].sort()
  const ruleIndex = new Map(ruleIds.map((ruleId, index) => [ruleId, index]))

  const results = included.map((violation) => {
    const result = {
      ruleId: violation.ruleId,
      ruleIndex: ruleIndex.get(violation.ruleId),
      level: violation.severity === 'warn' ? 'warning' : 'error',
      message: { text: violation.message || violation.ruleId },
    }
    const location = physicalLocation(violation, pathPrefix)
    if (location) result.locations = [location]
    return result
  })

  const unavailable = report.checks.filter((check) => check.status === 'unavailable')
  const notifications = unavailable.map((check) => {
    const ruleId = `${check.id}/not-executed`
    return { level: 'error', message: { text: notificationText(included, ruleId, check) }, descriptor: { id: ruleId } }
  })

  const invocation = {
    executionSuccessful: unavailable.length === 0,
    exitCode: report.exitCode,
  }
  if (notifications.length > 0) invocation.toolExecutionNotifications = notifications

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'fe-guard',
            informationUri: 'https://github.com/luffy-lcc/fe-guard',
            version,
            rules: ruleIds.map((id) => ({ id, shortDescription: { text: ruleLabel(id) } })),
          },
        },
        invocations: [invocation],
        results,
      },
    ],
  }
}

/** 伪路径（如 "(check)"）没有物理位置；有真实文件时带上位置。 */
function physicalLocation(violation, pathPrefix) {
  if (!violation.file || violation.file.startsWith('(')) return null
  const artifactLocation = { uri: encodeUri(`${pathPrefix}${violation.file}`), uriBaseId: '%SRCROOT%' }
  const physical = { artifactLocation }
  if (Number.isInteger(violation.line) && violation.line > 0) physical.region = { startLine: violation.line }
  return { physicalLocation: physical }
}

/** 按路径段编码，保留 "/"：空格、# 等字符不破坏 URI。 */
function encodeUri(relative) {
  return relative
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function ruleLabel(ruleId) {
  const checkId = ruleId.split('/')[0]
  return CHECK_LABELS[checkId] ?? ruleId
}

function notificationText(violations, ruleId, check) {
  const match = violations.find((violation) => violation.ruleId === ruleId)
  return match?.message || `${check.label ?? check.id} 本次没有真正执行`
}
