import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { adapterOfRule } from './config.js'

export const DEFAULT_FEEDBACK_PATH = '.fe-guard/false-positives.jsonl'

/**
 * 误报标记是只追加的审计日志，不是“关闭开关”：
 * check 不会读取它来过滤结果，只用于复盘规则质量、决定是否降级或修规则。
 */
export function feedbackPath(root, config) {
  return path.join(root, config?.feedback?.path ?? DEFAULT_FEEDBACK_PATH)
}

export function appendMisreport(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true })
  const record = {
    at: new Date().toISOString(),
    file: entry.file,
    line: entry.line ?? null,
    ruleId: entry.rule,
    check: adapterOfRule(entry.rule),
    reason: entry.reason,
  }
  appendFileSync(file, `${JSON.stringify(record)}\n`)
  return record
}

export function loadMisreports(file) {
  if (!existsSync(file)) return []
  const records = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record.ruleId === 'string') records.push(record)
    } catch {
      // 坏行跳过，不影响其余审计记录。
    }
  }
  return records
}

export function summarizeMisreports(records) {
  const byRule = new Map()
  const byCheck = new Map()
  for (const record of records) {
    byRule.set(record.ruleId, (byRule.get(record.ruleId) ?? 0) + 1)
    byCheck.set(record.check, (byCheck.get(record.check) ?? 0) + 1)
  }
  const sort = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
  return {
    total: records.length,
    byRule: sort(byRule),
    byCheck: sort(byCheck),
    firstAt: records.length > 0 ? records[0].at : null,
    lastAt: records.length > 0 ? records[records.length - 1].at : null,
  }
}
