import path from 'node:path'
import { existsSync } from 'node:fs'
import { defaultConfig } from './config.js'
import { applyPreset } from './presets.js'
import { toPosix } from './utils.js'
import { detectWorkspace, eslintConfigFor, hasVueFile, tsconfigFor } from './workspace.js'

/** dependency-cruiser 的配置文件候选：init 按实际存在的那个写进 args。 */
export const BOUNDARIES_CONFIG_NAMES = ['.dependency-cruiser.cjs', '.dependency-cruiser.js', '.dependency-cruiser.json']

/**
 * 只读探测项目现状，供 init 决定哪些检查值得默认启用。
 *
 * 只判断「这项检查有没有最低限度的前置条件」：
 * - 没有 tsconfig / ESLint 配置 / depcruise 配置，属于「还没接这项检查」，init 默认关闭；
 * - 工具装了但版本不对（例如 Vue + TS 7）、有 .vue 却没装 vue-tsc，属于「接了但坏了」，
 *   不在 init 里掩盖，交给 check 明确报错。
 */
export function detectProject(root) {
  const workspace = detectWorkspace(root)
  const packageDirs = workspace.isWorkspace ? workspace.packages.map((pkg) => pkg.dir) : []
  const dirs = [root, ...packageDirs]

  const tsconfigs = unique(dirs.map((dir) => tsconfigFor(dir)).filter(Boolean))
  const eslintConfigs = unique(dirs.map((dir) => eslintConfigFor(root, dir)).filter(Boolean))
  const boundariesConfig = BOUNDARIES_CONFIG_NAMES.find((name) => existsSync(path.join(root, name))) ?? null

  return {
    workspace,
    typescript: { tsconfigs: tsconfigs.map((file) => toPosix(path.relative(root, file))) },
    eslint: { configs: eslintConfigs.map((file) => toPosix(path.relative(root, file))) },
    boundaries: { config: boundariesConfig },
    vue: { files: hasVueFile(root) },
  }
}

/**
 * 按预设与探测结果生成 init 配置。
 *
 * 顺序是「默认配置 → 预设（定基调）→ 探测（做降级）」：
 * - 预设表达人的意图（关哪些检查、阈值多宽），先应用；
 * - 探测表达项目的事实（前置条件在不在），只在缺失时把检查写成 `enabled: false`，
 *   不会把预设关掉的检查重新打开，也不会因为探测而改动阈值。
 * 返回的 notes 是给 init 打印的说明，逐条对应一个探测项。
 */
export function configForProject(root, { preset } = {}) {
  const detection = detectProject(root)
  const config = defaultConfig()
  const presetInfo = preset ? applyPreset(config, preset) : null
  const disabled = new Map()

  if (presetInfo) {
    for (const [key, patch] of Object.entries(presetInfo.checks)) {
      if (patch.enabled === false) disabled.set(key, `预设 ${preset}`)
    }
  }

  if (detection.typescript.tsconfigs.length === 0) {
    config.checks.typescript.enabled = false
    disabled.set('typescript', '没有找到 tsconfig.json（纯 JS 项目不需要；以后加了 tsconfig，把 enabled 改回 true）')
  }
  if (detection.eslint.configs.length === 0) {
    config.checks.eslint.enabled = false
    disabled.set('eslint', '没有找到 ESLint 配置（eslint.config.* / .eslintrc* / package.json#eslintConfig）')
  }
  if (detection.boundaries.config === null) {
    config.checks.boundaries.enabled = false
    disabled.set('boundaries', '没有找到 .dependency-cruiser.{cjs,js,json}（装了 dependency-cruiser 但没有规则，跑起来也是空的）')
  } else if (config.checks.boundaries.enabled) {
    config.checks.boundaries.args = ['src', '--output-type', 'json', '--config', detection.boundaries.config]
  }

  const notes = [
    detection.workspace.isWorkspace
      ? `workspace: ${detection.workspace.source}，${detection.workspace.packages.length} 个 package`
      : 'workspace: 单仓库（未检测到 workspaces / pnpm-workspace.yaml / lerna.json）',
  ]
  if (presetInfo) notes.push(`预设: ${preset} — ${presetInfo.summary}`)

  for (const key of ['typescript', 'eslint', 'boundaries', 'ui']) {
    if (disabled.has(key)) notes.push(`已关闭 checks.${key} — ${disabled.get(key)}`)
  }
  if (!disabled.has('typescript')) {
    notes.push(`TypeScript: 找到 ${detection.typescript.tsconfigs.join(', ')}`)
  }
  if (!disabled.has('eslint')) notes.push(`ESLint: 找到 ${detection.eslint.configs.join(', ')}`)
  if (!disabled.has('boundaries')) notes.push(`架构边界: 找到 ${detection.boundaries.config}`)

  notes.push(
    detection.vue.files > 0
      ? `Vue: 检测到 ${detection.vue.files} 个 .vue 文件，TypeScript 检查会自动改用 vue-tsc（需自行安装）`
      : 'Vue: 未检测到 .vue 文件，TypeScript 检查使用 tsc',
  )
  const mismatch = presetMismatch(preset, presetInfo, detection)
  if (mismatch) notes.push(mismatch)

  return { config, detection, preset: presetInfo, notes }
}

/** 预设与项目实际形态明显不匹配时提醒一句，但不擅自改预设。 */
function presetMismatch(preset, presetInfo, detection) {
  if (!presetInfo) return null
  if (preset === 'js' && detection.vue.files > 0) {
    return `提示: 预设 js 关闭了类型检查与组件清单，但检测到 ${detection.vue.files} 个 .vue 文件；Vue 项目建议改用 --preset vue`
  }
  if (preset === 'vue' && detection.vue.files === 0) {
    return '提示: 已应用预设 vue，但未检测到 .vue 文件；纯 JS 项目可以改用 --preset js'
  }
  return null
}

function unique(items) {
  return [...new Set(items)]
}
