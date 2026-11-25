import { isBaselineExempt } from '../config.js'
import { runChecks } from '../runners/index.js'
import {
  countByKey,
  countRatchets,
  loadBaseline,
  loadBaselineRaw,
  parseKey,
  today,
  toDiskShape,
} from '../baseline.js'
import { UserError, run } from '../utils.js'

/**
 * baseline 命令的根模式内核：记录、展示、比较都只依赖账本与 git。
 * package 模式复用这里的纯逻辑，只在“跑哪些账、写到哪”上做多账本编排。
 */

const COMMIT_ADVICE =
  '提交建议: baseline 变更单独提交，并在说明里写清“首次入账”或“为什么接受这批新欠债”。'

export async function collectCurrent({ root, config }) {
  const violations = await runChecks({ root, config, changedFiles: null, mode: 'full' })
  const countable = violations.filter(
    (violation) => typeof violation.value !== 'number' && !isBaselineExempt(violation.ruleId),
  )
  const measurable = violations.filter((violation) => typeof violation.value === 'number')
  return { current: countByKey(countable), currentRatchets: countRatchets(measurable) }
}

export function planUpdate({ previous, enabled, current, currentRatchets, widen }) {
  const enabledEntries = filterKeys(previous.entries, enabled)
  const enabledRatchets = filterKeys(previous.ratchets, enabled)
  const countWidened = widerCounts(current, enabledEntries)
  const ratchetWidened = widerRatchets(currentRatchets, enabledRatchets)
  const widened = [...countWidened, ...ratchetWidened]
  // 两条轨道分别判断“首次入账”：老项目第一次接入 metrics 时不该被条数轨道的历史挡住。
  const firstEntries = Object.keys(enabledEntries).length === 0
  const firstRatchets = Object.keys(enabledRatchets).length === 0
  const blocking = [...(firstEntries ? [] : countWidened), ...(firstRatchets ? [] : ratchetWidened)]

  const nextEntries = { ...filterKeys(previous.entries, (ruleId) => !enabled(ruleId)), ...current }
  const nextRatchets = { ...filterKeys(previous.ratchets, (ruleId) => !enabled(ruleId)), ...currentRatchets }
  const firstSeen = {}
  for (const key of Object.keys(nextEntries).concat(Object.keys(nextRatchets))) {
    firstSeen[key] = previous.firstSeen[key] ?? today()
  }

  // 条数首次入账不应把指标轨道的后续放宽也标成 initial-adoption。
  const initialEntries = firstEntries ? countWidened : []
  const initialRatchets = firstRatchets ? ratchetWidened : []
  const explicitWiden = widened.filter((item) => (item.kind === 'entry' ? !firstEntries : !firstRatchets))
  const widenLog = buildWidenLog({ previous, widen, initialEntries, initialRatchets, explicitWiden })
  return { blocking, nextEntries, nextRatchets, firstSeen, widenLog, widened, initialEntries, initialRatchets, explicitWiden }
}

function buildWidenLog({ previous, widen, initialEntries, initialRatchets, explicitWiden }) {
  const widenLog = [...previous.widenLog]
  if (initialEntries.length > 0 || initialRatchets.length > 0) {
    widenLog.push({
      at: new Date().toISOString(),
      type: 'initial-adoption',
      entries: initialEntries.length,
      ratchets: initialRatchets.length,
    })
  }
  if (widen && explicitWiden.length > 0) {
    widenLog.push({
      at: new Date().toISOString(),
      type: 'widen',
      items: explicitWiden.map((item) => ({
        file: item.file,
        ruleId: item.ruleId,
        kind: item.kind,
        from: item.from,
        to: item.to,
      })),
    })
  }
  return widenLog
}

/** package 模式的 blocking 条目会带 packageLabel，输出时附在行首，便于直接定位账本。 */
export function reportBlocking(blocking) {
  console.error('fe-guard baseline 被拒绝：以下条目会让 baseline 变宽（历史欠债增加）。')
  blocking.forEach((item) => {
    const prefix = item.packageLabel ? `[${item.packageLabel}] ` : ''
    console.error(`  ${prefix}${item.file}  ${item.ruleId}  ${item.from} -> ${item.to}`)
  })
  console.error('')
  console.error('如果这些是本次有意接受的欠债，请加 --widen 重跑，并在提交说明里写清原因。')
  return 2
}

