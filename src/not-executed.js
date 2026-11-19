/**
 * “检查未执行”违规：统一表示某项检查没有真正跑起来。
 *
 * 这类问题绝不能表现为绿灯，也绝不能进 baseline —— 入账等于把门禁永久关掉。
 * 所有 runner 在缺工具、超时、git 不可用、子进程崩溃等场景下都应产出它。
 */

export const NOT_EXECUTED_SUFFIX = '/not-executed'

/** 兼容 v4 已有的 vue-tsc 缺失规则名。 */
const LEGACY_NOT_EXECUTED = new Set(['typescript/vue-tsc-missing'])

export function notExecuted(checkId, { file = '(check)', message, fix = null } = {}) {
  return {
    ruleId: `${checkId}${NOT_EXECUTED_SUFFIX}`,
    file,
    line: null,
    severity: 'error',
    message,
    fix,
  }
}

export function isNotExecutedRule(ruleId) {
  return String(ruleId).endsWith(NOT_EXECUTED_SUFFIX) || LEGACY_NOT_EXECUTED.has(ruleId)
}
