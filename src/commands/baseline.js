import path from 'node:path'
import { adapterOfRule, checkEnabled, isBaselineExempt, loadConfig } from '../config.js'
import { activeChecks } from '../runners/index.js'
import { loadBaseline, migrateRenames, restoreRenamedKeys, saveBaseline, sameEntries } from '../baseline.js'
import { renamedFiles } from '../git.js'
import { collectBaselineTrend, formatTrend } from '../trend.js'
import { UserError, toPosix } from '../utils.js'
import { detectWorkspace } from '../workspace.js'
import {
  applyMigratePackages,
  assertNoStaleRootEntries,
  loadLedgerLayout,
  planMigratePackages,
  splitByOwner,
  summarizeBaseline,
} from '../baseline-packages.js'
import {
  collectCurrent,
  compareWithBase,
  printCommitAdvice,
  printUpdateSummary,
  printVerifyResult,
  readBaseRaw,
  reportBlocking,
  resolveBase,
  showBaseline as showLedger,
  loadBaselineView,
  planUpdate,
} from './baseline-shared.js'

/**
 * baseline 子命令：
 * - 默认 / --widen：把当前真实违规记录为账本（--widen 才允许放宽已有条目）；
 * - --show：按文件分组展示每条规则、数量、首次入账日期；
 * - --verify：CI 用，对比 merge-base（--base / GITHUB_BASE_REF），未在 widenLog 里登记的放宽一律失败；
 * - --trend：只读账本 git 历史；
 * - --migrate-packages：把根账本拆到各 workspace package。
 *
 * package 模式（baseline.strategy="package"）只改变“账本有几本、写到哪里”，
 * 判定与写回语义和根模式保持一致；具体纯逻辑在 baseline-shared.js。
 */
export async function baselineCommand({
  root,
  widen,
  show,
  verify,
  all,
  json,
  base,
  byRule,
  followRenames,
  configPath,
  trend,
  limit,
  packageName,
  migratePackages,
  dryRun,
}) {
  const config = loadConfig(root, { configPath })
  const baselinePath = path.join(root, config.baseline.path)

  if (migratePackages) return migrateBaseline({ root, config, dryRun })

  // 趋势只读 git 历史，不写账本，也不受“检查全局关闭”影响。
  if (trend) return trendBaseline({ root, config, baselinePath, json, limit, packageName })

  if (show) return showBaselineCommand({ root, config, baselinePath, all, json, byRule, packageName })

  // --verify 只读 baseline 与 git，即使检查被关闭也要能校验“账本有没有被偷偷放宽”。
  if (verify) return verifyBaseline({ root, config, baselinePath, json, base, packageName })

  if (packageName !== undefined) {
    throw new UserError('--package 只能与 --show / --verify / --trend 一起使用。')
  }

  if (!config.enabled || activeChecks(config).length === 0) {
    throw new UserError('检查已全局关闭（或没有任何启用的检查项），拒绝在关闭状态下重写 baseline，以免误清历史账本。')
  }

  if (config.baseline.strategy === 'package') {
    return updatePackages({ root, config, widen, followRenames })
  }
  return updateRoot({ root, config, baselinePath, widen, followRenames })
}

async function updateRoot({ root, config, baselinePath, widen, followRenames }) {
  const previous = loadBaseline(baselinePath)
  let migration = null
  if (followRenames) {
    const pairs = await renamedFiles({ root })
    if (pairs.length === 0) {
      console.log('fe-guard: 未检测到重命名（重命名的文件需先 git add 才能被配对），按常规记录。')
    } else {
      await restoreRenamedKeys({ root, rel: toPosix(path.relative(root, baselinePath)), previous, pairs })
      const { entries, ratchets, firstSeen, moved } = migrateRenames(previous, pairs)
      previous.entries = entries
      previous.ratchets = ratchets
      previous.firstSeen = firstSeen
      migration = { pairs, moved }
    }
  }
  const enabled = (ruleId) => checkEnabled(config, adapterOfRule(ruleId)) && !isBaselineExempt(ruleId)
  const { current, currentRatchets } = await collectCurrent({ root, config })
  const plan = planUpdate({ previous, enabled, current, currentRatchets, widen })
  if (plan.blocking.length > 0 && !widen) return reportBlocking(plan.blocking)

  if (migration) {
    plan.widenLog.push({ at: new Date().toISOString(), type: 'rename-migration', pairs: migration.pairs, items: migration.moved })
  }
  saveBaseline(baselinePath, plan.nextEntries, plan.nextRatchets, {
    firstSeen: plan.firstSeen,
    widenLog: plan.widenLog,
  })
  printUpdateSummary({ config, previous, plan, current, currentRatchets })
  if (migration) {
    console.log(`  重命名迁移: ${migration.pairs.length} 个文件，${migration.moved.length} 条账本条目（widenLog 已留痕，--verify 可承认）`)
  }
  return 0
}