export function printCommitAdvice() {
  console.log(COMMIT_ADVICE)
}

export function printUpdateSummary({ config, previous, plan, current, currentRatchets, label = config.baseline.path, advice = true }) {
  const { nextEntries, nextRatchets, widened, initialEntries, initialRatchets, explicitWiden } = plan
  const added = Object.keys(nextEntries).filter((key) => previous.entries[key] === undefined)
  const addedRatchets = Object.keys(nextRatchets).filter((key) => previous.ratchets[key] === undefined)
  const tightened = Object.entries(nextEntries).filter(([key, count]) => (previous.entries[key] ?? 0) > count)
  const tightenedRatchets = Object.entries(nextRatchets).filter(([key, value]) => (previous.ratchets[key] ?? 0) > value)
  const removed =
    Object.keys(previous.entries).filter((key) => nextEntries[key] === undefined).length +
    Object.keys(previous.ratchets).filter((key) => nextRatchets[key] === undefined).length

  const total = Object.values(current).reduce((sum, count) => sum + count, 0)
  const lines = [
    `fe-guard baseline 已更新: ${label}`,
    `  当前条数型违规: ${total}，涉及 ${Object.keys(toDiskShape(current)).length} 个文件`,
    `  当前指标型条目: ${Object.keys(currentRatchets).length}`,
    `  新增条目: ${added.length + addedRatchets.length}，收紧: ${tightened.length + tightenedRatchets.length}，删除: ${removed}`,
  ]
  if (widened.length > 0) {
    const initialCount = initialEntries.length + initialRatchets.length
    if (initialCount > 0) lines.push(`  首次记录存量: ${initialCount}`)
    if (explicitWiden.length > 0) lines.push(`  显式放宽（--widen）: ${explicitWiden.length}`)
    widened.slice(0, 20).forEach((item) => lines.push(`    ${item.file}  ${item.ruleId}  ${item.from} -> ${item.to}`))
    if (widened.length > 20) lines.push(`    ...还有 ${widened.length - 20} 项，用 baseline --show 按文件查看`)
  }
  if (advice) {
    lines.push('')
    lines.push(COMMIT_ADVICE)
  }
  console.log(lines.join('\n'))
}

/** 已加载的账本视图：package 模式直接把 layout 里的 baseline 传进来，避免重复读盘。 */
export function loadBaselineView(file) {
  const raw = loadBaselineRaw(file)
  return { raw, baseline: loadBaseline(file) }
}

export function showBaseline({ config, baselinePath, all, json, byRule, view, label, jsonExtra }) {
  const state = view ?? loadBaselineView(baselinePath)
  const { raw, baseline } = state
  const display = label ?? config.baseline.path
  if (byRule) return showByRule({ config, raw, baseline, json, label: display, jsonExtra })

  const files = new Map()
  for (const [key, count] of Object.entries(baseline.entries)) {
    const { file, ruleId } = parseKey(key)
    if (!files.has(file)) files.set(file, [])
    files.get(file).push({ ruleId, value: count, kind: 'entry', since: baseline.firstSeen[key] ?? null })
  }
  for (const [key, value] of Object.entries(baseline.ratchets)) {
    const { file, ruleId } = parseKey(key)
    if (!files.has(file)) files.set(file, [])
    files.get(file).push({ ruleId, value, kind: 'ratchet', since: baseline.firstSeen[key] ?? null })
  }

  const groups = [...files.entries()]
    .map(([file, rules]) => ({
      file,
      rules: rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1)),
      total: rules.reduce((sum, rule) => sum + rule.value, 0),
    }))
    .sort((a, b) => b.total - a.total || (a.file < b.file ? -1 : 1))

  if (json) {
    console.log(
      JSON.stringify(
        { version: raw?.version ?? null, entries: baseline.entries, ratchets: baseline.ratchets, firstSeen: baseline.firstSeen, groups, ...jsonExtra },
        null,
        2,
      ),
    )
    return 0
  }
  if (groups.length === 0) {
    console.log(`baseline 还是空的（${display}）：跑一次 npx fe-guard baseline 把存量记进来。`)
    return 0
  }

  const limit = all ? groups.length : 20
  console.log(`fe-guard baseline: ${display}（version ${raw?.version ?? '?'}）`)
  console.log(
    `  ${groups.length} 个文件，${Object.keys(baseline.entries).length} 条规则型 + ` +
      `${Object.keys(baseline.ratchets).length} 条指标型`,
  )
  console.log('')
  groups.slice(0, limit).forEach((group) => {
    console.log(`${group.file}  (${group.rules.length} 项)`)
    group.rules.forEach((rule) => {
      const unit = rule.kind === 'ratchet' ? '指标上限' : '条'
      const since = rule.since ? `，首次 ${rule.since}` : '，首次 未知（旧版账本）'
      console.log(`  ${rule.ruleId}  ${rule.value} ${unit}${since}`)
    })
  })
  if (groups.length > limit) console.log(`...还有 ${groups.length - limit} 个文件，用 --all 查看`)
  console.log('')
  console.log('这些是已经接受的存量欠债，不是新增问题；收紧会自动发生，放宽必须 --widen 并留下记录。')
  return 0
}

