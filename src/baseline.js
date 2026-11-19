import { existsSync } from 'node:fs'
import { UserError, readJsonFile, run, writeJsonFile } from './utils.js'

export const BASELINE_VERSION = 3

export function baselineKey(file, ruleId) {
  return `${file}::${ruleId}`
}

export function parseKey(key) {
  const index = key.lastIndexOf('::')
  return { file: key.slice(0, index), ruleId: key.slice(index + 2) }
}

export function loadBaselineRaw(file) {
  if (!existsSync(file)) return null
  return readJsonFile(file, null)
}

/**
 * baseline 的内存形态是扁平的 "文件::规则" -> 允许条数。
 * 磁盘形态按文件分组，便于人直接读、直接 diff 审查。
 * firstSeen 记录每条规则的首次入账日期；widenLog 记录每次显式放宽，供 CI 审计。
 */
export function loadBaseline(file) {
  if (!existsSync(file)) {
    return { version: BASELINE_VERSION, entries: {}, ratchets: {}, firstSeen: {}, widenLog: [] }
  }
  return parseBaselineRaw(readJsonFile(file, {}))
}

/** 从磁盘原始形态解析账本；loadBaseline 与重命名迁移补回 HEAD 账本共用。 */
function parseBaselineRaw(raw) {
  const version = raw.version ?? BASELINE_VERSION
  if (version > BASELINE_VERSION) {
    throw new UserError(
      `baseline 的 schema version=${version}，当前 fe-guard 只支持 ${BASELINE_VERSION}。\n` +
        '  这是“账本比工具新”，继续读可能静默丢失新字段。\n' +
        '  升级工具：npm i -D fe-guard@latest。\n' +
        '  不要删除 baseline 重新生成——那会把已接受的历史欠债重新变成新增违规。',
    )
  }
  return {
    version,
    entries: flatten(raw.entries, true),
    ratchets: flatten(raw.ratchets, false),
    firstSeen: raw.firstSeen && typeof raw.firstSeen === 'object' ? { ...raw.firstSeen } : {},
    widenLog: Array.isArray(raw.widenLog) ? [...raw.widenLog] : [],
  }
}