/**
 * package 模式更新：只跑一次真实检查，按文件归属拆到每本账；
 * 有 blocking 且没加 --widen 时一本都不写，避免“部分包被放宽、部分包没写”的半成品状态。
 */
async function updatePackages({ root, config, widen, followRenames }) {
  if (followRenames) {
    throw new UserError(
      'package 模式暂不支持 --follow-renames：重命名可能同时改变文件归属，需要先确认账本拆分正确，再手动处理跨包移动。\n' +
        '  可先运行 npx fe-guard baseline --show 查看各账本，或回到 root 模式完成迁移。',
    )
  }
  const workspace = detectWorkspace(root)
  const layout = loadLedgerLayout({ root, config, workspace })
  assertNoStaleRootEntries(layout.ledgers)

  const enabled = (ruleId) => checkEnabled(config, adapterOfRule(ruleId)) && !isBaselineExempt(ruleId)
  const { current, currentRatchets } = await collectCurrent({ root, config })
  const currentByOwner = splitByOwner(current, layout.packages)
  const ratchetsByOwner = splitByOwner(currentRatchets, layout.packages)

  const rows = layout.ledgers.map((ledger) => {
    const ownerCurrent = currentByOwner.get(ledger.pkg.rel) ?? {}
    const ownerRatchets = ratchetsByOwner.get(ledger.pkg.rel) ?? {}
    return {
      ledger,
      previous: ledger.baseline,
      current: ownerCurrent,
      currentRatchets: ownerRatchets,
      plan: planUpdate({
        previous: ledger.baseline,
        enabled,
        current: ownerCurrent,
        currentRatchets: ownerRatchets,
        widen,
      }),
    }
  })

  const blocking = rows.flatMap((row) =>
    row.plan.blocking.map((item) => ({ ...item, packageLabel: row.ledger.label })),
  )
  if (blocking.length > 0 && !widen) return reportBlocking(blocking)

  for (const row of rows) {
    const { ledger, previous, plan } = row
    const changed =
      !sameEntries(previous.entries, plan.nextEntries) ||
      !sameEntries(previous.ratchets, plan.nextRatchets) ||
      plan.widenLog.length !== previous.widenLog.length
    const empty = Object.keys(plan.nextEntries).length + Object.keys(plan.nextRatchets).length === 0
    const written = changed && (ledger.exists || !empty)
    if (written) {
      saveBaseline(ledger.file, plan.nextEntries, plan.nextRatchets, {
        firstSeen: plan.firstSeen,
        widenLog: plan.widenLog,
      })
    }
    // 不存在的空账本不创建文件，也不打印“已更新”的假摘要。
    if (ledger.exists || written) {
      printUpdateSummary({
        config,
        previous,
        plan,
        current: row.current,
        currentRatchets: row.currentRatchets,
        label: ledgerLabel(ledger),
        advice: false,
      })
    }
  }
  console.log('')
  printCommitAdvice()
  return 0
}

function ledgerLabel(ledger) {
  return ledger.pkg.isRoot ? ledger.relPath : `${ledger.label} (${ledger.relPath})`
}

/** show/verify/trend 的 package 选择：读全量布局，selector 只决定展示哪一本。 */
function packageLayout({ root, config, selector }) {
  return loadLedgerLayout({ root, config, workspace: detectWorkspace(root), selector })
}