/** 按规则聚合：直接回答“先修哪几条能消掉最多条”。 */
function showByRule({ config, raw, baseline, json, label = config.baseline.path, jsonExtra }) {
  const rules = new Map()
  const touch = (ruleId, kind, file, value, since) => {
    if (!rules.has(ruleId)) {
      rules.set(ruleId, { ruleId, kind, count: 0, files: new Set(), firstSeen: since ?? null })
    }
    const item = rules.get(ruleId)
    item.count += kind === 'entry' ? value : 1
    item.files.add(file)
    if (since && (!item.firstSeen || since < item.firstSeen)) item.firstSeen = since
  }
  for (const [key, count] of Object.entries(baseline.entries)) {
    const { file, ruleId } = parseKey(key)
    touch(ruleId, 'entry', file, count, baseline.firstSeen[key])
  }
  for (const [key] of Object.entries(baseline.ratchets)) {
    const { file, ruleId } = parseKey(key)
    touch(ruleId, 'ratchet', file, 1, baseline.firstSeen[key])
  }

  const list = [...rules.values()]
    .map((item) => ({ ...item, files: item.files.size }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
  const totalEntries = Object.values(baseline.entries).reduce((sum, value) => sum + value, 0)

  if (json) {
    console.log(JSON.stringify({ version: raw?.version ?? null, totalEntries, rules: list, ...jsonExtra }, null, 2))
    return 0
  }
  if (list.length === 0) {
    console.log(`baseline 还是空的（${label}）：跑一次 npx fe-guard baseline 把存量记进来。`)
    return 0
  }

  console.log(`fe-guard baseline --by-rule: ${label}（version ${raw?.version ?? '?'}）`)
  console.log(`  条数型存量共 ${totalEntries} 条，分布在 ${list.length} 条规则上`)
  console.log('')
  console.log('按可清理条数排序（先修上面的，收益最大）：')
  list.slice(0, 20).forEach((item, index) => {
    const unit = item.kind === 'ratchet' ? '个文件命中指标' : '条'
    const since = item.firstSeen ? `，首次 ${item.firstSeen}` : ''
    console.log(`  ${String(index + 1).padStart(2)}. ${item.ruleId}  ${item.count} ${unit}，涉及 ${item.files} 个文件${since}`)
  })
  if (list.length > 20) console.log(`  ...还有 ${list.length - 20} 条规则，用 --json 看全部`)
  const top3 = list.filter((item) => item.kind === 'entry').slice(0, 3)
  const topTotal = top3.reduce((sum, item) => sum + item.count, 0)
  if (top3.length > 0) {
    const ratio = totalEntries > 0 ? Math.round((topTotal / totalEntries) * 1000) / 10 : 0
    console.log('')
    console.log(
      `下一步: 先修 ${top3.map((item) => item.ruleId).join(' / ')}，预计减少 ${topTotal} 条` +
        `（占条数型存量的 ${ratio}%）。`,
    )
  }
  console.log('  说明：这里只按数量排序，不代表修起来最容易；修完跑 baseline 会自动收紧。')
  return 0
}

/**
 * 读取基线提交里的账本。返回 { raw, missing }：
 * - missing=true 表示基线里还没有这本账（首次入账），调用方按空账本比较；
 * - 其余读取失败（对象不存在、不是 git 仓库等）必须报错，不能当成空账本放行。
 */
export async function readBaseRaw({ root, rel, baselineRef }) {
  const baseFile = await run('git', ['show', `${baselineRef.sha}:./${rel}`], { cwd: root })
  if (baseFile.missing) throw new UserError('--verify 需要 git，但当前环境找不到 git 命令。')
  if (baseFile.code !== 0) {
    const message = baseFile.stderr || baseFile.stdout || ''
    if (!/does not exist|exists on disk, but not in|not in '.*'|path .* not in/i.test(message)) {
      throw new UserError(
        `无法读取基线 ${baselineRef.ref}（${baselineRef.sha.slice(0, 8)}）里的 ${rel}。\n` +
          '首次接入时请先把 baseline 提交，再在 CI 里启用 --verify；如果是新仓库，请确认 --base 指向的提交里已有 baseline。\n' +
          message.trim(),
      )
    }
    return { raw: null, missing: true }
  }
  try {
    return { raw: JSON.parse(baseFile.stdout), missing: false }
  } catch {
    throw new UserError(`基线 ${baselineRef.ref} 里的 ${rel} 不是合法 JSON。`)
  }
}

/** 把当前账本与基线账本逐项比较：放宽、未登记放宽、首次入账。 */
export function compareWithBase(baseRaw, current) {
  const baseEntries = flattenRaw(baseRaw.entries, true)
  const baseRatchets = flattenRaw(baseRaw.ratchets, false)

  const widenings = []
  for (const [key, value] of Object.entries(current.entries)) {
    const before = baseEntries[key] ?? 0
    if (value > before) widenings.push({ ...parseKey(key), kind: 'entry', from: before, to: value })
  }
  for (const [key, value] of Object.entries(current.ratchets)) {
    const before = baseRatchets[key] ?? 0
    if (value > before) widenings.push({ ...parseKey(key), kind: 'ratchet', from: before, to: value })
  }

  const baseFirstEntries = Object.keys(baseEntries).length === 0
  const baseFirstRatchets = Object.keys(baseRatchets).length === 0
  const adoptedEntries =
    baseFirstEntries && current.widenLog.some((event) => event.type === 'initial-adoption' && event.entries > 0)
  const adoptedRatchets =
    baseFirstRatchets && current.widenLog.some((event) => event.type === 'initial-adoption' && event.ratchets > 0)

  const allowed = new Map()
  for (const event of current.widenLog) {
    for (const item of event.items ?? []) {
      const key = `${item.file}::${item.ruleId}`
      allowed.set(key, Math.max(allowed.get(key) ?? 0, item.to ?? 0))
    }
  }
  const unapproved = widenings.filter((item) => {
    if (item.kind === 'entry' ? adoptedEntries : adoptedRatchets) return false
    return (allowed.get(`${item.file}::${item.ruleId}`) ?? 0) < item.to
  })

  return {
    widenings,
    unapproved,
    baseEmpty: baseFirstEntries && baseFirstRatchets,
    adoptedEntries,
    adoptedRatchets,
  }
}

export function printVerifyResult({ rel, baselineRef, comparison, deleted = false }) {
  console.log(`fe-guard baseline --verify: ${rel}`)
  console.log(`  基线 ${baselineRef.ref}（merge-base ${baselineRef.sha.slice(0, 8)}）`)
  if (deleted) {
    console.log('  当前账本不存在，但基线里存在：账本被删除，历史欠债被静默解冻，拒绝通过。')
    console.log('  如果这个 package 确实已移除，请显式迁移账本并在提交说明里写清原因，不要直接删文件。')
    return 1
  }
  const { widenings, unapproved, baseEmpty, adoptedEntries, adoptedRatchets } = comparison
  if (baseEmpty) console.log('  基线里还没有 baseline 文件：按首次入账处理（需要 widenLog 的 initial-adoption 记录）')
  console.log(`  与基线对比：放宽 ${widenings.length} 项，其中未登记 ${unapproved.length} 项`)
  if ((adoptedEntries || adoptedRatchets) && widenings.length > 0) {
    const tracks = [adoptedEntries ? '条数' : null, adoptedRatchets ? '指标' : null].filter(Boolean).join(' / ')
    console.log(`  这是首次入账（基线账本里还没有${tracks}轨道），widenLog 里有 initial-adoption 记录。`)
  }
  if (widenings.length === 0) {
    console.log('  没有放宽，通过。收紧不需要确认。')
    return 0
  }
  if (unapproved.length === 0) {
    console.log('  所有放宽都能在 widenLog 里找到对应记录，通过。')
    return 0
  }
  console.log('')
  console.log('以下放宽没有 --widen 记录，属于“静默放宽”，拒绝通过：')
  unapproved.forEach((item) => console.log(`  ${item.file}  ${item.ruleId}  ${item.from} -> ${item.to}`))
  console.log('')
  console.log('如果确实要接受这批欠债：npx fe-guard baseline --widen，然后单独提交 baseline 并写明原因。')
  return 1
}

/**
 * 确定“上一次被批准的状态”：
 * 1. 显式 --base；
 * 2. CI 环境变量 GITHUB_BASE_SHA / GITHUB_BASE_REF（PR 的目标分支）；
 * 3. 本地分支的 upstream；
 * 4. 都没有就报错，绝不默认拿 HEAD（PR 里 HEAD 就是自己，等于永远通过）。
 */
export async function resolveBase(root, base) {
  const candidates = []
  if (base) candidates.push(base)
  else {
    if (process.env.GITHUB_BASE_SHA) candidates.push(process.env.GITHUB_BASE_SHA)
    if (process.env.GITHUB_BASE_REF) {
      candidates.push(`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF)
    }
    if (candidates.length === 0) {
      const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
        cwd: root,
      })
      if (upstream.code === 0 && upstream.stdout.trim()) candidates.push(upstream.stdout.trim())
    }
  }

  if (candidates.length === 0) {
    throw new UserError(
      'baseline --verify 无法确定比较基线，拒绝在“没有基线”的情况下判定通过。\n' +
        '  修复：显式传入 --base <ref>（例如 --base origin/main），或在 CI 里设置 GITHUB_BASE_REF / GITHUB_BASE_SHA。\n' +
        '  为什么不能默认 HEAD：CI 检出的 HEAD 就是 PR 自己，放宽会随 PR 一起提交，对比 HEAD 永远得到 0 项放宽。',
    )
  }

  const failures = []
  for (const candidate of candidates) {
    const mergeBase = await run('git', ['merge-base', 'HEAD', candidate], { cwd: root })
    if (mergeBase.missing) throw new UserError('--verify 需要 git，但当前环境找不到 git 命令。')
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      return { ref: candidate, sha: mergeBase.stdout.trim() }
    }
    failures.push(`${candidate}: ${(mergeBase.stderr || mergeBase.stdout).trim() || '不是有效提交'}`)
  }

  throw new UserError(
    `baseline --verify 无法计算 merge-base（候选基线：${candidates.join(', ')}）。\n` +
      `  ${failures.join('\n  ')}\n` +
      '  修复：确认 --base 指向的分支已 fetch；shallow clone 请先 git fetch --unshallow 或 fetch 目标分支。',
  )
}

export function flattenRaw(shape, integer) {
  const result = {}
  for (const [file, rules] of Object.entries(shape ?? {})) {
    for (const [ruleId, value] of Object.entries(rules ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      result[`${file}::${ruleId}`] = integer ? Math.floor(value) : value
    }
  }
  return result
}

export function filterKeys(entries, predicate) {
  const result = {}
  for (const [key, value] of Object.entries(entries)) {
    const { ruleId } = parseKey(key)
    if (predicate(ruleId)) result[key] = value
  }
  return result
}

export function widerCounts(current, allowed) {
  const widened = []
  for (const [key, count] of Object.entries(current)) {
    const limit = allowed[key] ?? 0
    if (count > limit) {
      const { file, ruleId } = parseKey(key)
      widened.push({ file, ruleId, kind: 'entry', from: limit, to: count })
    }
  }
  return widened
}

export function widerRatchets(current, allowed) {
  const widened = []
  for (const [key, value] of Object.entries(current)) {
    const limit = allowed[key] ?? 0
    if (value > limit) {
      const { file, ruleId } = parseKey(key)
      widened.push({ file, ruleId, kind: 'ratchet', from: limit, to: value })
    }
  }
  return widened
}
