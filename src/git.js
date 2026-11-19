import { mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UserError, run, toPosix } from './utils.js'

/**
 * 取本次检查范围。
 * - staged: 暂存区相对 HEAD 的改动（提交前钩子用）
 * - diff-only: 工作区（含未提交与暂存）相对 base 的改动，外加未跟踪的新文件
 */
export async function changedFiles({ root, mode, base }) {
  const args =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--relative', '--', '.']
      : ['diff', '--name-only', '--diff-filter=ACMR', '--relative', base, '--', '.']

  const diff = await run('git', args, { cwd: root })
  if (diff.missing) throw new UserError('diff-only / --staged 模式需要 git，但当前环境找不到 git 命令。')
  if (diff.code !== 0) {
    throw new UserError(
      `git diff 执行失败：${diff.stderr.trim() || diff.stdout.trim()}\n` +
        `请确认当前目录是 git 仓库，且 baseline 分支 "${base}" 存在（可在 fe-guard.config.json 的 diff.base 调整）。`,
    )
  }

  const files = new Set(
    diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => toPosix(line)),
  )

  if (mode !== 'staged') {
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], { cwd: root })
    if (untracked.code === 0) {
      untracked.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => files.add(toPosix(line)))
    }
  }

  return [...files].sort()
}

/**
 * 检测本次改动里的文件重命名（工作区 + 暂存 vs HEAD，git -M 相似度配对）。
 * 目标路径必须已跟踪（先 git add）；未跟踪的新文件 git 不会配成重命名。
 */
export async function renamedFiles({ root }) {
  const result = await run('git', ['diff', '-M', '--name-status', '--diff-filter=R', '--relative', 'HEAD', '--', '.'], { cwd: root })
  if (result.missing) throw new UserError('重命名检测需要 git，但当前环境找不到 git 命令。')
  if (result.code !== 0) {
    throw new UserError(
      `重命名检测失败：${(result.stderr || result.stdout).trim()}\n请确认当前目录是 git 仓库，且已有至少一次提交。`,
    )
  }
  const pairs = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^R\d+\t(.+)\t(.+)$/)
    if (match) pairs.push({ from: toPosix(match[1]), to: toPosix(match[2]) })
  }
  return pairs
}

/**
 * 把暂存区完整落到临时目录，让内容检查读“将要提交的内容”，而不是工作区磁盘。
 *
 * 为什么要做成影子目录：--staged 的语义是“检查即将提交的版本”。
 * 如果只拿路径、仍然读工作区，暂存后又改文件（但不 add）就会漏检。
 *
 * 项目根可能是 git 根的子目录（前后端同仓）：只导出 root 下的跟踪文件，
 * checkout-index 按 git 根布局落盘，因此返回 inspectDir = 影子目录 + 子目录偏移，
 * 检查在 inspectDir 上进行，路径语义与 root 一致。
 *
 * node_modules 不放进快照（体积大且不在 git 里），改为从真实仓库软链，
 * 这样 ESLint 插件、依赖解析仍能正常工作。
 */
export async function createStagedSnapshot({ root, workspace }) {
  let dir
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-staged-'))
  } catch (error) {
    throw new UserError(`无法创建 --staged 检查用的临时目录：${error.message}`)
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  const prefix = await run('git', ['rev-parse', '--show-prefix'], { cwd: root })
  const list = await run('git', ['ls-files', '-z', '--', '.'], { cwd: root, maxOutput: 64 * 1024 * 1024 })
  if (list.missing || list.code !== 0) {
    cleanup()
    throw new UserError(
      '--staged 需要 git 列出跟踪文件，但执行失败。\n请确认当前目录在 git 仓库内。\n' +
        `${(list.stderr || list.stdout).trim()}`,
    )
  }
  if (list.truncated) {
    cleanup()
    throw new UserError('--staged 的跟踪文件清单超出输出上限，拒绝导出不完整的快照。')
  }

  const result = await run('git', ['checkout-index', `--prefix=${dir}${path.sep}`, '-z', '--stdin'], {
    cwd: root,
    input: list.stdout,
  })
  if (result.missing || result.code !== 0) {
    cleanup()
    throw new UserError(
      '--staged 需要把暂存区导出到临时目录，但 git checkout-index 执行失败。\n' +
        `请确认当前目录是 git 仓库且有已暂存内容。\n${(result.stderr || result.stdout).trim()}`,
    )
  }

  const subPrefix = prefix.code === 0 ? prefix.stdout.trim() : ''
  const inspectDir = subPrefix ? path.join(dir, subPrefix) : dir
  linkNodeModules(root, inspectDir, workspace)
  return { dir, inspectDir, cleanup }
}

function linkNodeModules(root, shadow, workspace) {
  const rels = new Set([''])
  for (const pkg of workspace?.packages ?? []) rels.add(pkg.rel === '.' ? '' : pkg.rel)
  for (const rel of rels) {
    const real = path.join(root, rel, 'node_modules')
    if (!existsSync(real)) continue
    const target = path.join(shadow, rel, 'node_modules')
    mkdirSync(path.dirname(target), { recursive: true })
    if (existsSync(target)) continue
    try {
      symlinkSync(real, target, 'dir')
    } catch {
      // 软链失败不影响“检查暂存内容”本身，依赖解析会退化为按 PATH 查找。
    }
  }
}
