import path from 'node:path'
import { loadConfig } from '../config.js'
import { loadBaseline, parseKey } from '../baseline.js'
import { appendMisreport, feedbackPath, loadMisreports, summarizeMisreports } from '../feedback.js'
import { UserError } from '../utils.js'

const USAGE =
  '用法:\n' +
  '  fe-guard false-positive --file <文件> --rule <规则> --reason <原因> [--line <行>] [--root <dir>]\n' +
  '  fe-guard false-positive --summary [--json]\n' +
  '  fe-guard false-positive --list [--json]'

/**
 * 误报反馈闭环：只记录、可审计、可汇总，不改变 check 的判定。
 * 明确边界：标记误报 ≠ 关闭检查；降级/关闭必须改配置，走评审。
 */
export async function falsePositiveCommand({ root, file, rule, line, reason, summary, list, suggest, json, configPath }) {
  const config = loadConfig(root, { configPath })
  const target = feedbackPath(root, config)
  const records = loadMisreports(target)

  if (suggest) {
    const result = suggestRules({ root, config, records })
    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (result.rules.length === 0) {
      console.log('还没有足够的误报记录来给建议。')
      return 0
    }
    console.log(`fe-guard 误报建议: ${records.length} 条记录，覆盖 ${result.rules.length} 条规则`)
    console.log('')
    result.rules.forEach((item) => {
      const rate = Math.round(item.rate * 1000) / 10
      console.log(
        `  ${item.ruleId}  误报 ${item.misreports} / 存量 ${item.occurrences}  ${rate}%  → ${item.suggestion}`,
      )
    })
    console.log('')
    console.log('说明：以上只是统计建议，不会自动改配置。')
    console.log('  降级：把对应检查的 level 改成 "warn"；关闭：把 enabled 改成 false。')
    console.log('  两者都需要走评审，并在提交说明里写清理由。')
    return 0
  }

  if (summary) {
    const result = summarizeMisreports(records)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (result.total === 0) {
      console.log('还没有误报记录。')
      return 0
    }
    console.log(`fe-guard 误报汇总: ${result.total} 条（${result.firstAt} ~ ${result.lastAt}）`)
    console.log('')
    console.log('按检查项:')
    result.byCheck.forEach((item) => console.log(`  ${item.name}  ${item.count} 条`))
    console.log('')
    console.log('误报最多的规则:')
    result.byRule.slice(0, 10).forEach((item) => console.log(`  ${item.name}  ${item.count} 条`))
    console.log('')
    console.log('注意：这里只是判断沉淀，check 不会自动忽略这些规则。')
    console.log('要降级请在 fe-guard.config.json 调整 level，要关闭请改 enabled，并走代码评审。')
    return 0
  }

  if (list) {
    if (json) {
      console.log(JSON.stringify(records, null, 2))
      return 0
    }
    if (records.length === 0) {
      console.log('还没有误报记录。')
      return 0
    }
    console.log(`fe-guard 误报记录: ${records.length} 条（${path.relative(root, target)}）`)
    records.forEach((record) => {
      const where = record.line ? `${record.file}:${record.line}` : record.file
      console.log(`  ${record.at.slice(0, 10)}  ${where}  ${record.ruleId}`)
      console.log(`      理由: ${record.reason}`)
    })
    return 0
  }

  if (!file || !rule) {
    throw new UserError(`必须提供 --file 和 --rule。\n${USAGE}`)
  }
  if (!String(reason ?? '').trim()) {
    throw new UserError(`必须用 --reason 写清“为什么这是误报”，便于后来的人复核。\n${USAGE}`)
  }
  if (line !== undefined && !/^\d+$/.test(String(line))) {
    throw new UserError(`--line 必须是正整数，当前为 "${line}"。`)
  }

  const record = appendMisreport(target, { file, rule, line: line ? Number(line) : null, reason: String(reason).trim() })
  const total = records.length + 1
  console.log(`已记录误报: ${record.file}${record.line ? `:${record.line}` : ''}  ${record.ruleId}`)
  console.log(`  检查项: ${record.check}，原因: ${record.reason}`)
  console.log(`  记录文件: ${path.relative(root, target)}（已累计 ${total} 条，只追加不修改）`)
  console.log('  边界: 这条记录不会让 check 忽略该违规；需要降级/关闭请改配置并评审。')
  return 0
}

/**
 * 把“误报次数”和 baseline 里的存量次数放在一起看：
 * 误报率高的规则，可能不是代码差，而是规则本身不适用；但仍然只给建议，不自动降级。
 */
function suggestRules({ root, config, records }) {
  const misreports = new Map()
  for (const record of records) {
    misreports.set(record.ruleId, (misreports.get(record.ruleId) ?? 0) + 1)
  }

  const baseline = loadBaseline(path.join(root, config.baseline.path))
  const occurrences = new Map()
  for (const [key, count] of Object.entries(baseline.entries)) {
    const { ruleId } = parseKey(key)
    occurrences.set(ruleId, (occurrences.get(ruleId) ?? 0) + count)
  }
  for (const key of Object.keys(baseline.ratchets)) {
    const { ruleId } = parseKey(key)
    occurrences.set(ruleId, (occurrences.get(ruleId) ?? 0) + 1)
  }

  const rules = [...misreports.entries()]
    .map(([ruleId, count]) => {
      const total = occurrences.get(ruleId) ?? 0
      const rate = count + total > 0 ? count / (count + total) : 1
      return { ruleId, misreports: count, occurrences: total, rate }
    })
    .sort((a, b) => b.rate - a.rate || b.misreports - a.misreports || a.ruleId.localeCompare(b.ruleId))
    .map((item) => ({
      ...item,
      suggestion:
        item.rate >= 0.5
          ? '建议考虑关闭（先确认没有真问题）'
          : item.rate >= 0.2
            ? '建议降级为 warn 观察'
            : '继续观察，暂不建议降级',
    }))

  return { rules, records: records.length }
}
