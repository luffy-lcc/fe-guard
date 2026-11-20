import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { SKIP_DIRS, readJsonFile, toPosix, walkSourceFiles } from './utils.js'

const MAX_DEPTH = 6

/**
 * 识别 workspace 形态：npm / yarn 的 package.json workspaces、pnpm-workspace.yaml、lerna.json。
 * 只读文件系统，不执行 pnpm/npm，也不依赖 lock 文件。
 */
export function detectWorkspace(root) {
  const rootPkg = readJsonFile(path.join(root, 'package.json'), {})
  const declared = workspacePatterns(root, rootPkg)
  if (declared.list.length === 0) {
    return { isWorkspace: false, source: null, patterns: [], packages: [] }
  }

  const seen = new Map()
  for (const pattern of declared.list) {
    for (const dir of expandPattern(root, pattern)) {
      const rel = toPosix(path.relative(root, dir)) || '.'
      if (!seen.has(rel)) seen.set(rel, { name: packageName(dir, rel), dir, rel })
    }
  }

  const packages = [...seen.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return {
    isWorkspace: packages.length > 0,
    source: declared.source,
    patterns: declared.list,
    packages,
  }
}

function workspacePatterns(root, rootPkg) {
  const npmPatterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
      ? rootPkg.workspaces.packages
      : []
  if (npmPatterns.length > 0) return { source: 'package.json#workspaces', list: npmPatterns }

  const pnpmFile = path.join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpmFile)) {
    const list = pnpmPatterns(readFileSync(pnpmFile, 'utf8'))
    if (list.length > 0) return { source: 'pnpm-workspace.yaml', list }
  }

  const lerna = readJsonFile(path.join(root, 'lerna.json'), null)
  if (Array.isArray(lerna?.packages) && lerna.packages.length > 0) {
    return { source: 'lerna.json', list: lerna.packages }
  }
  return { source: null, list: [] }
}

/** 极简 YAML：只认 packages: 下的 "- 'apps/*'" 列表，不引入 yaml 依赖。 */
function pnpmPatterns(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^packages\s*:/.test(line))
  if (start === -1) return []
  const list = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\S/.test(line)) break
    const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)
    if (match) list.push(match[1].trim())
  }
  return list
}

