import { UserError, run, tail, toRepoPath } from '../utils.js'
import { now, recordPackage } from '../timing.js'
import { notExecuted } from '../not-executed.js'
import {
  hasVueFile,
  installedVersion,
  planPackages,
  resolveBinFrom,
  tsconfigFor,
  vueDependency,
} from '../workspace.js'

export const id = 'typescript'

const DEFAULT_ARGS = ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json']

// 形如：src/utils/legacy.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/

/**
 * 类型检查适配器：非 Vue 用 tsc，Vue 自动切 vue-tsc。
 * 安全底线：项目里有 .vue 但 vue-tsc 不可用时，必须产出一条永远不可入账的 error，
 * 而不是返回 0 条让类型门禁静默失效。
 */
export async function runCheck({ root, check, workspace, timings }) {
  const packageMode = check.workspace !== 'root' && workspace?.isWorkspace
  const packages = planPackages(root, workspace, check)

  const results = await Promise.all(
    packages.map((pkg) =>
      runPackage({ root, check, pkg, packageMode, timings }),
    ),
  )
  return results.flat()
}

async function runPackage({ root, check, pkg, packageMode, timings }) {
  const tsconfig = tsconfigFor(pkg.dir)
  if (!tsconfig) {
    if (packageMode) {
      recordPackage(timings, id, pkg, 0, 'skipped')
      return []
    }
    throw new UserError(
      `没有在 ${pkg.dir} 找到 tsconfig.json，TypeScript 检查无法执行。\n` +
        '请在项目根目录放一个 tsconfig.json，或在 fe-guard.config.json 里把 checks.typescript.enabled 设为 false。',
    )
  }

  const vueRange = vueDependency(root, pkg.dir)
  const vueFiles = check.vue === false ? 0 : hasVueFile(pkg.dir)
  const isVue = check.vue !== false && (vueFiles > 0 || Boolean(vueRange))
  const bin = check.bin ?? (isVue ? 'vue-tsc' : 'tsc')
  const resolved = resolveBinFrom(root, pkg.dir, bin)

  if (isVue && !check.bin) assertVueTscCompatibility(root, pkg)

  const started = now()
  const result = await run(resolved, check.args ?? DEFAULT_ARGS, {
    cwd: pkg.dir,
    timeoutMs: check.timeoutMs,
  })
  const elapsed = now() - started
  const tsconfigRel = toRepoPath(root, tsconfig)

  if (result.timedOut) {
    recordPackage(timings, id, pkg, elapsed, 'timeout')
    return [
      notExecuted(id, {
        file: tsconfigRel,
        message:
          `类型检查在 ${pkg.rel || '仓库根'} 超时（上限 ${check.timeoutMs ?? 120000}ms），本次没有产出任何类型结果，` +
          '属于“检查未执行”，因此判失败。',
        fix: '排查 tsc/vue-tsc 是否卡在超大项目或失效的 project references；必要时调大 checks.typescript.timeoutMs。',
      }),
    ]
  }

  if (result.missing) {
    if (isVue) {
      recordPackage(timings, id, pkg, elapsed, 'missing')
      return [
        {
          ruleId: 'typescript/vue-tsc-missing',
          file: tsconfigRel,
          line: null,
          severity: 'error',
          message:
            `检测到 Vue 项目（${vueFiles > 0 ? `${vueFiles} 个 .vue 文件` : '依赖 vue'}），` +
            `但类型检查器 "${bin}" 不可用：本次没有检查 .vue，属于“类型门禁未生效”，因此判失败。`,
          fix:
            `在 ${pkg.rel || '仓库根'} 安装 vue-tsc：npm i -D vue-tsc（Vue 3 + TS 5 用 2.x，Vue 2.7 用 1.8.x）；` +
            '确实不想检查 .vue 时，把 checks.typescript.vue 设为 false，并在评审里明确接受这个缺口。',
        },
      ]
    }
    return [
      notExecuted(id, {
        file: tsconfigRel,
        message:
          `找不到类型检查器 "${bin}"（${pkg.rel || '仓库根'}），本次没有执行任何类型检查，属于“检查未执行”。`,
        fix: '在项目内安装：npm i -D typescript（Vue 项目还需要 vue-tsc）；确实不需要时把 checks.typescript.enabled 设为 false。',
      }),
    ]
  }
  const violations = parseDiagnostics(root, pkg, result)

  if (result.code !== 0 && violations.length === 0) {
    recordPackage(timings, id, pkg, elapsed, 'failed')
    return [
      notExecuted(id, {
        file: tsconfigRel,
        message:
          `${bin} 在 ${pkg.rel || '仓库根'} 执行失败（退出码 ${result.code}），但没有解析到类型错误；` +
          '本次类型检查结果不可用，属于“检查未执行”。',
        fix:
          `检查 ${pathOf(tsconfigRel)} 是否可用、project references 是否完整，或调整 checks.typescript.args。\n` +
          `${tail(result.stdout || result.stderr)}`,
      }),
    ]
  }

  recordPackage(timings, id, pkg, elapsed, 'ok', violations.length, { bin: isVue ? 'vue-tsc' : 'tsc' })
  return violations
}

