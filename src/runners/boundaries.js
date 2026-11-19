import { UserError, resolveBin, run, tail, toRepoPath, walkSourceFiles } from '../utils.js'
import { notExecuted } from '../not-executed.js'

export const id = 'boundaries'

const DEFAULT_BIN = 'depcruise'
const DEFAULT_ARGS = ['src', '--output-type', 'json', '--config', '.dependency-cruiser.cjs']

/**
 * dependency-cruiser 的 JSON 输出里，违规集中在 summary.violations：
 * { from, to, rule: { name, severity, comment } }
 * 它不提供行号，line 统一为 null。
 */
export async function runCheck({ root, check }) {
  const bin = resolveBin(root, check.bin ?? DEFAULT_BIN)
  const result = await run(bin, check.args ?? DEFAULT_ARGS, { cwd: root, timeoutMs: check.timeoutMs })
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
  // 信号：磁盘上的 .vue 数量 vs 实际进入依赖图的 .vue 数量（扫描目录取 args 首个位置参数）。
  const args = check.args ?? DEFAULT_ARGS
  const target = args[0] && !args[0].startsWith('-') ? args[0] : null
  if (target) {
    const vueOnDisk = walkSourceFiles(root, { roots: [target], extensions: ['.vue'] }).length
    const vueCruised = (report.modules ?? []).filter((module) => String(module.source).endsWith('.vue')).length
    if (vueOnDisk > 0 && vueCruised < vueOnDisk) {
      return [
        notExecuted(id, {
          file: 'package.json',
          message: `dependency-cruiser 只解析了 ${vueCruised}/${vueOnDisk} 个 .vue 文件，Vue 仓库的依赖图不完整，本次边界检查结果不可信。`,
          fix: '确认 depcruise 能解析到 @vue/compiler-sfc（Vue 2 用 vue-template-compiler）：npm i -D @vue/compiler-sfc；确实不需要时把 checks.boundaries.enabled 设为 false。',
        }),
      ]
    }
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
  return violations
}