async function showBaselineCommand({ root, config, baselinePath, all, json, byRule, packageName }) {
  if (config.baseline.strategy !== 'package') {
    // root 模式只有一本账；这里显式触发 loadLedgerLayout 的统一报错。
    if (packageName !== undefined) packageLayout({ root, config, selector: packageName })
    return showLedger({ config, baselinePath, all, json, byRule })
  }
  const layout = packageLayout({ root, config, selector: packageName })
  if (layout.selected) {
    const ledger = layout.ledgers[0]
    return showLedger({
      config,
      baselinePath: ledger.file,
      all,
      json,
      byRule,
      view: ledgerView(ledger),
      label: ledger.relPath,
      jsonExtra: { package: ledger.pkg.name, path: ledger.relPath },
    })
  }

  if (json) {
    const ledgers = layout.ledgers.map((ledger) => ({
      package: ledger.pkg.name,
      label: ledger.label,
      path: ledger.relPath,
      exists: ledger.exists,
      version: ledger.exists ? ledger.baseline.version : null,
      entries: ledger.baseline.entries,
      ratchets: ledger.baseline.ratchets,
      firstSeen: ledger.baseline.firstSeen,
      summary: summarizeBaseline(ledger.baseline),
    }))
    console.log(JSON.stringify({ strategy: 'package', ledgers }, null, 2))
    return 0
  }

  const existing = layout.ledgers.filter((ledger) => ledger.exists)
  if (existing.length === 0) {
    console.log('还没有任何 package 账本：跑一次 npx fe-guard baseline 把存量记进来。')
    return 0
  }
  existing.forEach((ledger, index) => {
    console.log(`== ${ledger.label} (${ledger.relPath}) ==`)
    showLedger({
      config,
      baselinePath: ledger.file,
      all,
      json: false,
      byRule,
      view: ledgerView(ledger),
      label: ledger.relPath,
    })
    if (index < existing.length - 1) console.log('')
  })
  return 0
}

/** 直接把 layout 里已解析的账本塞给 show，避免同一本账重复读盘。 */
function ledgerView(ledger) {
  return {
    raw: ledger.exists ? { version: ledger.baseline.version } : null,
    baseline: ledger.baseline,
  }
}

async function trendBaseline({ root, config, baselinePath, json, limit, packageName }) {
  if (config.baseline.strategy !== 'package') {
    if (packageName !== undefined) packageLayout({ root, config, selector: packageName })
    const data = await collectBaselineTrend({ root, baselinePath, limit })
    console.log(json ? JSON.stringify(data, null, 2) : formatTrend(data))
    return 0
  }

  const layout = packageLayout({ root, config, selector: packageName })
  if (layout.selected) {
    const ledger = layout.ledgers[0]
    const data = await collectBaselineTrend({ root, baselinePath: ledger.file, limit })
    console.log(
      json ? JSON.stringify({ ...data, package: ledger.pkg.name, path: ledger.relPath }, null, 2) : formatTrend(data),
    )
    return 0
  }

  const existing = layout.ledgers.filter((ledger) => ledger.exists)
  if (existing.length === 0) {
    console.log('还没有任何 package 账本，趋势暂无数据：先跑一次 npx fe-guard baseline 并把账本提交。')
    return 0
  }
  const ledgers = []
  for (const ledger of existing) {
    const data = await collectBaselineTrend({ root, baselinePath: ledger.file, limit })
    ledgers.push({ package: ledger.pkg.name, label: ledger.label, path: ledger.relPath, trend: data })
  }
  if (json) {
    console.log(
      JSON.stringify(
        { mode: 'package', ledgers: ledgers.map(({ package: name, path: rel, trend }) => ({ package: name, path: rel, trend })) },
        null,
        2,
      ),
    )
    return 0
  }
  ledgers.forEach((ledger, index) => {
    console.log(`== ${ledger.label} (${ledger.path}) ==`)
    console.log(formatTrend(ledger.trend))
    if (index < ledgers.length - 1) console.log('')
  })
  return 0
}

