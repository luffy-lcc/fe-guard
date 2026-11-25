import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, resolveConfigFile, SUPPORTED_CHECKS } from '../config.js'
import { applyProfile } from '../check-core.js'
import { loadBaseline, parseKey } from '../baseline.js'
import { loadLedgerLayout, summarizeBaseline } from '../baseline-packages.js'
import { detectWorkspace, eslintConfigFor, tsconfigFor, hasVueFile } from '../workspace.js'
import { run, walkSourceFiles } from '../utils.js'

const LABELS = {
  eslint: 'ESLint',
  typescript: 'TypeScript',
  boundaries: '架构边界',
  deps: '依赖守卫',
  ui: '组件清单',
  metrics: '腐化指标',
  'diff-size': '大 diff',
}

/**
 * doctor：没有 CI、没人读 README 时的接入主入口。
 * 只做只读探测，不执行任何检查（耗时为“上次报告里的耗时”），所以随时可以跑。
 */
export async function doctorCommand({ root, configPath, profile, json }) {
  const baseConfig = loadConfig(root, { configPath })
  const requested = profile ?? baseConfig.profile
  const { config, profile: profileInfo } = applyProfile(baseConfig, requested)
  const workspace = detectWorkspace(root)
  const packages = workspace.isWorkspace
    ? workspace.packages.filter((pkg) => pkg.rel !== '')
    : [{ name: '(root)', dir: root, rel: '' }]

  const timings = readTimings(root, config)
  const baseline = await baselineOf({ root, config, workspace })

  const report = {
    root,
    profile: profileInfo,
    configFile: resolveConfigFile(root, configPath),
    workspace: {
      isWorkspace: workspace.isWorkspace,
      source: workspace.source ?? null,
      packages: workspace.packages.map((pkg) => pkg.rel || '.'),
    },
    checks: [],
    baseline,
  }

  for (const key of SUPPORTED_CHECKS) {
    const inProfile = profileInfo.checks.includes(key)
    const userEnabled = baseConfig.enabled && baseConfig.checks[key]?.enabled
    const item = {
      id: key,
      label: LABELS[key],
      status: !userEnabled ? 'disabled' : inProfile ? 'covered' : 'profile-skipped',
      covered: null,
      skipped: [],
      note: '',
      lastMs: timings?.[key]?.ms ?? null,
      lastStatus: timings?.[key]?.status ?? null,
    }
    if (item.status !== 'covered') {
      item.note = item.status === 'disabled' ? '配置里已关闭' : `档位 ${profileInfo.name} 不包含，需 check --full`
      report.checks.push(item)
      continue
    }
    Object.assign(item, coverageOf(key, root, config, workspace, packages))
    report.checks.push(item)
  }

  const empty = report.checks.filter((check) => check.status === 'covered' && check.covered === 0)
  report.emptyChecks = empty.map((check) => check.id)

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }
  printDoctor(report)
  return 0
}

function printDoctor(report) {
  const { profile: profileInfo, workspace, checks: checkReport, baseline, emptyChecks } = report
  const packageCount = report.workspace.packages.length
  const print = []
  print.push(`fe-guard doctor  (profile: ${profileInfo.name})`)
  print.push(`配置: ${prettyPath(report.root, report.configFile)}`)
  print.push(`档位: ${profileInfo.name} — ${profileInfo.description}`)
  print.push(
    workspace.isWorkspace
      ? `workspace: ${workspace.source}，${packageCount} 个 package`
      : 'workspace: 单仓库（未检测到 workspaces / pnpm-workspace.yaml / lerna.json）',
  )
  print.push('')
  print.push('检查覆盖:')
  for (const check of checkReport) {
    const timing = check.lastMs === null ? '耗时未知（跑一次 check 后显示）' : `上次 ${(check.lastMs / 1000).toFixed(1)}s`
    if (check.status === 'disabled') {
      print.push(`  ${pad(check.label)}  已关闭（${check.note}）`)
      continue
    }
    if (check.status === 'profile-skipped') {
      print.push(`  ${pad(check.label)}  档位跳过（${check.note}）  ${timing}`)
      continue
    }
    const coverage = check.covered === null ? '' : `覆盖 ${check.covered}${check.unit ?? ''}`
    const skipped = check.skipped.length > 0 ? `；跳过 ${check.skipped.length} 个 package: ${check.skipped.join(', ')}` : ''
    print.push(`  ${pad(check.label)}  ${coverage}${skipped}  ${timing}`)
    if (check.note) print.push(`      ${check.note}`)
  }

  if (profileInfo.skipped.length > 0) {
    print.push('')
    print.push(
      `档位提示: ${profileInfo.skipped.map((key) => LABELS[key]).join(' / ')} 在 ${profileInfo.name} 档不执行；` +
        '这不是通过，只是没跑。需要全档用 check --full。',
    )
  }
  if (emptyChecks.length > 0) {
    print.push('')
    print.push(
      `空白检查: ${emptyChecks.map((key) => LABELS[key]).join(' / ')} 当前覆盖为 0。` +
        '要么补配置/工具，要么在 fe-guard.config.json 里显式关闭，不要让它看起来“跑过了”。',
    )
  }

  print.push('')
  if (baseline.strategy === 'package') {
    print.push(`baseline.strategy: package（${baseline.ledgers.length} 本 package 账本）`)
    for (const ledger of baseline.ledgers) {
      const state = ledger.exists
        ? `${ledger.files} 文件 / ${ledger.entries} 条规则型 + ${ledger.ratchets} 条指标型`
        : '不存在（未入账）'
      print.push(
        `  ${pad(ledger.label)}  ${ledger.path}  ${state}  最近变更: ${ledger.lastCommit ?? '未提交 / 未知'}`,
      )
    }
  } else {
    print.push('baseline.strategy: root')
    print.push(
      `baseline: ${baseline.lines} 行 / ${baseline.files} 文件 / ` +
        `${baseline.entries} 条规则型（${baseline.rules} 条规则）+ ${baseline.ratchets} 条指标型`,
    )
  }
  print.push('未列出的文件（如 .md / .json / .css）不会进入任何检查；检查只看各项目注明的文件类型与扫描目录。')
  print.push('下一步: 钩子用 `fe-guard check --staged --profile fast`，提交/合并前手动跑 `fe-guard check --full`。')
  console.log(print.join('\n'))
}