/** 磁盘格式按文件分组；entries 是条数（取整），ratchets 是指标值（保留小数）。 */
function flatten(shape, integer) {
  const result = {}
  for (const [repoPath, rules] of Object.entries(shape ?? {})) {
    for (const [ruleId, value] of Object.entries(rules ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      result[baselineKey(repoPath, ruleId)] = integer ? Math.floor(value) : value
    }
  }
  return result
}

export function toDiskShape(values) {
  const byFile = new Map()
  for (const [key, value] of Object.entries(values)) {
    if (value <= 0) continue
    const { file, ruleId } = parseKey(key)
    if (!byFile.has(file)) byFile.set(file, {})
    byFile.get(file)[ruleId] = value
  }
  const shape = {}
  for (const file of [...byFile.keys()].sort()) {
    const rules = byFile.get(file)
    shape[file] = {}
    for (const ruleId of Object.keys(rules).sort()) shape[file][ruleId] = rules[ruleId]
  }
  return shape
}

export function saveBaseline(file, entries, ratchets = {}, { firstSeen = {}, widenLog = [] } = {}) {
  const seen = {}
  for (const key of Object.keys(firstSeen).sort()) {
    if (entries[key] === undefined && ratchets[key] === undefined) continue
    seen[key] = firstSeen[key]
  }
  const disk = {
    version: BASELINE_VERSION,
    note:
      '由 fe-guard 生成。entries 是「文件 + 规则 -> 允许的违规条数」；' +
      'ratchets 是「文件 + 指标 -> 允许的最大值」（单文件行数、重复率等）。' +
      '两者都只会自动收紧，不会自动放宽。firstSeen 是首次入账日期；widenLog 记录每次显式放宽，供 CI 审计。',
    entries: toDiskShape(entries),
    ratchets: toDiskShape(ratchets),
  }
  if (Object.keys(seen).length > 0) disk.firstSeen = seen
  if (widenLog.length > 0) disk.widenLog = widenLog
  writeJsonFile(file, disk)
}

/** init / 空账本用：保持和 saveBaseline 相同的键顺序与版本。 */
export function emptyBaseline() {
  return {
    version: BASELINE_VERSION,
    note:
      '由 fe-guard 生成。entries 是「文件 + 规则 -> 允许的违规条数」；' +
      'ratchets 是「文件 + 指标 -> 允许的最大值」。两者都只会自动收紧，不会自动放宽。' +
      'firstSeen 记录首次入账日期；widenLog 记录显式放宽，供 CI 审计。',
    entries: {},
    ratchets: {},
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10)
}

export function countByKey(violations) {
  const counts = {}
  for (const violation of violations) {
    const key = baselineKey(violation.file, violation.ruleId)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function sameEntries(a, b) {
  const keysA = Object.keys(a).filter((key) => a[key] > 0)
  const keysB = Object.keys(b).filter((key) => b[key] > 0)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => a[key] === b[key])
}

function compareViolations(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  const lineA = a.line ?? 0
  const lineB = b.line ?? 0
  if (lineA !== lineB) return lineA - lineB
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
  return String(a.message).localeCompare(String(b.message))
}

/**
 * 棘轮的核心：逐 (文件, 规则) 对比存量与当前。
 * 同一文件内「修掉一条旧规则、新增一条新规则」会让文件总数不变，
 * 但因为出现了新的 key，仍然会被判为新违规 —— 这是不用"总数"记账的原因。
 *
 * 传入的 entries 应当只包含本次判定范围内的 key（调用方负责范围过滤）。
 * 返回的 nextEntries 只包含这些范围内的 key 的最新值，0 值会被删除。
 */
export function evaluate(violations, entries) {
  const groups = new Map()
  for (const violation of [...violations].sort(compareViolations)) {
    const key = baselineKey(violation.file, violation.ruleId)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(violation)
  }

  const result = {
    violations: [],
    tightened: [],
    removed: [],
    knownCount: 0,
    newCount: 0,
  }
  const nextEntries = {}

  for (const [key, list] of groups) {
    const { file, ruleId } = parseKey(key)
    const allowed = entries[key] ?? 0
    list.forEach((violation, index) => {
      const status = index < allowed ? 'known' : 'new'
      if (status === 'known') result.knownCount += 1
      else result.newCount += 1
      result.violations.push({ ...violation, status })
    })
    if (list.length < allowed) {
      result.tightened.push({ file, ruleId, from: allowed, to: list.length })
    }
    // 只收紧不放宽：超出允许条数时保留原允许值（本次失败），0 则不写回。
    const next = Math.min(list.length, allowed)
    if (next > 0) nextEntries[key] = next
  }

  for (const [key, allowed] of Object.entries(entries)) {
    if (groups.has(key)) continue
    const { file, ruleId } = parseKey(key)
    if (allowed > 0) {
      result.removed.push({ file, ruleId, from: allowed, to: 0 })
      result.tightened.push({ file, ruleId, from: allowed, to: 0 })
    }
  }

  return { ...result, nextEntries }
}

/** 判断某个 baseline key 是否属于本次检查范围。 */
export function partitionEntries(entries, inScope) {
  const scoped = {}
  const rest = {}
  for (const [key, count] of Object.entries(entries)) {
    const { file, ruleId } = parseKey(key)
    if (inScope(file, ruleId)) scoped[key] = count
    else rest[key] = count
  }
  return { scoped, rest }
}

/**
 * 值棘轮：与条数棘轮同语义，但比较的是“指标的最大值”而不是违规条数。
 * - 当前值 <= 允许值：已知（通过），允许值自动收紧到当前值；
 * - 当前值 >  允许值：新增（失败），允许值保持不变（不放宽）；
 * - baseline 有、这次没测到：收紧到 0（说明已经降到配置阈值以下）。
 *
 * 每个 (文件, 指标) 一次只产生一条违规，value 是这次的实际测量值。
 */
export function evaluateRatchets(violations, allowed = {}) {
  const result = { violations: [], tightened: [], removed: [], knownCount: 0, newCount: 0 }
  const current = new Map()
  for (const violation of violations) {
    if (typeof violation.value !== 'number') continue
    const key = baselineKey(violation.file, violation.ruleId)
    const previous = current.get(key)
    if (!previous || violation.value > previous.value) current.set(key, violation)
  }

  const nextRatchets = {}
  for (const [key, violation] of current) {
    const { file, ruleId } = parseKey(key)
    const limit = allowed[key]
    const known = limit !== undefined && violation.value <= limit
    if (known) result.knownCount += 1
    else result.newCount += 1
    result.violations.push({ ...violation, status: known ? 'known' : 'new', allowed: limit ?? null })
    if (known) {
      nextRatchets[key] = violation.value
      if (violation.value < limit) {
        result.tightened.push({ file, ruleId, from: limit, to: violation.value })
      }
    }
  }

  for (const [key, limit] of Object.entries(allowed)) {
    if (current.has(key)) continue
    const { file, ruleId } = parseKey(key)
    result.removed.push({ file, ruleId, from: limit, to: 0 })
    result.tightened.push({ file, ruleId, from: limit, to: 0 })
  }

  return { ...result, nextRatchets }
}

/** baseline 命令用：把本次测到的指标值记成允许值（每条取最大值）。 */
export function countRatchets(violations) {
  const values = {}
  for (const violation of violations) {
    if (typeof violation.value !== 'number') continue
    const key = baselineKey(violation.file, violation.ruleId)
    values[key] = Math.max(values[key] ?? 0, violation.value)
  }
  return values
}

export function partitionRatchets(ratchets, inScope) {
  const scoped = {}
  const rest = {}
  for (const [key, value] of Object.entries(ratchets)) {
    const { file, ruleId } = parseKey(key)
    if (inScope(file, ruleId)) scoped[key] = value
    else rest[key] = value
  }
  return { scoped, rest }
}

/**
 * 重命名迁移：把旧路径的账本键搬到新路径。是合并而不是放宽——
 * 目标键已存在时 entries 求和、ratchets 取 max、firstSeen 取最早。
 * 返回迁移后的账本与明细（moved 供 widenLog 审计，也让 --verify 承认迁移后的键）。
 */
export function migrateRenames({ entries, ratchets, firstSeen }, pairs) {
  const next = { entries: { ...entries }, ratchets: { ...ratchets }, firstSeen: { ...firstSeen } }
  const moved = []
  for (const { from, to } of pairs) {
    if (from === to) continue
    for (const [track, merge] of [
      ['entries', (a, b) => a + b],
      ['ratchets', (a, b) => Math.max(a, b)],
    ]) {
      for (const key of Object.keys(next[track])) {
        const { file, ruleId } = parseKey(key)
        if (file !== from) continue
        const target = baselineKey(to, ruleId)
        const value = next[track][key]
        delete next[track][key]
        next[track][target] = merge(next[track][target] ?? 0, value)
        moved.push({ file: to, ruleId, kind: track === 'entries' ? 'entry' : 'ratchet', from: 0, to: next[track][target] })
        const oldSince = next.firstSeen[key]
        const newSince = next.firstSeen[target]
        delete next.firstSeen[key]
        if (oldSince && (!newSince || oldSince < newSince)) next.firstSeen[target] = oldSince
      }
    }
  }
  return { ...next, moved }
}

/**
 * 重命名迁移的补回：check 的自动收紧可能已把旧路径条目删掉。
 * 从 HEAD 提交的账本补回被重命名文件的缺失键（只补缺失，不覆盖当前值）。
 */
export async function restoreRenamedKeys({ root, rel, previous, pairs }) {
  // ./ 前缀：git show <rev>:<path> 默认相对 git 根，子目录根下必须用 cwd 相对形式。
  const result = await run('git', ['show', `HEAD:./${rel}`], { cwd: root })
  if (result.code !== 0) return
  let head
  try {
    head = parseBaselineRaw(JSON.parse(result.stdout))
  } catch {
    return
  }
  const renamed = new Set(pairs.map((pair) => pair.from))
  for (const track of ['entries', 'ratchets']) {
    for (const [key, value] of Object.entries(head[track])) {
      if (renamed.has(parseKey(key).file) && previous[track][key] === undefined) previous[track][key] = value
    }
  }
  for (const [key, since] of Object.entries(head.firstSeen)) {
    if (renamed.has(parseKey(key).file) && previous.firstSeen[key] === undefined) previous.firstSeen[key] = since
  }
}