async function verifyBaseline({ root, config, baselinePath, json, base, packageName }) {
  if (config.baseline.strategy !== 'package') {
    if (packageName !== undefined) packageLayout({ root, config, selector: packageName })
    const view = loadBaselineView(baselinePath)
    if (!view.raw) {
      throw new UserError(`找不到 ${path.relative(root, baselinePath)}，无法校验 baseline。`)
    }
    const rel = toPosix(path.relative(root, baselinePath))
    const baselineRef = await resolveBase(root, base)
    const { raw } = await readBaseRaw({ root, rel, baselineRef })
    const comparison = compareWithBase(raw ?? { entries: {}, ratchets: {} }, view.baseline)
    if (json) {
      console.log(JSON.stringify({ ok: comparison.unapproved.length === 0, base: baselineRef, ...comparison }, null, 2))
      return comparison.unapproved.length === 0 ? 0 : 1
    }
    printVerifyResult({ rel, baselineRef, comparison })
    return comparison.unapproved.length === 0 ? 0 : 1
  }

  const layout = packageLayout({ root, config, selector: packageName })
  const baselineRef = await resolveBase(root, base)
  const results = []
  for (const ledger of layout.ledgers) {
    const { raw } = await readBaseRaw({ root, rel: ledger.relPath, baselineRef })
    const baseExists = raw !== null
    if (!ledger.exists && !baseExists) {
      if (layout.selected) {
        throw new UserError(
          `找不到 ${ledger.relPath}，基线里也没有这本账；无法校验 package "${ledger.pkg.name}"。`,
        )
      }
      continue
    }
    if (!ledger.exists && baseExists) {
      results.push({
        package: ledger.pkg.name,
        label: ledger.label,
        path: ledger.relPath,
        exists: false,
        deleted: true,
        comparison: null,
      })
      continue
    }
    results.push({
      package: ledger.pkg.name,
      label: ledger.label,
      path: ledger.relPath,
      exists: true,
      deleted: false,
      comparison: compareWithBase(raw ?? { entries: {}, ratchets: {} }, ledger.baseline),
    })
  }

  const ok = results.every((item) => !item.deleted && item.comparison.unapproved.length === 0)
  if (json) {
    const ledgers = results.map(({ package: name, path: rel, exists, deleted, comparison }) => ({
      package: name,
      path: rel,
      exists,
      deleted,
      comparison,
    }))
    console.log(JSON.stringify({ ok, mode: 'package', base: baselineRef, ledgers }, null, 2))
    return ok ? 0 : 1
  }
  if (results.length === 0) {
    console.log('没有任何 package 账本可校验。')
    return 0
  }
  results.forEach((item, index) => {
    console.log(`== ${item.label} (${item.path}) ==`)
    printVerifyResult({ rel: item.path, baselineRef, comparison: item.comparison, deleted: item.deleted })
    if (index < results.length - 1) console.log('')
  })
  return ok ? 0 : 1
}

/** 把根账本里属于 workspace package 的条目拆到各自账本；冲突时不写任何文件。 */
function migrateBaseline({ root, config, dryRun }) {
  const plan = planMigratePackages({ root, config, workspace: detectWorkspace(root) })
  if (plan.conflicts.length > 0) {
    console.error('fe-guard baseline --migrate-packages 被拒绝：目标 package 账本里已有同 key 不同值。')
    plan.conflicts.forEach((item) => {
      console.error(`  ${item.package}  ${item.path}  ${item.key}  ${item.from} -> ${item.to}`)
    })
    console.error('')
    console.error('请先人工确认两份账本哪一份是对的，再重新迁移；本次没有写入任何文件。')
    return 2
  }
  if (!plan.rootLedger.exists) {
    console.log(`根账本 ${plan.rootLedger.relPath} 不存在，没有可迁移的条目。`)
    return 0
  }
  if (plan.moved.length === 0) {
    console.log(`根账本 ${plan.rootLedger.relPath} 里没有 package 文件条目，不需要迁移。`)
    return 0
  }

  console.log(
    dryRun
      ? 'fe-guard baseline --migrate-packages --dry-run（只预览，不写文件）'
      : 'fe-guard baseline --migrate-packages',
  )
  for (const item of plan.moved) {
    console.log(
      `  ${item.pkg.name} -> ${item.ledger.relPath}  ` +
        `条目 ${item.entryCount} / 指标 ${item.ratchetCount}`,
    )
  }
  console.log(
    `  根账本剩余: ${Object.keys(plan.rootEntries).length} 条条目 / ` +
      `${Object.keys(plan.rootRatchets).length} 条指标`,
  )
  if (!dryRun) {
    applyMigratePackages(plan)
    console.log(`  已写入 ${plan.moved.length} 本 package 账本（保留 firstSeen，并记录 initial-adoption）。`)
  }
  if (config.baseline.strategy === 'root') {
    console.log('提示：文件已就绪；把 baseline.strategy 改为 "package" 后生效。')
  }
  return 0
}
