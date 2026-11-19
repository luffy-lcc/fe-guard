import { existsSync } from 'node:fs'
import path from 'node:path'
import { UserError, run, tail, toRepoPath, walkSourceFiles } from '../utils.js'
import { now, recordPackage } from '../timing.js'
import { eslintConfigFor, planPackages, resolveBinFrom } from '../workspace.js'
import { notExecuted } from '../not-executed.js'

export const id = 'eslint'

const DEFAULT_BIN = 'eslint'
const DEFAULT_ARGS = ['--format', 'json']
const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue']

/**
 * ESLint 适配器：workspace 下按 package 分组，各自用自己目录的配置执行。
 * 没有配置的 package 跳过（记录在耗时/跳过信息里），有配置但执行失败必须抛出。
 */
export async function runCheck({ root, check, changedFiles, workspace, timings }) {
  const extensions = check.extensions ?? DEFAULT_EXTENSIONS
  const configured = check.targets ?? []

  // 显式 targets 表示用户要自己控制扫描范围：保持单次执行，不拆分 package。
  if (configured.length > 0) {
    return runOne({ root, check, dir: root, pkg: { name: '(root)', rel: '' }, targets: configured, extensions, timings })
  }

  const packageMode = check.workspace !== 'root' && workspace?.isWorkspace
  if (!packageMode) {
    const targets = changedFiles
      ? pickFiles(changedFiles, extensions)
      : autoTargets(root)
    if (targets.length === 0) return []
    return runOne({ root, check, dir: root, pkg: { name: '(root)', rel: '' }, targets, extensions, timings })
  }

  const groups = changedFiles
    ? groupChangedFiles(root, workspace.packages, changedFiles, extensions, timings)
    : packageTargets(root, workspace, check, extensions, timings)

  const results = await Promise.all(
    groups.map((group) =>
      runOne({
        root,
        check,
        dir: group.pkg.dir,
        pkg: group.pkg,
        targets: group.targets,
        extensions,
        timings,
      }),
    ),
  )
  return results.flat()
}

function packageTargets(root, workspace, check, extensions, timings) {
  const groups = []
  for (const pkg of planPackages(root, workspace, check)) {
    if (!eslintConfigFor(root, pkg.dir)) {
      recordPackage(timings, id, pkg, 0, 'skipped')
      continue
    }
    const targets = autoTargets(pkg.dir)
    const files = walkSourceFiles(pkg.dir, { roots: targets, extensions })
    if (files.length === 0) continue
    groups.push({ pkg, targets })
  }
  return groups
}

/** diff-only / staged：把变更文件按“最深的所属 package”分组，各自用自己目录的配置跑。 */
function groupChangedFiles(root, packages, changedFiles, extensions, timings) {
  const groups = new Map()
  for (const file of changedFiles) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue
    let owner = null
    for (const pkg of packages) {
      if (pkg.rel === '') continue
      if (file === pkg.rel || file.startsWith(`${pkg.rel}/`)) {
        if (!owner || pkg.rel.length > owner.rel.length) owner = pkg
      }
    }
    const key = owner?.rel ?? ''
    if (!groups.has(key)) {
      groups.set(key, {
        pkg: owner ?? { name: '(root)', dir: root, rel: '' },
        files: [],
      })
    }
    groups.get(key).files.push(file)
  }

  const selected = []
  for (const group of groups.values()) {
    if (!eslintConfigFor(root, group.pkg.dir)) {
      // 钩子模式也必须留下“这个 package 没跑”的证据，否则整类检查会静默消失。
      recordPackage(timings, id, group.pkg, 0, 'skipped')
      continue
    }
    selected.push({ pkg: group.pkg, targets: group.files })
  }
  return selected
}

async function runOne({ root, check, dir, pkg, targets, extensions, timings }) {
  const bin = resolveBinFrom(root, dir, check.bin ?? DEFAULT_BIN)
  const started = now()
  const result = await run(bin, [...(check.args ?? DEFAULT_ARGS), ...targets], {
    cwd: dir,
    timeoutMs: check.timeoutMs,
  })
  const elapsed = now() - started

  if (result.timedOut) {
    recordPackage(timings, id, pkg, elapsed, 'timeout')
    return [
      notExecuted(id, {
        file: pkg.rel || 'package.json',
        message:
          `ESLint 在 ${pkg.rel || '仓库根'} 超时（${Math.round(elapsed)}ms / 上限 ${check.timeoutMs ?? 120000}ms），` +
          '本次没有产出任何 lint 结果，属于“检查未执行”，因此判失败。',
        fix:
          '排查 ESLint 配置里是否有卡死的插件/规则；或调小 checks.eslint.targets；' +
          '确有必要时在 fe-guard.config.json 里调大 checks.eslint.timeoutMs。',
      }),
    ]
  }

  if (result.missing) {
    recordPackage(timings, id, pkg, elapsed, 'missing')
    return [
      notExecuted(id, {
        file: pkg.rel || 'package.json',
        message:
          `找不到 ESLint 可执行文件 "${check.bin ?? DEFAULT_BIN}"（${pkg.rel || '仓库根'}），本次没有执行任何 lint，属于“检查未执行”。`,
        fix: `在 ${pkg.rel || '仓库根'} 安装：npm i -D eslint；确实不需要时把 checks.eslint.enabled 设为 false，并在评审里说明。`,
      }),
    ]
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    recordPackage(timings, id, pkg, elapsed, 'failed')
    throw new UserError(
      `ESLint 在 ${pkg.rel || '仓库根'} 的输出不是合法 JSON（退出码 ${result.code}）。\n` +
        '请确认 checks.eslint.args 包含 "--format","json"；如果这是 monorepo，' +
        '请确认该 package 自己的 ESLint 配置可用（fe-guard 已按 package 分别执行）。\n' +
        `${result.truncated ? '（输出超过 8MB 已被截断）\n' : ''}${tail(result.stderr || result.stdout)}`,
    )
  }

  const violations = []
  for (const file of report) {
    for (const message of file.messages ?? []) {
      violations.push({
        ruleId: `eslint/${message.ruleId ?? 'parse-error'}`,
        file: toRepoPath(root, file.filePath, dir),
        line: message.line ?? null,
        severity: message.severity === 1 ? 'warn' : 'error',
        message: message.message,
        fix: message.fix ? '可自动修复：eslint --fix' : null,
      })
    }
  }
  recordPackage(timings, id, pkg, elapsed, 'ok', violations.length, { bin: check.bin ?? DEFAULT_BIN })
  return violations
}

function pickFiles(files, extensions) {
  return files.filter((file) => extensions.some((ext) => file.endsWith(ext)))
}

function autoTargets(dir) {
  return [existsSync(path.join(dir, 'src')) ? 'src' : '.']
}