function expandPattern(root, pattern) {
  const clean = String(pattern).replace(/^\.\//, '').replace(/\/+$/, '')
  if (!clean || clean.startsWith('!')) return []

  let dirs = [root]
  for (const segment of clean.split('/')) {
    const next = []
    for (const dir of dirs) {
      if (segment === '**') collectDirs(dir, next, 0)
      else if (segment === '*') listDirs(dir).forEach((child) => next.push(child))
      else if (segment.includes('*')) {
        const regex = new RegExp(`^${segment.split('*').map(escapeRegex).join('.*')}$`)
        listDirs(dir)
          .filter((child) => regex.test(path.basename(child)))
          .forEach((child) => next.push(child))
      } else {
        const full = path.join(dir, segment)
        if (isDirectory(full)) next.push(full)
      }
    }
    dirs = next
  }
  return dirs.filter((dir) => existsSync(path.join(dir, 'package.json')))
}

function collectDirs(dir, output, depth) {
  if (depth > MAX_DEPTH) return
  output.push(dir)
  for (const child of listDirs(dir)) collectDirs(child, output, depth + 1)
}

function listDirs(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
    .map((entry) => path.join(dir, entry.name))
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function packageName(dir, rel) {
  const pkg = readJsonFile(path.join(dir, 'package.json'), null)
  return typeof pkg?.name === 'string' ? pkg.name : rel
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 本次检查要跑哪些 package：
 * - 非 workspace / 显式 workspace:'root'：只在仓库根跑一次；
 * - workspace：每个子包各跑一次；根目录有 src 时也作为 root 包参与（避免根源码漏检）。
 */
export function planPackages(root, workspace, check) {
  if (check?.workspace === 'root' || !workspace?.isWorkspace) {
    return [{ name: '(root)', dir: root, rel: '' }]
  }
  // pnpm-workspace 允许把 "." 写进 packages：根包只应执行一次，不能和补进来的根重复。
  const packages = []
  const seen = new Set()
  for (const pkg of workspace.packages) {
    const rel = pkg.rel === '.' ? '' : pkg.rel
    if (seen.has(rel)) continue
    seen.add(rel)
    packages.push({ ...pkg, rel, dir: rel ? pkg.dir : root })
  }
  if (existsSync(path.join(root, 'src')) && !seen.has('')) {
    const rootPkg = readJsonFile(path.join(root, 'package.json'), {})
    packages.unshift({ name: rootPkg.name ?? '(root)', dir: root, rel: '' })
  }
  return packages
}

/**
 * 根级检查（deps / ui / metrics / boundaries）在 monorepo 下要覆盖所有子包，但仍只执行一次：
 * 把默认的 ['src'] 展开成各 package 的源码目录，而不是对每个 package 重复跑整个检查。
 */
export function workspaceRoots(root, check, workspace) {
  const roots = check?.roots
  if (!workspace?.isWorkspace || !Array.isArray(roots) || roots.length === 0) return check
  const isDefault = roots.length === 1 && roots[0] === 'src'
  if (!isDefault || existsSync(path.join(root, 'src'))) return check

  const expanded = []
  for (const pkg of workspace.packages) {
    const relative = pkg.rel === '.' ? '' : pkg.rel
    const candidate = relative ? `${relative}/src` : 'src'
    expanded.push(existsSync(path.join(root, candidate)) ? candidate : relative || '.')
  }
  return { ...check, roots: expanded }
}

/** 从 from 向上（含 root）找某个文件/目录，找到多个名字里的第一个。 */
export function findUp(root, from, names) {
  let dir = from
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (dir === root) return null
    const parent = path.dirname(dir)
    if (parent === dir || !isInside(root, parent)) return null
    dir = parent
  }
}

function isInside(root, dir) {
  const rel = path.relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
]

/** 该 package 是否有可用的 ESLint 配置（自己或继承到仓库根）。 */
export function eslintConfigFor(root, dir) {
  const found = findUp(root, dir, ESLINT_CONFIG_NAMES)
  if (found) return found
  let current = dir
  while (true) {
    const pkg = readJsonFile(path.join(current, 'package.json'), null)
    if (pkg?.eslintConfig) return path.join(current, 'package.json')
    if (current === root) return null
    const parent = path.dirname(current)
    if (parent === current || !isInside(root, parent)) return null
    current = parent
  }
}

export function tsconfigFor(dir) {
  const file = path.join(dir, 'tsconfig.json')
  return existsSync(file) ? file : null
}

/** 从 package 目录向上找 node_modules/.bin 里的可执行文件。 */
export function resolveBinFrom(root, dir, bin) {
  if (bin.includes('/') || bin.includes(path.sep)) return path.isAbsolute(bin) ? bin : path.resolve(dir, bin)
  let current = dir
  while (true) {
    const local = path.join(current, 'node_modules', '.bin', bin)
    if (existsSync(local)) return local
    if (current === root) return bin
    const parent = path.dirname(current)
    if (parent === current || !isInside(root, parent)) return bin
    current = parent
  }
}

/** 判断 package（含祖先）是否依赖 vue；用于 vue-tsc 自动切换。 */
export function vueDependency(root, dir) {
  let current = dir
  while (true) {
    const pkg = readJsonFile(path.join(current, 'package.json'), null)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (typeof pkg?.[field]?.vue === 'string') return pkg[field].vue
    }
    if (current === root) return null
    const parent = path.dirname(current)
    if (parent === current || !isInside(root, parent)) return null
    current = parent
  }
}

/** 只看有没有 .vue，找到一个就停；用于“有 Vue 文件但没装 vue-tsc”的判定。 */
export function hasVueFile(dir) {
  const rootDir = existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : dir
  const found = walkSourceFiles(dir, {
    roots: [path.relative(dir, rootDir) || '.'],
    extensions: ['.vue'],
  })
  return found.length
}

/** 读某个包（含祖先）里安装的依赖版本，用于 vue-tsc / TypeScript 版本兼容判断。 */
export function installedVersion(root, dir, name) {
  let current = dir
  while (true) {
    const file = path.join(current, 'node_modules', name, 'package.json')
    if (existsSync(file)) {
      const pkg = readJsonFile(file, null)
      if (typeof pkg?.version === 'string') return pkg.version
    }
    if (current === root) return null
    const parent = path.dirname(current)
    if (parent === current || !isInside(root, parent)) return null
    current = parent
  }
}
