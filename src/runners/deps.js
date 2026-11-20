import path from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { matchesIgnore, readJsonFile, run, walkSourceFiles } from '../utils.js'

export const id = 'deps'

const IMPORT_PATTERNS = [
  /(?:^|[\n;])\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /(?:^|[\n;])\s*export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** 从源码里抽出所有 import/require/export-from 的模块说明符（含行号）。 */
export function extractImports(text) {
  const source = String(text)
  const results = []
  const seen = new Set()
  for (const pattern of IMPORT_PATTERNS) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]
      const line = source.slice(0, match.index).split('\n').length
      const key = `${specifier}::${line}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ specifier, line })
    }
  }
  return results
}

/** 'dayjs/plugin/x' → 'dayjs'；'@scope/pkg/sub' → '@scope/pkg'；相对路径返回 null。 */
export function packageOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  const cleaned = specifier.replace(/^node:/, '')
  if (!cleaned) return null
  const parts = cleaned.split('/')
  if (cleaned.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : cleaned
  return parts[0]
}

export function isInternalSpecifier(specifier, prefixes = []) {
  return prefixes.some((prefix) => specifier.startsWith(prefix))
}

/** Vite / Rollup 的虚拟模块（virtual:windi.css、~icons/x、\0plugin 等）不在 package.json 里，跳过。 */
export function isVirtualSpecifier(specifier) {
  return /^virtual:/.test(specifier) || /^~icons(\/|$)/.test(specifier) || /^#/.test(specifier) || specifier.startsWith('\0')
}

/** 找出某个包属于哪个能力，以及它是否被禁用。 */
export function capabilityOf(pkg, capabilities = {}) {
  for (const [name, definition] of Object.entries(capabilities)) {
    if ((definition.block ?? []).includes(pkg)) return { name, ...definition, blocked: true }
    if ((definition.allow ?? []).includes(pkg)) return { name, ...definition, blocked: false }
  }
  return null
}

function installedDependencies(pkg) {
  const all = new Set()
  const runtime = new Set()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg?.[field] ?? {})) {
      all.add(name)
      if (field !== 'devDependencies') runtime.add(name)
    }
  }
  return { all, runtime }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.fe-guard'])

/**
 * 收集仓库内所有 package.json（根目录 + roots 下的子包）。
 * monorepo 里 apps/a 的依赖只写在 apps/a/package.json，不能只看根。
 */
export function discoverManifests(root, roots = []) {
  const candidates = new Set([root])
  const walked = new Set()
  const queue = []
  for (const item of roots) {
    const start = path.join(root, item)
    queue.push(start)
    // 扫描根可能是 <pkg>/src：把它的祖先目录也纳入候选，才能找到 <pkg>/package.json。
    let dir = start
    while (true) {
      candidates.add(dir)
      if (dir === root) break
      const parent = path.dirname(dir)
      if (parent === dir || !parent.startsWith(path.resolve(root))) break
      dir = parent
    }
  }
  while (queue.length > 0) {
    const dir = queue.pop()
    if (walked.has(dir) || !existsSync(dir)) continue
    walked.add(dir)
    candidates.add(dir)
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name))
    }
  }
  return [...candidates]
    .filter((dir) => existsSync(path.join(dir, 'package.json')))
    .map((dir) => ({
      dir: path.relative(root, dir).split(path.sep).join('/'),
      ...installedDependencies(readJsonFile(path.join(dir, 'package.json'), {})),
    }))
}

/** 传递依赖 / 提升安装的包（例如 vue 带的 @vue/runtime-core）在 node_modules 里能解析到，不算幽灵。 */
function installedOnDisk(root, file, pkg) {
  let dir = path.dirname(path.join(root, file))
  const stop = path.resolve(root)
  while (dir.startsWith(stop)) {
    if (existsSync(path.join(dir, 'node_modules', ...pkg.split('/')))) return true
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return existsSync(path.join(root, 'node_modules', ...pkg.split('/')))
}

/** 文件可用的依赖 = 自身 package.json + 所有祖先 package.json（pnpm workspace 常把公共依赖放在根）。 */
export function installedFor(file, manifests) {
  const all = new Set()
  for (const manifest of manifests) {
    if (manifest.dir && !file.startsWith(`${manifest.dir}/`)) continue
    for (const name of manifest.all) all.add(name)
  }
  return all
}

/** 某个 package.json 的有效依赖（含祖先），用于判断同能力重复。 */
function effectiveDeps(manifest, manifests) {
  const all = new Set(manifest.all)
  for (const other of manifests) {
    if (!other.dir || manifest.dir === other.dir) continue
    if (manifest.dir.startsWith(`${other.dir}/`)) for (const name of other.all) all.add(name)
  }
  return all
}

function conflictViolation(file, item, capability) {
  const alternative = capability.allow?.[0] ?? capability.useInstead ?? '项目内封装'
  return {
    ruleId: 'deps/capability-conflict',
    file,
    line: item.line,
    severity: 'error',
    message:
      `不要直接 import "${packageOf(item.specifier)}"（${capability.name} 能力）。` +
      `本项目统一用 ${alternative}${capability.useInstead ? `，封装在 ${capability.useInstead}` : ''}。`,
    fix: capability.example
      ? `改为：${capability.example.replace(/\n/g, ' ')}`
      : `改为复用 ${capability.useInstead || alternative}，不要引入第二套实现。`,
  }
}

function phantomViolation(file, item) {
  return {
    ruleId: 'deps/phantom',
    file,
    line: item.line,
    severity: 'error',
    message: `import 了未在 package.json 声明的包 "${packageOf(item.specifier)}"（拼写错误、幻觉依赖或漏装）。`,
    fix:
      `如果确实需要：npm i ${packageOf(item.specifier)}，并在 fe-guard.config.json 的 checks.deps.registry 里登记用途；` +
      '否则删除这条 import。',
  }
}

function unregisteredViolation(dep, file) {
  return {
    ruleId: 'deps/unregistered',
    file,
    line: null,
    severity: 'error',
    message: `新增依赖 "${dep}" 未登记用途。AI 很容易随手装包，第二套同类库就是这样进来的。`,
    fix:
      `在 fe-guard.config.json 增加 "checks.deps.registry": { "${dep}": "用在哪、为什么不能用已有实现" }；` +
      '如果它属于日期/请求等已有能力，删掉它并改用已登记的库。',
  }
}

function duplicateViolation(file, capability, found) {
  const keep = capability.allow?.[0] ?? capability.useInstead ?? '已有实现'
  return {
    ruleId: 'deps/capability-duplicate',
    file,
    line: null,
    severity: 'error',
    message: `package.json 同时依赖 ${found.map((name) => `"${name}"`).join(' / ')}（${capability.name} 能力，应只有一个）。`,
    fix: `保留 ${keep}，移除其余同类库${capability.useInstead ? `；统一从 ${capability.useInstead} 使用` : ''}。`,
  }
}

/** 每个 package.json 与 base 版本的依赖差异（只比较运行时依赖）。monorepo 里逐个子包比较。 */
async function addedRuntimeDependencies(root, base, manifests) {
  const added = []
  for (const manifest of manifests) {
    const rel = manifest.dir ? `${manifest.dir}/package.json` : 'package.json'
    // ./ 前缀按 cwd 解析：项目根是 git 根的子目录时，必须读自己这份 package.json。
    const result = await run('git', ['show', `${base}:./${rel}`], { cwd: root })
    if (result.code !== 0) continue
    let previous
    try {
      previous = JSON.parse(result.stdout)
    } catch {
      continue
    }
    const before = installedDependencies(previous).runtime
    for (const dep of manifest.runtime) {
      if (!before.has(dep)) added.push({ dep, file: rel })
    }
  }
  return added
}

/**
 * 依赖守卫。
 * - 每个被检查的文件：拦截被禁用能力库、未声明的包；
 * - package.json 有变更时（或全量模式）：拦截同能力重复依赖、新增依赖未登记用途。
 * 全量模式用 git 对比 diff.base，所以“已提交的历史依赖”不会反复报，只拦新增。
 */
export async function runCheck({ root, check, changedFiles, config }) {
  const packageFile = path.join(root, 'package.json')
  if (!existsSync(packageFile)) return []
  const manifests = discoverManifests(root, check.roots)

  const scope = changedFiles ? new Set(changedFiles) : null
  const files = walkSourceFiles(root, { roots: check.roots, extensions: check.extensions }).filter(
    // 生成的 .d.ts（unplugin-vue-components 等）会 import 虚拟包，不当作业务依赖。
    (file) => !file.endsWith('.d.ts'),
  )
  const targets = scope ? files.filter((file) => scope.has(file)) : files

  const violations = []
  for (const file of targets) {
    const installed = installedFor(file, manifests)
    const text = readFileSync(path.join(root, file), 'utf8')
    for (const item of extractImports(text)) {
      if (isInternalSpecifier(item.specifier, check.internalPrefixes)) continue
      if (isVirtualSpecifier(item.specifier)) continue
      const pkgName = packageOf(item.specifier)
      if (!pkgName || isBuiltin(pkgName)) continue

      const capability = capabilityOf(pkgName, check.capabilities)
      if (capability?.blocked) {
        // 封装层自己（例如 src/services/http.ts）必须能 import 底层库。
        if (matchesIgnore(file, capability.exempt)) continue
        violations.push(conflictViolation(file, item, capability))
        continue
      }
      if (!installed.has(pkgName) && !installedOnDisk(root, file, pkgName)) {
        violations.push(phantomViolation(file, item))
      }
    }
  }

  const packageChanged = !scope || scope.has('package.json') || manifests.some((m) => scope.has(`${m.dir}/package.json`))
  if (packageChanged) {
    for (const manifest of manifests) {
      const installed = effectiveDeps(manifest, manifests)
      for (const [name, definition] of Object.entries(check.capabilities)) {
        const known = [...(definition.allow ?? []), ...(definition.block ?? [])].filter((dep) => installed.has(dep))
        if (known.length > 1) {
          violations.push(duplicateViolation(manifest.dir ? `${manifest.dir}/package.json` : 'package.json', { name, ...definition }, known))
        }
      }
    }

    const added = await addedRuntimeDependencies(root, config?.diff?.base ?? 'HEAD', manifests)
    for (const { dep, file } of added) {
      if (check.registry[dep]) continue
      if (capabilityOf(dep, check.capabilities)?.blocked) continue
      violations.push(unregisteredViolation(dep, file))
    }
  }

  return violations
}
