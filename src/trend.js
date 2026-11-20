import path from 'node:path'
import { parseBaselineRaw } from './baseline.js'
import { run, toPosix } from './utils.js'

/**
 * baseline 趋势：只读 baseline 的 git 历史，不写任何文件、不产生第二份事实源。
 * 每个提交里的账本就是一个数据点；没有历史时优雅降级，不影响门禁本身。
 */

export const DEFAULT_TREND_LIMIT = 20

export async function collectBaselineTrend({ root, baselinePath, limit = DEFAULT_TREND_LIMIT }) {
  const rel = toPosix(path.relative(root, baselinePath))

  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })
  if (inside.missing || inside.code !== 0) return { available: false, reason: 'no-git', path: rel }

  const log = await run('git', ['log', '--format=%H%x09%aI', '--', rel], { cwd: root })
  if (log.code !== 0) {
    return { available: false, reason: 'git-error', path: rel, detail: (log.stderr || log.stdout).trim() }
  }

  // git log 是新到旧；反转成时间顺序后再截取最近 limit 个。
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((entry) => {
      const [sha, date] = entry.split('\t')
      return { sha, date: String(date ?? '').slice(0, 10) }
    })
    .reverse()
  if (commits.length === 0) return { available: false, reason: 'not-tracked', path: rel }

  const selected = commits.slice(-limit)
  const versions = []
  let unreadable = 0
  for (const commit of selected) {
    const show = await run('git', ['show', `${commit.sha}:./${rel}`], { cwd: root })
    if (show.code !== 0) {
      unreadable += 1
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(show.stdout)
    } catch {
      unreadable += 1
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      unreadable += 1
      continue
    }
    // parseBaselineRaw 对“schema 比工具新”会抛 UserError，必须原样冒泡而不是当作坏历史。
    const baseline = parseBaselineRaw(parsed)
    versions.push({
      sha: commit.sha.slice(0, 7),
      date: commit.date,
      entries: sumValues(baseline.entries),
      entryKeys: Object.keys(baseline.entries).length,
      ratchetKeys: Object.keys(baseline.ratchets).length,
      firstSeenKeys: Object.keys(baseline.firstSeen).length,
      widens: countWidens(baseline.widenLog),
      rawEntries: baseline.entries,
      firstSeen: baseline.firstSeen,
      widenLog: baseline.widenLog,
    })
  }

  if (versions.length === 0) {
    return { available: false, reason: 'unreadable', path: rel, unreadable }
  }

  let previous = null
  for (const version of versions) {
    version.delta = previous === null ? null : version.entries - previous.entries
    version.changes = previous === null ? null : diffEntries(previous.rawEntries, version.rawEntries)
    previous = version
  }

  const first = versions[0]
  const last = versions.at(-1)
  const delta = last.entries - first.entries
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const recentFirstSeen = Object.values(last.firstSeen ?? {}).filter((date) => String(date) >= cutoff).length

  const result = {
    available: true,
    path: rel,
    truncated: commits.length > selected.length,
    totalVersions: commits.length,
    unreadable,
    versions: versions.map(({ rawEntries, firstSeen, widenLog, ...version }) => version),
    summary: {
      first: first.entries,
      last: last.entries,
      delta,
      percent: first.entries > 0 ? Number(((delta / first.entries) * 100).toFixed(1)) : 0,
      widens: last.widens - first.widens,
      recentFirstSeen,
    },
    latestWidenLog: last.widenLog.filter((entry) => entry.type === 'widen').slice(-1),
  }
  return result
}

export function formatTrend(trend) {
  if (!trend.available) return unavailableMessage(trend)
  const lines = [
    `baseline 趋势（${trend.path}，共 ${trend.totalVersions} 个版本` +
      `${trend.truncated ? `，仅显示最近 ${trend.versions.length} 个` : ''}）`,
    '日期        提交      存量条数  变化    指标键  放宽',
  ]
  for (const version of trend.versions) {
    lines.push(
      `${version.date}  ${version.sha}  ${pad(version.entries, 8)}  ${pad(formatDelta(version.delta), 6)}  ` +
        `${pad(version.ratchetKeys, 6)}  ${version.widens}`,
    )
  }
  const { first, last, delta, percent, widens, recentFirstSeen } = trend.summary
  lines.push(
    `合计: ${first} -> ${last}（${formatDelta(delta)}${percent ? `，${percent > 0 ? '+' : ''}${percent}%` : ''}）` +
      `；期间放宽 ${widens} 次` +
      `${recentFirstSeen > 0 ? `；最近 30 天新入账 ${recentFirstSeen} 条` : ''}`,
  )
  if (trend.latestWidenLog.length > 0) {
    lines.push('最近一次放宽:')
    for (const entry of trend.latestWidenLog) {
      for (const item of (entry.items ?? []).slice(0, 5)) {
        lines.push(`  ${entry.at ?? ''} ${item.file} ${item.ruleId} ${item.from} -> ${item.to}`)
      }
    }
  }
  if (trend.unreadable > 0) lines.push(`有 ${trend.unreadable} 个版本的账本无法解析，已跳过。`)
  if (trend.versions.length === 1) lines.push('至少需要两次提交才能看到变化；当前只有一个版本。')
  return lines.join('\n')
}

function unavailableMessage(trend) {
  if (trend.reason === 'no-git') {
    return '当前目录不是 git 仓库（或找不到 git），无法读取 baseline 历史。趋势是只读视图，不影响 check / baseline 本身。'
  }
  if (trend.reason === 'not-tracked') {
    return `git 历史里没有找到 ${trend.path}。baseline 应该入库，否则每个开发者和 CI 拿到的账本不一致；提交后趋势才会有数据。`
  }
  if (trend.reason === 'unreadable') {
    return `${trend.path} 的历史版本都无法解析（${trend.unreadable} 个），请检查文件内容与 git 历史。`
  }
  return `读取 ${trend.path} 的 git 历史失败：${trend.detail || '未知错误'}`
}

function diffEntries(previous, current) {
  const changes = { added: 0, removed: 0, increased: 0, decreased: 0 }
  for (const [key, value] of Object.entries(current)) {
    if (previous[key] === undefined) changes.added += 1
    else if (value > previous[key]) changes.increased += 1
    else if (value < previous[key]) changes.decreased += 1
  }
  for (const key of Object.keys(previous)) {
    if (current[key] === undefined) changes.removed += 1
  }
  return changes
}

function sumValues(values) {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

/** 只有显式 --widen 算“放宽”；首次入账与重命名迁移不算。 */
function countWidens(widenLog) {
  return widenLog.filter((entry) => entry.type === 'widen').length
}

function formatDelta(value) {
  if (value === null || value === undefined) return '—'
  return value > 0 ? `+${value}` : String(value)
}

function pad(value, width) {
  return String(value).padEnd(width)
}