/** 账本摘要：root 模式保持原有字段；package 模式逐本列出，最近变更时间读 git，读不到不编造。 */
async function baselineOf({ root, config, workspace }) {
  if (config.baseline.strategy !== 'package') {
    const baselineFile = path.join(root, config.baseline.path)
    const baseline = loadBaseline(baselineFile)
    const lines = existsSync(baselineFile) ? readFileSync(baselineFile, 'utf8').split('\n').length - 1 : 0
    const ruleEntries = Object.keys(baseline.entries)
    return {
      strategy: 'root',
      file: path.relative(root, baselineFile),
      lines: Math.max(lines, 0),
      files: new Set(ruleEntries.map((key) => parseKey(key).file)).size,
      entries: Object.values(baseline.entries).reduce((sum, value) => sum + value, 0),
      rules: new Set(ruleEntries.map((key) => parseKey(key).ruleId)).size,
      ratchets: Object.keys(baseline.ratchets).length,
    }
  }

  const layout = loadLedgerLayout({ root, config, workspace })
  const ledgers = []
  for (const ledger of layout.ledgers) {
    const summary = summarizeBaseline(ledger.baseline)
    ledgers.push({
      package: ledger.pkg.name,
      label: ledger.label,
      path: ledger.relPath,
      exists: ledger.exists,
      files: summary.files,
      entries: summary.entries,
      ratchets: summary.ratchets,
      lastCommit: ledger.exists ? await lastCommit(root, ledger.relPath) : null,
    })
  }
  return { strategy: 'package', ledgers }
}

async function lastCommit(root, rel) {
  const result = await run('git', ['log', '-1', '--format=%aI', '--', rel], { cwd: root })
  if (result.missing || result.code !== 0) return null
  return result.stdout.trim() || null
}

function pad(label) {
  return label.padEnd(10, ' ')
}

function prettyPath(root, file) {
  const rel = path.relative(root, file)
  return rel.startsWith('..') ? file : rel
}

function readTimings(root, config) {
  const file = path.join(root, config.report.path)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).timings?.checks ?? null
  } catch {
    return null
  }
}

function coverageOf(key, root, config, workspace, packages) {
  if (key === 'eslint') {
    const packageMode = config.checks.eslint.workspace !== 'root' && workspace.isWorkspace
    if (!packageMode) {
      const ok = Boolean(eslintConfigFor(root, root))
      return {
        covered: ok ? 1 : 0,
        unit: ' 个仓库',
        skipped: [],
        note: ok ? '' : '根目录没有 ESLint 配置，这一项实际是空的',
      }
    }
    const covered = []
    const skipped = []
    for (const pkg of packages) {
      if (eslintConfigFor(root, pkg.dir)) covered.push(pkg.rel)
      else skipped.push(pkg.rel)
    }
    return {
      covered: covered.length,
      unit: ' 个 package',
      skipped,
      note: `文件类型: ${(config.checks.eslint.extensions ?? []).join(' ')}`,
    }
  }

  if (key === 'typescript') {
    const packageMode = config.checks.typescript.workspace !== 'root' && workspace.isWorkspace
    const targets = packageMode ? packages : [{ rel: '.', dir: root }]
    const covered = []
    const skipped = []
    for (const pkg of targets) {
      if (tsconfigFor(pkg.dir)) covered.push(pkg.rel)
      else skipped.push(pkg.rel)
    }
    const vue = hasVueFile(root) ? '（Vue 项目，全档会用 vue-tsc）' : ''
    return { covered: covered.length, unit: ' 个 package', skipped, note: vue }
  }

  if (key === 'boundaries') {
    const configFile = path.join(root, '.dependency-cruiser.cjs')
    const exists = existsSync(configFile)
    return {
      covered: exists ? 1 : 0,
      unit: ' 个配置',
      skipped: exists ? [] : ['(root)'],
      note: exists ? '' : '缺少 .dependency-cruiser.cjs，全档跑起来也会是空的',
    }
  }

  if (key === 'diff-size') {
    return { covered: 1, unit: ' 个仓库', skipped: [], note: '只在全档执行' }
  }

  const roots = config.checks[key].roots ?? ['src']
  const extensions = config.checks[key].extensions ?? []
  const existing = roots.filter((dir) => existsSync(path.join(root, dir)))
  const files = walkSourceFiles(root, { roots: existing, extensions })
  return {
    covered: files.length,
    unit: ' 个文件',
    skipped: roots.filter((dir) => !existing.includes(dir)),
    note: existing.length === 0 ? `配置的扫描目录都不存在：${roots.join(', ')}` : '',
  }
}
