import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { matchesIgnore, run } from '../utils.js'
import { notExecuted } from '../not-executed.js'

export const id = 'diff-size'

const SPLIT_ADVICE =
  '拆分建议：1) 先单独提交纯格式化/重命名；2) 与本需求无关的文件移到后续 PR；' +
  '3) 一个 PR 只做一件事，按目录或功能分批提交。'

function parseNumstat(stdout) {
  const entries = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    entries.push({ file: parts.slice(2).join('\t'), added, deleted })
  }
  return entries
}

async function untrackedEntries(root) {
  const result = await run('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], { cwd: root })
  if (result.code !== 0) return []
  const entries = []
  for (const file of result.stdout.split('\n').map((item) => item.trim()).filter(Boolean)) {
    const absolute = path.join(root, file)
    if (!existsSync(absolute)) continue
    let lines = 0
    try {
      const text = readFileSync(absolute, 'utf8')
      lines = text.length === 0 ? 0 : text.split('\n').length
    } catch {
      lines = 0
    }
    entries.push({ file, added: lines, deleted: 0 })
  }
  return entries
}

export async function diffStats(root, { mode, base, ignore }) {
  // --relative + 路径限定：项目根是 git 根的子目录时，只统计 root 下的改动，
  // 路径相对 root（与违规结构、ignore 模式一致），不把兄弟目录的改动算进来。
  const args =
    mode === 'staged'
      ? ['diff', '--cached', '--numstat', '--relative', '--', '.']
      : ['diff', '--numstat', '--relative', base ?? 'HEAD', '--', '.']
  const result = await run('git', args, { cwd: root })
  // 不能把 git 失败当成“0 个文件”：那等于把大 diff 闸门静默关掉。
  if (result.timedOut) return { error: 'git diff 执行超时，无法统计本次改动规模。' }
  if (result.missing) return { error: '找不到 git 命令，无法统计本次改动规模。' }
  if (result.code !== 0) {
    return {
      error:
        `git diff 执行失败（退出码 ${result.code}），无法统计本次改动规模。\n` +
        `请确认当前目录是 git 仓库且 ${mode === 'staged' ? '存在已暂存内容' : `基准 "${base ?? 'HEAD'}" 存在`}。\n` +
        (result.stderr || result.stdout).trim(),
    }
  }

  const entries = parseNumstat(result.stdout)
  if (mode !== 'staged') entries.push(...(await untrackedEntries(root)))

  const filtered = entries.filter((entry) => !matchesIgnore(entry.file, ignore))
  const files = new Set(filtered.map((entry) => entry.file))
  const lines = filtered.reduce((sum, entry) => sum + entry.added, 0)
  return { files: files.size, lines, entries: filtered }
}

/**
 * 大 diff 拦截：PR 过大是所有质量问题的总闸门。
 * 明确不进 baseline —— 大 diff 是“本次事件”，不是历史欠债；入账等于永久关掉闸门。
 */
export async function runCheck({ root, check, mode = 'full', config }) {
  const stats = await diffStats(root, {
    mode,
    base: config?.diff?.base ?? 'HEAD',
    // baseline 是机器的账本，不是人写的改动；它变长不应该触发“大 diff”。
    // package 模式每个 package 也有一本账，同样要排除。
    ignore: [
      ...check.ignore,
      config?.baseline?.path ?? 'fe-guard.baseline.json',
      config?.baseline?.packageFile ?? 'fe-guard.baseline.json',
    ],
  })
  if (stats.error) {
    return [
      notExecuted(id, {
        file: 'package.json',
        message: `${stats.error}\n本次没有统计改动规模，属于“检查未执行”，因此判失败。`,
        fix: '在 git 仓库里运行（或先 git init / commit 一次）；shallow clone 请先 fetch 出 diff.base 指向的分支。',
      }),
    ]
  }

  const violations = []
  const scale = `本次改动 ${stats.files} 个文件 / ${stats.lines} 行`

  if (stats.files > check.maxFiles) {
    violations.push({
      ruleId: 'diff-size/files',
      file: '(diff)',
      line: null,
      severity: 'error',
      message: `${scale}，文件数超过阈值 ${check.maxFiles}。改动面越大，评审越容易变成走过场。`,
      fix: SPLIT_ADVICE,
    })
  }
  if (stats.lines > check.maxLines) {
    violations.push({
      ruleId: 'diff-size/lines',
      file: '(diff)',
      line: null,
      severity: 'error',
      message: `${scale}，新增行数超过阈值 ${check.maxLines}。AI 产出快于人读，这是质量失控的起点。`,
      fix: SPLIT_ADVICE,
    })
  }
  return violations
}
