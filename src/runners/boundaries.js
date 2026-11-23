import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UserError, resolveBin, run, tail, toRepoPath, walkSourceFiles } from '../utils.js'
import { notExecuted } from '../not-executed.js'
import { findCrossPackageImports, packageDirsForScan, workspaceBoundaryConfigSource } from '../workspace-boundaries.js'

export const id = 'boundaries'

const DEFAULT_BIN = 'depcruise'
const DEFAULT_ARGS = ['src', '--output-type', 'json', '--config', '.dependency-cruiser.cjs']

/**
 * dependency-cruiser 的 JSON 输出里，违规集中在 summary.violations：
 * { from, to, rule: { name, severity, comment } }
 * 它不提供行号，line 统一为 null。
 */
export async function runCheck({ root, check, workspace }) {
  const bin = resolveBin(root, check.bin ?? DEFAULT_BIN)
  const dirs = check.workspace === 'auto' && workspace?.isWorkspace ? packageDirsForScan(workspace) : []
  const scanTargets = dirs.length > 0 ? withWorkspaceTargets(root, check.args ?? DEFAULT_ARGS, dirs) : null
  const args = scanTargets ? scanTargets.args : check.args ?? DEFAULT_ARGS
  const result = await run(bin, args, { cwd: root, timeoutMs: check.timeoutMs })
  if (result.timedOut || result.missing) {
    return [
      notExecuted(id, {
        file: 'package.json',
        message: result.timedOut
          ? `dependency-cruiser 执行超时（上限 ${check.timeoutMs ?? 120000}ms），本次没有产出边界检查结果，属于“检查未执行”。`
          : `找不到 dependency-cruiser 可执行文件 "${check.bin ?? DEFAULT_BIN}"，本次没有执行边界检查，属于“检查未执行”。`,
        fix: '在项目内安装：npm i -D dependency-cruiser；确实不需要时把 checks.boundaries.enabled 设为 false。',
      }),
    ]
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new UserError(
      `dependency-cruiser 输出不是合法 JSON（退出码 ${result.code}）。\n` +
        `请确认 fe-guard.config.json 的 checks.boundaries.args 包含 "--output-type","json"。\n` +
        `${tail(result.stderr || result.stdout)}`,
    )
  }

  // Vue 仓库里 depcruise 找不到 @vue/compiler-sfc 时会静默跳过绝大多数 .vue，
  // 依赖图只剩 js/ts 孤岛、违规恒 0 —— 这是“假通过”，按检查未执行处理。
  // 信号：磁盘上的 .vue 数量 vs 实际进入依赖图的 .vue 数量。
  const targets = scanTargets ? scanTargets.targets : leadingTargets(args)
  if (targets.length > 0) {
    const incomplete = vueCoverageFailure(root, targets, report)
    if (incomplete) return [incomplete]
  }

  const violations = []
  for (const violation of report.summary?.violations ?? []) {
    const ruleName = violation.rule?.name ?? 'unknown-rule'
    const comment = violation.rule?.comment
    violations.push({
      ruleId: `boundaries/${ruleName}`,
      file: toRepoPath(root, violation.from),
      line: null,
      severity: violation.rule?.severity === 'warn' ? 'warn' : 'error',
      message: `${violation.from} -> ${violation.to}${comment ? `（${comment}）` : ''}`,
      fix: comment ? `调整依赖方向：${comment}` : '调整依赖方向，或把共享代码移到更底层的模块',
    })
  }

  // monorepo：用户配置之外再跑一遍“跨包相对引用”检查，不改用户的 depcruise 配置。
  if (check.workspace === 'auto' && workspace?.isWorkspace) {
    const extra = await runWorkspacePass({ root, bin, check, workspace })
    if (extra.failure) return [...violations, extra.failure]
    violations.push(...extra.violations)
  }
  return violations
}

async function runWorkspacePass({ root, bin, check, workspace }) {
  const dirs = packageDirsForScan(workspace)
  if (dirs.length < 2) return { violations: [] }

  const temp = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-boundaries-'))
  const configFile = path.join(temp, 'workspace-boundaries.cjs')
  try {
    writeFileSync(configFile, workspaceBoundaryConfigSource())
    const result = await run(bin, [...dirs, '--output-type', 'json', '--config', configFile], {
      cwd: root,
      timeoutMs: check.timeoutMs,
    })
    if (result.timedOut || result.missing) {
      return {
        failure: notExecuted(id, {
          file: 'package.json',
          message: result.timedOut
            ? 'monorepo 跨包边界检查超时，本次没有产出跨包结果（项目自身的 depcruise 结果仍然有效）。'
            : `找不到 dependency-cruiser 可执行文件 "${check.bin ?? DEFAULT_BIN}"，monorepo 跨包边界检查没有执行。`,
          fix: '在项目内安装 dependency-cruiser；或把 checks.boundaries.workspace 设为 off。',
        }),
      }
    }
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch {
      return {
        failure: notExecuted(id, {
          file: 'package.json',
          message: 'monorepo 跨包边界检查的输出不是合法 JSON，本次跨包结果不可信。',
          fix: '确认 dependency-cruiser 版本可用（npm i -D dependency-cruiser），或把 checks.boundaries.workspace 设为 off。',
        }),
      }
    }
    const incomplete = vueCoverageFailure(root, dirs, report)
    if (incomplete) return { failure: incomplete }
    return { violations: findCrossPackageImports(report.modules, workspace.packages) }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** 把 args 里的扫描目标换成「原有且存在的目标 + workspace 各包目录」，保留输出/配置参数。 */
function withWorkspaceTargets(root, args, dirs) {
  const existing = leadingTargets(args).filter((target) => existsSync(path.join(root, target)))
  const targets = [...new Set([...existing, ...dirs])]
  const flagIndex = args.findIndex((arg) => arg.startsWith('-'))
  const flags = flagIndex === -1 ? [] : args.slice(flagIndex)
  return { targets, args: [...targets, ...flags] }
}

/** depcruise 的位置参数在 flags 之前（如 `src tests --output-type json`）。 */
function leadingTargets(args) {
  const targets = []
  for (const arg of args) {
    if (arg.startsWith('-')) break
    targets.push(arg)
  }
  return targets
}

/** .vue 没有完整进入依赖图时，任何“0 违规”都不可信。 */
function vueCoverageFailure(root, targets, report) {
  const vueOnDisk = targets.reduce(
    (total, target) => total + walkSourceFiles(root, { roots: [target], extensions: ['.vue'] }).length,
    0,
  )
  const vueCruised = (report.modules ?? []).filter((module) => String(module.source).endsWith('.vue')).length
  if (vueOnDisk === 0 || vueCruised >= vueOnDisk) return null
  return notExecuted(id, {
    file: 'package.json',
    message: `dependency-cruiser 只解析了 ${vueCruised}/${vueOnDisk} 个 .vue 文件，Vue 仓库的依赖图不完整，本次边界检查结果不可信。`,
    fix: '确认 depcruise 能解析到 @vue/compiler-sfc（Vue 2 用 vue-template-compiler）：npm i -D @vue/compiler-sfc；确实不需要时把 checks.boundaries.enabled 设为 false。',
  })
}
