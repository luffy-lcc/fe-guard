import * as boundaries from './boundaries.js'
import * as deps from './deps.js'
import * as diffSize from './diff-size.js'
import * as eslint from './eslint.js'
import * as metrics from './metrics.js'
import * as typescript from './typescript.js'
import * as ui from './ui.js'
import { checkEnabled } from '../config.js'
import { isNotExecutedRule } from '../not-executed.js'
import { detectWorkspace, workspaceRoots } from '../workspace.js'
import { now, recordCheck } from '../timing.js'

const RUNNERS = { eslint, typescript, boundaries, deps, ui, metrics, 'diff-size': diffSize }

/** --staged 时能把 root 指向暂存快照的内容检查；其余（typescript/boundaries/diff-size）仍读工作区。 */
export const STAGED_CONTENT_CHECKS = new Set(['eslint', 'deps', 'ui', 'metrics'])

export const CHECK_LABELS = {
  eslint: 'ESLint',
  typescript: 'TypeScript (tsc / vue-tsc)',
  boundaries: '架构边界 (dependency-cruiser)',
  deps: '依赖守卫',
  ui: '组件清单 / 重复实现',
  metrics: '腐化指标棘轮',
  'diff-size': '大 diff 拦截',
}

/**
 * 只运行配置里启用的检查，把各家输出归一化成同一种违规结构。
 * workspace 与 timings 是可选上下文：不传时自动识别工作区、不采集耗时。
 */
export async function runChecks({
  root,
  realRoot,
  gitRoot,
  config,
  changedFiles,
  mode = 'full',
  timings,
  workspace,
}) {
  const ws = workspace ?? detectWorkspace(root)
  const tasks = Object.entries(RUNNERS)
    .filter(([key]) => checkEnabled(config, key))
    .map(async ([key, runner]) => {
      const started = now()
      // --staged：内容检查用暂存快照（root 已经是快照目录），其余仍用真实工作区。
      const targetRoot = realRoot && mode === 'staged' && !STAGED_CONTENT_CHECKS.has(key) ? realRoot : root
      const targetWorkspace = targetRoot === root ? ws : detectWorkspace(targetRoot)
      try {
        const check = workspaceRoots(targetRoot, config.checks[key], targetWorkspace)
        const violations = await runner.runCheck({
          root: targetRoot,
          check,
          changedFiles,
          mode,
          config,
          workspace: targetWorkspace,
          timings,
          realRoot,
          gitRoot: gitRoot ?? realRoot,
          inventoryRoot: realRoot,
        })
        recordCheck(timings, key, now() - started, statusOf(key, violations, timings))
        return violations
      } catch (error) {
        recordCheck(timings, key, now() - started, 'failed')
        error.check = key
        error.message = `[${checkOf(key)}] ${error.message}`
        throw error
      }
    })

  const results = (await Promise.all(tasks)).flat()
  return results.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0)
    return a.ruleId < b.ruleId ? -1 : 1
  })
}

function statusOf(key, violations, timings) {
  if (violations.some((violation) => isNotExecutedRule(violation.ruleId))) return 'unavailable'
  const packages = (timings?.packages ?? []).filter((pkg) => pkg.check === key)
  if (packages.length > 0 && packages.every((pkg) => pkg.status === 'skipped')) return 'skipped'
  return 'ok'
}

function checkOf(key) {
  return CHECK_LABELS[key] ?? key
}

export function activeChecks(config) {
  return Object.keys(RUNNERS).filter((key) => checkEnabled(config, key))
}
