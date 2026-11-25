import path from 'node:path'
import { existsSync } from 'node:fs'
import { BASELINE_VERSION, loadBaseline, parseKey, saveBaseline, sameEntries } from './baseline.js'
import { readJsonFile, toPosix, UserError } from './utils.js'

/**
 * package 模式账本布局：
 * - 根包 / 仓库级文件（scripts、根配置）用 baseline.path；
 * - 每个 workspace package 用 <package>/<baseline.packageFile>。
 * 账本里的键仍是仓库相对路径，所以 check 的判定逻辑不用改。
 */

export const BASELINE_STRATEGIES = ['root', 'package']

export function normalizeBaselineStrategy(value, source) {
  const strategy = value ?? 'root'
  if (!BASELINE_STRATEGIES.includes(strategy)) {
    throw new UserError(`${source} 中 baseline.strategy 只能是 ${BASELINE_STRATEGIES.join(' / ')}，当前为 "${strategy}"`)
  }
  return strategy
}

/** package 模式下的账本路径：相对每个 package 目录，禁止绝对路径与 ..。 */
export function normalizeBaselinePackageFile(value, source) {
  const file = String(value ?? 'fe-guard.baseline.json').trim().replaceAll('\\', '/')
  const normalized = path.posix.normalize(file)
  if (
    !file ||
    path.isAbsolute(file) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    file.endsWith('/')
  ) {
    throw new UserError(`${source} 中 baseline.packageFile 必须是 package 内的相对文件路径，例如 "fe-guard.baseline.json"`)
  }
  return normalized
}

export function normalizePackageRel(rel) {
  const value = toPosix(String(rel ?? '')).replace(/^\.\/+/, '').replace(/\/+$/, '')
  return value === '.' ? '' : value
}

export function rootPackage(root) {
  const pkg = readJsonFile(path.join(root, 'package.json'), {})
  return { name: pkg?.name || '(root)', rel: '', dir: root, isRoot: true }
}

export function packageLabel(pkg) {
  return pkg?.isRoot ? '(root)' : pkg.rel
}

/** 根包永远存在；workspace 里的 "." 归一到根包，避免同一目录两本账。 */
export function packageList(root, workspace) {
  const rootEntry = rootPackage(root)
  const byRel = new Map([['', rootEntry]])
  for (const pkg of workspace?.packages ?? []) {
    const rel = normalizePackageRel(pkg.rel)
    if (!rel) {
      if (rootEntry.name === '(root)' && pkg.name) rootEntry.name = pkg.name
      continue
    }
    if (byRel.has(rel)) continue
    byRel.set(rel, { name: pkg.name || rel, rel, dir: pkg.dir || path.join(root, rel), isRoot: false })
  }
  return [...byRel.values()].sort((a, b) => {
    if (a.isRoot) return -1
    if (b.isRoot) return 1
    return a.rel < b.rel ? -1 : 1
  })
}

export function resolvePackageSelector(root, workspace, selector) {
  const raw = String(selector ?? '').trim()
  const list = packageList(root, workspace)
  const rel = normalizePackageRel(raw)
  const found = list.find(
    (pkg) =>
      pkg.rel === rel ||
      pkg.name === raw ||
      (pkg.isRoot && ['root', '(root)', '.', './'].includes(raw)),
  )
  if (!found) {
    const names = list.map((pkg) => (pkg.isRoot ? `${pkg.name} (root)` : `${pkg.name} (${pkg.rel})`))
    throw new UserError(`找不到 package "${selector}"。可用：${names.join('、')}`)
  }
  return found
}

export function ledgerRelPath(config, pkg) {
  if (pkg.isRoot) return toPosix(config.baseline.path)
  return path.posix.join(pkg.rel, config.baseline.packageFile)
}

export function loadLedger(root, config, pkg) {
  const relPath = ledgerRelPath(config, pkg)
  const file = path.join(root, relPath)
  const exists = existsSync(file)
  return { pkg, label: packageLabel(pkg), relPath, file, exists, baseline: loadBaseline(file) }
}