function pathOf(file) {
  return file || 'tsconfig.json'
}

/** vue-tsc 2.x 需要 TS >= 5；Vue 2 需要 vue-tsc 1.x。版本不匹配时直接拒绝，避免“跑了但类型没查”。 */
function assertVueTscCompatibility(root, pkg) {
  const vueTscVersion = installedVersion(root, pkg.dir, 'vue-tsc')
  const tsVersion = installedVersion(root, pkg.dir, 'typescript')
  const vueVersion = installedVersion(root, pkg.dir, 'vue')
  const vueTscMajor = majorOf(vueTscVersion)
  const tsMajor = majorOf(tsVersion)
  const vueMajor = majorOf(vueVersion)

  if (vueTscMajor && vueTscMajor >= 2) {
    if (tsMajor && tsMajor < 5) {
      throw new UserError(
        `${pkg.rel || '仓库根'} 安装的是 vue-tsc ${vueTscVersion}，它要求 TypeScript >= 5，当前是 ${tsVersion}。\n` +
          '请升级 typescript 到 5.x，或把 vue-tsc 降到 1.8.x（Vue 2.7 / 旧 TS 项目）。',
      )
    }
    if (vueMajor === 2) {
      throw new UserError(
        `${pkg.rel || '仓库根'} 是 Vue 2 项目，但安装的是 vue-tsc ${vueTscVersion}（只支持 Vue 3）。\n` +
          'Vue 2.7 请安装 vue-tsc@1.8.x。',
      )
    }
  }

  if (vueTscMajor === 1 && tsMajor && tsMajor >= 5.5) {
    // 1.x 对新 TS 的兼容性有限，给出提示但仍尝试执行，由真实诊断决定成败。
    console.error(
      `fe-guard: 提示 ${pkg.rel || '仓库根'} 使用 vue-tsc ${vueTscVersion} + TypeScript ${tsVersion}，` +
        '若出现解析异常请升级 vue-tsc 到 2.x。',
    )
  }
}

function majorOf(version) {
  if (!version) return null
  const match = String(version).match(/(\d+)/)
  return match ? Number(match[1]) : null
}

function parseDiagnostics(root, pkg, result) {
  const violations = []
  const lines = `${result.stdout}\n${result.stderr}`.split('\n')
  for (const rawLine of lines) {
    const match = rawLine.trim().match(DIAGNOSTIC)
    if (!match) continue
    const [, file, line, , severity, code, message] = match
    violations.push({
      ruleId: `typescript/${code}`,
      file: toRepoPath(root, file, pkg.dir),
      line: Number(line),
      severity: severity === 'warning' ? 'warn' : 'error',
      message,
      fix: null,
    })
  }
  return violations
}
