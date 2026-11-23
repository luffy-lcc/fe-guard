import path from 'node:path'
import { toPosix } from './utils.js'

export const WORKSPACE_RULE_ID = 'boundaries/workspace-cross-package'

/**
 * monorepo 跨包边界的第二遍检查：
 * - 用一份最小的 depcruise 配置把各 package 的源码编成依赖图（不改用户配置）；
 * - 只拦「相对路径穿透到另一个 package 的源码」，包名入口引用与包内引用都放行。
 */
export function workspaceBoundaryConfigSource() {
  return [
    'module.exports = {',
    '  forbidden: [],',
    "  options: { doNotFollow: { path: 'node_modules' }, exclude: { path: 'node_modules' } },",
    '}',
    '',
  ].join('\n')
}

/** 参与跨包检查的 package 目录（跳过根包 "."）。 */
export function packageDirsForScan(workspace) {
  return (workspace?.packages ?? [])
    .filter((pkg) => pkg.rel && pkg.rel !== '.')
    .map((pkg) => pkg.rel)
}

/**
 * 从 depcruise 的 JSON 模块图里找出跨 package 的相对引用。
 * - 以 import 说明符是否以 "." 开头判断“相对路径”（depcruise 对未解析的 .ts 扩展名会标 unknown）；
 * - resolved 可能是相对当前文件的路径，也可能是仓库相对路径，先归一化再判断归属。
 */
export function findCrossPackageImports(modules, packages) {
  const named = (packages ?? [])
    .filter((pkg) => pkg.rel && pkg.rel !== '.')
    .map((pkg) => ({ dir: toPosix(pkg.rel), name: pkg.name }))
  const violations = []
  const seen = new Set()

  for (const module of modules ?? []) {
    const from = toPosix(module.source ?? '')
    const owner = ownerOf(from, named)
    if (!owner) continue
    for (const dependency of module.dependencies ?? []) {
      const specifier = String(dependency.module ?? '')
      if (!specifier.startsWith('.')) continue
      const target = resolveTarget(from, dependency.resolved || specifier)
      if (!target || target.startsWith('node_modules/')) continue
      const targetOwner = ownerOf(target, named)
      if (!targetOwner || targetOwner.dir === owner.dir) continue
      const message = `${from} -> ${target}（跨 package 相对引用：${owner.name} → ${targetOwner.name}）`
      const key = `${from}::${message}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push({
        ruleId: WORKSPACE_RULE_ID,
        file: from,
        line: null,
        severity: 'error',
        message,
        fix: `改为通过 ${targetOwner.name} 的公开入口引用，或把共享代码移到更底层；不要用 ../../ 穿透包边界。`,
      })
    }
  }
  return violations
}

/** depcruise 的 resolved 可能是相对当前文件的路径；统一成仓库相对路径。 */
function resolveTarget(from, resolved) {
  const value = toPosix(String(resolved ?? ''))
  if (!value) return ''
  if (!value.startsWith('.')) return value
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), value))
}

function ownerOf(file, packages) {
  for (const pkg of packages) {
    if (file === pkg.dir || file.startsWith(`${pkg.dir}/`)) return pkg
  }
  return null
}