/**
 * 读取账本布局。selector 只用于 show/verify/trend；check 与 baseline 更新必须读全量。
 * root 模式永远只有一本根账本；package 模式要求 workspace。
 */
export function loadLedgerLayout({ root, config, workspace, selector }) {
  if (config.baseline.strategy !== 'package') {
    if (selector !== undefined && selector !== null) {
      throw new UserError('baseline.strategy 是 root，只有一本根账本；--package 只在 package 模式下使用。')
    }
    const pkg = rootPackage(root)
    return { strategy: 'root', packages: [pkg], ledgers: [loadLedger(root, config, pkg)], selected: null }
  }
  if (!workspace?.isWorkspace) {
    throw new UserError(
      'baseline.strategy="package" 需要 monorepo workspace（package.json workspaces / pnpm-workspace.yaml / lerna.json）。\n' +
        '  单仓库请把 baseline.strategy 设回 "root"。',
    )
  }
  const packages = packageList(root, workspace)
  const selected = selector === undefined || selector === null ? null : resolvePackageSelector(root, workspace, selector)
  const chosen = selected ? [selected] : packages
  return {
    strategy: 'package',
    packages,
    ledgers: chosen.map((pkg) => loadLedger(root, config, pkg)),
    selected,
  }
}

/** 文件归属：最长 package 前缀胜出，其它文件归根包。 */
export function ownerOfFile(file, packages) {
  const target = toPosix(file)
  let owner = packages.find((pkg) => pkg.isRoot) ?? packages[0]
  for (const pkg of packages) {
    if (pkg.isRoot) continue
    if (target === pkg.rel || target.startsWith(`${pkg.rel}/`)) {
      if (!owner || owner.isRoot || pkg.rel.length > owner.rel.length) owner = pkg
    }
  }
  return owner
}

/** 把 entries / ratchets / firstSeen 这类按 key 存的对象按 package 拆开。 */
export function splitByOwner(values, packages) {
  const result = new Map(packages.map((pkg) => [pkg.rel, {}]))
  for (const [key, value] of Object.entries(values ?? {})) {
    const owner = ownerOfFile(parseKey(key).file, packages)
    const bucket = result.get(owner.rel) ?? {}
    bucket[key] = value
    result.set(owner.rel, bucket)
  }
  return result
}

/**
 * package 模式下根账本不应再保留 package 文件条目，否则同一份欠债会被忽略或重复。
 * 迁移前的 check / baseline 更新在这里直接失败，绝不静默丢掉历史账本。
 */
export function assertNoStaleRootEntries(ledgers) {
  const rootLedger = ledgers.find((ledger) => ledger.pkg.isRoot)
  if (!rootLedger) return
  const packages = ledgers.map((ledger) => ledger.pkg)
  const stale = []
  for (const key of Object.keys(rootLedger.baseline.entries).concat(Object.keys(rootLedger.baseline.ratchets))) {
    const owner = ownerOfFile(parseKey(key).file, packages)
    if (!owner.isRoot) stale.push({ key, owner })
  }
  if (stale.length === 0) return
  const examples = stale.slice(0, 3).map((item) => `${parseKey(item.key).file} -> ${item.owner.rel}`)
  throw new UserError(
    `baseline.strategy="package"，但根账本 ${rootLedger.relPath} 里仍有 ${stale.length} 条 package 文件条目。\n` +
      `  例如：${examples.join('；')}\n` +
      '  先运行 npx fe-guard baseline --migrate-packages（加 --dry-run 可预览）把根账本拆到各 package，再重试。',
  )
}

/** 合并多本账，供 check 一次判定；重复 key 直接报错，避免两本账互相掩盖。 */
export function combineLedgers(ledgers) {
  const combined = { version: BASELINE_VERSION, entries: {}, ratchets: {}, firstSeen: {}, widenLog: [] }
  const ownerByKey = new Map()
  for (const ledger of ledgers) {
    for (const track of ['entries', 'ratchets']) {
      for (const [key, value] of Object.entries(ledger.baseline[track])) {
        const file = parseKey(key).file
        if (!ledger.pkg.isRoot && file !== ledger.pkg.rel && !file.startsWith(`${ledger.pkg.rel}/`)) {
          throw new UserError(
            `账本 ${ledger.relPath} 含不属于 package ${ledger.pkg.rel} 的文件 ${file}。\n` +
              '  先修正账本归属，或运行 baseline --migrate-packages 重新拆分。',
          )
        }
        if (combined[track][key] !== undefined) {
          throw new UserError(
            `账本条目重复：${key} 同时出现在 ${ownerByKey.get(key)} 与 ${ledger.relPath}。\n` +
              '  运行 npx fe-guard baseline --migrate-packages（先 --dry-run 预览）把根账本拆到 package。',
          )
        }
        combined[track][key] = value
        ownerByKey.set(key, ledger.relPath)
        if (ledger.baseline.firstSeen[key]) combined.firstSeen[key] = ledger.baseline.firstSeen[key]
      }
    }
  }
  return combined
}

/** check 的写回：只写有变化的账本；原本不存在的空账本不创建文件。 */
export function saveEvaluatedLedgers({ ledgers, nextEntries, nextRatchets, firstSeen }) {
  const packages = ledgers.map((ledger) => ledger.pkg)
  const entriesByOwner = splitByOwner(nextEntries, packages)
  const ratchetsByOwner = splitByOwner(nextRatchets, packages)
  const seenByOwner = splitByOwner(firstSeen, packages)
  const metadata = []
  let written = false
  let changed = false

  for (const ledger of ledgers) {
    const entries = entriesByOwner.get(ledger.pkg.rel) ?? {}
    const ratchets = ratchetsByOwner.get(ledger.pkg.rel) ?? {}
    const seen = seenByOwner.get(ledger.pkg.rel) ?? {}
    const ledgerChanged =
      !sameEntries(ledger.baseline.entries, entries) || !sameEntries(ledger.baseline.ratchets, ratchets)
    const shouldWrite = ledgerChanged && (ledger.exists || Object.keys(entries).length + Object.keys(ratchets).length > 0)
    if (shouldWrite) {
      saveBaseline(ledger.file, entries, ratchets, { firstSeen: seen, widenLog: ledger.baseline.widenLog })
      written = true
    }
    changed = changed || ledgerChanged
    metadata.push({
      package: ledger.pkg.name,
      label: ledger.label,
      path: ledger.relPath,
      exists: ledger.exists,
      changed: ledgerChanged,
      written: shouldWrite,
      entries: sumValues(entries),
      ratchets: Object.keys(ratchets).length,
    })
  }
  return { written, changed, ledgers: metadata }
}

/**
 * 迁移计划：把根账本里属于各 package 的条目搬到 package 账本。
 * 只计算不落盘；冲突（目标账本已有同 key 不同值）由调用方决定如何报错。
 */
export function planMigratePackages({ root, config, workspace }) {
  if (!workspace?.isWorkspace) {
    throw new UserError('--migrate-packages 需要 monorepo workspace；单仓库不需要拆分账本。')
  }
  const packages = packageList(root, workspace)
  const rootLedger = loadLedger(root, config, packages.find((pkg) => pkg.isRoot))
  const at = new Date().toISOString()
  if (!rootLedger.exists) {
    return { rootLedger, moved: [], conflicts: [], rootEntries: {}, rootRatchets: {}, rootFirstSeen: {}, at }
  }

  const splitEntries = splitByOwner(rootLedger.baseline.entries, packages)
  const splitRatchets = splitByOwner(rootLedger.baseline.ratchets, packages)
  const splitSeen = splitByOwner(rootLedger.baseline.firstSeen, packages)
  const moved = []
  const conflicts = []

  for (const pkg of packages) {
    if (pkg.isRoot) continue
    const entries = splitEntries.get(pkg.rel) ?? {}
    const ratchets = splitRatchets.get(pkg.rel) ?? {}
    if (Object.keys(entries).length + Object.keys(ratchets).length === 0) continue
    const target = loadLedger(root, config, pkg)
    for (const [track, values] of [
      ['entries', entries],
      ['ratchets', ratchets],
    ]) {
      for (const [key, value] of Object.entries(values)) {
        const existing = target.baseline[track][key]
        if (existing !== undefined && existing !== value) {
          conflicts.push({ package: pkg.name, path: target.relPath, key, kind: track, from: value, to: existing })
        }
      }
    }

    const movedEntryKeys = Object.keys(entries)
    const movedRatchetKeys = Object.keys(ratchets)
    const firstSeen = { ...target.baseline.firstSeen }
    for (const key of [...movedEntryKeys, ...movedRatchetKeys]) {
      const since = splitSeen.get(pkg.rel)?.[key]
      if (since && (!firstSeen[key] || since < firstSeen[key])) firstSeen[key] = since
    }
    const events = [...target.baseline.widenLog]
    if (!target.exists || Object.keys(target.baseline.entries).length + Object.keys(target.baseline.ratchets).length === 0) {
      // --verify 在基线里还没有这本账时，靠 initial-adoption 承认首次入账。
      events.push({
        at,
        type: 'initial-adoption',
        entries: movedEntryKeys.length,
        ratchets: movedRatchetKeys.length,
        source: 'migrate-packages',
      })
    }
    events.push({
      at,
      type: 'migrate-packages',
      from: rootLedger.relPath,
      to: target.relPath,
      entries: movedEntryKeys.length,
      ratchets: movedRatchetKeys.length,
    })
    moved.push({
      pkg,
      ledger: target,
      entries: { ...target.baseline.entries, ...entries },
      ratchets: { ...target.baseline.ratchets, ...ratchets },
      firstSeen,
      widenLog: events,
      entryCount: movedEntryKeys.length,
      ratchetCount: movedRatchetKeys.length,
    })
  }

  return {
    rootLedger,
    rootEntries: splitEntries.get('') ?? {},
    rootRatchets: splitRatchets.get('') ?? {},
    rootFirstSeen: splitSeen.get('') ?? {},
    moved,
    conflicts,
    at,
  }
}

/** 落盘迁移计划；调用方应先把 conflicts 报给用户，不要在冲突时调用。 */
export function applyMigratePackages(plan) {
  for (const item of plan.moved) {
    saveBaseline(item.ledger.file, item.entries, item.ratchets, {
      firstSeen: item.firstSeen,
      widenLog: item.widenLog,
    })
  }
  const widenLog = [
    ...plan.rootLedger.baseline.widenLog,
    {
      at: plan.at,
      type: 'migrate-packages',
      direction: 'out',
      packages: plan.moved.map((item) => item.pkg.name),
      entries: plan.moved.reduce((sum, item) => sum + item.entryCount, 0),
      ratchets: plan.moved.reduce((sum, item) => sum + item.ratchetCount, 0),
    },
  ]
  saveBaseline(plan.rootLedger.file, plan.rootEntries, plan.rootRatchets, {
    firstSeen: plan.rootFirstSeen,
    widenLog,
  })
}

export function summarizeBaseline(baseline) {
  const files = new Set(
    Object.keys(baseline.entries)
      .concat(Object.keys(baseline.ratchets))
      .map((key) => parseKey(key).file),
  )
  return {
    files: files.size,
    entries: sumValues(baseline.entries),
    ratchets: Object.keys(baseline.ratchets).length,
    rules: new Set(
      Object.keys(baseline.entries)
        .concat(Object.keys(baseline.ratchets))
        .map((key) => parseKey(key).ruleId),
    ).size,
  }
}

function sumValues(values) {
  return Object.values(values ?? {}).reduce((sum, value) => sum + value, 0)
}
