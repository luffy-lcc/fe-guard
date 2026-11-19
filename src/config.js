import path from 'node:path'
import { existsSync } from 'node:fs'
import { UserError, readJsonFile } from './utils.js'
import { isNotExecutedRule } from './not-executed.js'
import { DEFAULT_PROFILE, isProfileName, PROFILE_NAMES } from './profiles.js'

export const CONFIG_FILE = 'fe-guard.config.json'
export const CONFIG_SCHEMA_VERSION = 1
export const SUPPORTED_CHECKS = ['eslint', 'typescript', 'boundaries', 'deps', 'ui', 'metrics', 'diff-size']
const LEVELS = ['error', 'warn']

/** 不参与 baseline 的检查：大 diff 是“这次的事件”，入账会永久关掉闸门。 */
export const BASELINE_EXEMPT = new Set(['diff-size'])

/** 永远不允许入账的规则：它们代表“检查根本没有生效”，入账等于自欺。 */
export function isBaselineExempt(ruleId) {
  return BASELINE_EXEMPT.has(adapterOfRule(ruleId)) || isNotExecutedRule(ruleId)
}

/**
 * 默认配置：init 时写进目标仓库。所有检查都默认开启、都按 error 处理，
 * 使用者可以只改这一个文件关掉或降级任意一项。
 *
 * 已有项目（v1/v2 配置）里没有新检查段时，normalizeConfig 会把它们视为关闭，
 * 保证升级不改变旧仓库的行为。
 */
export function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: true,
    profile: DEFAULT_PROFILE,
    checks: defaultChecks(),
    baseline: {
      path: 'fe-guard.baseline.json',
      autoTighten: true,
    },
    feedback: {
      path: '.fe-guard/false-positives.jsonl',
    },
    report: {
      path: '.fe-guard/report.json',
    },
    diff: {
      base: 'HEAD',
    },
    workflow: {
      enabled: true,
      gate: { mode: 'full', testCommand: 'node --test', testTimeoutMs: 120000 },
      stages: { contract: 'enforce', plan: 'enforce', verify: 'enforce' },
    },
  }
}

/** 七项检查的默认值；单独拆出来，避免 defaultConfig 变成一个超长函数。 */
export function defaultChecks() {
  return {
    eslint: {
      enabled: true,
      level: 'error',
      bin: 'eslint',
      args: ['--format', 'json'],
      // 空数组 = 自动：有 src/ 只扫 src/，否则扫仓库根。避免把 dist、docker 产物一起 lint。
      targets: [],
      // auto = workspace 下每个 package 各跑一次（各用自己目录的配置）；root = 只在仓库根跑一次。
      workspace: 'auto',
      // 子进程超时：卡死的 lint 插件不能把 git commit 一起挂住。
      timeoutMs: 120000,
      extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue'],
    },
    typescript: {
      enabled: true,
      level: 'error',
      bin: 'tsc',
      args: ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'],
      // auto = 检测到 Vue 后自动换 vue-tsc；false = 明确只用 tsc（不检查 .vue，自行承担）。
      vue: 'auto',
      workspace: 'auto',
      timeoutMs: 120000,
    },
    boundaries: {
      enabled: true,
      level: 'error',
      bin: 'depcruise',
      args: ['src', '--output-type', 'json', '--config', '.dependency-cruiser.cjs'],
      timeoutMs: 120000,
    },
    deps: {
      enabled: true,
      level: 'error',
      roots: ['src'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
      internalPrefixes: ['@/', '~/', 'src/'],
      capabilities: {
        date: {
          allow: ['dayjs'],
          block: ['moment', 'date-fns', 'luxon'],
          useInstead: 'src/utils/date.ts',
          example: "import dayjs from 'dayjs';\ndayjs(ts).format('YYYY-MM-DD')",
        },
      },
      registry: {},
    },
    ui: {
      enabled: true,
      level: 'error',
      roots: ['src'],
      extensions: ['.vue', '.tsx', '.jsx'],
      inventory: '.fe-guard/ui-inventory.json',
      propOverlap: 0.8,
      minProps: 2,
    },
    metrics: {
      enabled: true,
      level: 'error',
      roots: ['src'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
      maxFileLines: 500,
      maxFunctionLines: 100,
      maxAny: 20,
      // 按目录前缀覆盖阈值（最长前缀匹配）：monorepo 各包 / 单仓库遗留区可差异化。
      overrides: {},
      duplication: {
        windowTokens: 50,
        minTokens: 200,
        maxRatio: 0.5,
        // 开启后重复检测抗「复制改名」，但结构相似的不同逻辑也会命中；默认关闭，升级不改旧仓库。
        normalizeIdentifiers: false,
        // 多语言词条天然同构，算重复只会制造噪声。
        ignore: ['**/locales/**', '**/i18n/**', '**/lang/**'],
      },
    },
    'diff-size': {
      enabled: true,
      level: 'error',
      maxFiles: 20,
      maxLines: 600,
      ignore: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.min.js', 'dist/**', '.fe-guard/**', 'fe-guard.baseline.json'],
    },
  }
}

/**
 * 配置文件位置：显式 --config > FE_GUARD_CONFIG > 仓库根目录的默认文件。
 * 相对路径按当前工作目录解析，便于在任意目录执行钩子。
 */
export function resolveConfigFile(root, configPath) {
  const requested = configPath || process.env.FE_GUARD_CONFIG
  if (!requested) return path.join(root, CONFIG_FILE)
  return path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested)
}

export function loadConfig(root, { configPath } = {}) {
  const file = resolveConfigFile(root, configPath)
  if (!existsSync(file)) {
    const hint = file.endsWith(CONFIG_FILE)
      ? `未找到 ${path.relative(root, file) || CONFIG_FILE}。请先在项目根目录运行：fe-guard init`
      : `未找到配置 ${file}（来自 --config / FE_GUARD_CONFIG）。请检查路径，或先运行：fe-guard init`
    throw new UserError(hint)
  }
  return normalizeConfig(readJsonFile(file, {}), file)
}

export function normalizeConfig(raw, source = CONFIG_FILE) {
  if (raw.schemaVersion !== undefined) {
    if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion > CONFIG_SCHEMA_VERSION) {
      throw new UserError(
        `${source} 的 schemaVersion=${raw.schemaVersion}，当前 fe-guard 只支持 ${CONFIG_SCHEMA_VERSION}。\n` +
          '  这是“配置比工具新”，继续执行可能静默忽略新字段。\n' +
          '  升级工具：npm i -D fe-guard@latest；或把配置回退到兼容版本。\n' +
          '  不要直接删配置重新 init——那会丢掉你已有的阈值与开关。',
      )
    }
  }
  const profile = raw.profile ?? DEFAULT_PROFILE
  if (!isProfileName(profile)) {
    throw new UserError(`${source} 中 profile 只能是 ${PROFILE_NAMES.join(' / ')}，当前为 "${profile}"`)
  }
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: raw.enabled !== false,
    profile,
    checks: {},
    baseline: {
      path: raw.baseline?.path ?? 'fe-guard.baseline.json',
      autoTighten: raw.baseline?.autoTighten !== false,
    },
    feedback: { path: raw.feedback?.path ?? '.fe-guard/false-positives.jsonl' },
    report: { path: raw.report?.path ?? '.fe-guard/report.json' },
    diff: { base: raw.diff?.base ?? 'HEAD' },
    workflow: normalizeWorkflow(raw.workflow, source),
  }

  const rawChecks = raw.checks ?? {}
  for (const key of Object.keys(rawChecks)) {
    if (!SUPPORTED_CHECKS.includes(key)) {
      throw new UserError(
        `${source} 里有不支持的检查项 "${key}"。目前支持：${SUPPORTED_CHECKS.join(', ')}`,
      )
    }
  }

  const defaults = defaultConfig().checks
  for (const key of SUPPORTED_CHECKS) {
    const check = rawChecks[key]
    if (!check) {
      // 老配置没有这一段：视为关闭，保证升级不改旧仓库行为。
      config.checks[key] = { enabled: false }
      continue
    }
    const level = check.level ?? 'error'
    if (!LEVELS.includes(level)) {
      throw new UserError(`${source} 中 checks.${key}.level 只能是 error 或 warn，当前为 "${level}"`)
    }
    config.checks[key] = normalizeCheck(key, check, defaults[key], level, source)
  }
  return config
}

function normalizeCheck(key, raw, fallback, level, source) {
  const enabled = raw.enabled !== false
  const base = { ...fallback, ...raw, enabled, level }
  if (key === 'eslint') {
    return {
      enabled,
      level,
      bin: raw.bin,
      args: raw.args,
      targets: raw.targets ?? fallback.targets,
      workspace: normalizeMode(raw.workspace, fallback.workspace, `checks.eslint.workspace`, source),
      timeoutMs: normalizeTimeout(raw.timeoutMs, fallback.timeoutMs, `checks.eslint.timeoutMs`, source),
      extensions: raw.extensions,
    }
  }
  if (key === 'typescript') {
    return {
      enabled,
      level,
      bin: raw.bin,
      args: raw.args,
      vue: normalizeVue(raw.vue, fallback.vue, source),
      workspace: normalizeMode(raw.workspace, fallback.workspace, `checks.typescript.workspace`, source),
      timeoutMs: normalizeTimeout(raw.timeoutMs, fallback.timeoutMs, `checks.typescript.timeoutMs`, source),
    }
  }
  if (key === 'boundaries') {
    return {
      enabled,
      level,
      bin: raw.bin,
      args: raw.args,
      targets: raw.targets ?? fallback.targets,
      timeoutMs: normalizeTimeout(raw.timeoutMs, fallback.timeoutMs, `checks.boundaries.timeoutMs`, source),
      extensions: raw.extensions,
    }
  }
  if (key === 'deps') {
    return {
      enabled,
      level,
      roots: normalizeRoots(raw.roots ?? fallback.roots, `checks.deps.roots`, source),
      extensions: normalizeList(raw.extensions, fallback.extensions, `checks.deps.extensions`, source),
      internalPrefixes: normalizeList(raw.internalPrefixes, fallback.internalPrefixes, `checks.deps.internalPrefixes`, source),
      capabilities: normalizeCapabilities(raw.capabilities ?? fallback.capabilities, source),
      registry: normalizeRegistry(raw.registry ?? fallback.registry, source),
    }
  }
  if (key === 'ui') {
    return {
      enabled,
      level,
      roots: normalizeRoots(raw.roots ?? fallback.roots, `checks.ui.roots`, source),
      extensions: normalizeList(raw.extensions, fallback.extensions, `checks.ui.extensions`, source),
      inventory: raw.inventory ?? fallback.inventory,
      propOverlap: normalizeNumber(raw.propOverlap, fallback.propOverlap, `checks.ui.propOverlap`, source, 1),
      minProps: normalizeNumber(raw.minProps, fallback.minProps, `checks.ui.minProps`, source),
    }
  }
  if (key === 'metrics') {
    const duplication = { ...fallback.duplication, ...(raw.duplication ?? {}) }
    const normalizeIdentifiers = duplication.normalizeIdentifiers ?? false
    if (typeof normalizeIdentifiers !== 'boolean') {
      throw new UserError(`${source} 中 checks.metrics.duplication.normalizeIdentifiers 只能是 true 或 false`)
    }
    return {
      enabled,
      level,
      roots: normalizeRoots(raw.roots ?? fallback.roots, `checks.metrics.roots`, source),
      extensions: normalizeList(raw.extensions, fallback.extensions, `checks.metrics.extensions`, source),
      maxFileLines: normalizeNumber(raw.maxFileLines, fallback.maxFileLines, `checks.metrics.maxFileLines`, source),
      maxFunctionLines: normalizeNumber(raw.maxFunctionLines, fallback.maxFunctionLines, `checks.metrics.maxFunctionLines`, source),
      maxAny: normalizeNumber(raw.maxAny, fallback.maxAny, `checks.metrics.maxAny`, source),
      overrides: normalizeMetricOverrides(raw.overrides ?? {}, source),
      duplication: {
        windowTokens: normalizeNumber(duplication.windowTokens, fallback.duplication.windowTokens, `checks.metrics.duplication.windowTokens`, source),
        minTokens: normalizeNumber(duplication.minTokens, fallback.duplication.minTokens, `checks.metrics.duplication.minTokens`, source),
        maxRatio: normalizeNumber(duplication.maxRatio, fallback.duplication.maxRatio, `checks.metrics.duplication.maxRatio`, source, 1),
        normalizeIdentifiers,
        ignore: normalizeList(duplication.ignore, fallback.duplication.ignore, `checks.metrics.duplication.ignore`, source),
      },
    }
  }
  if (key === 'diff-size') {
    return {
      enabled,
      level,
      maxFiles: normalizeNumber(raw.maxFiles, fallback.maxFiles, `checks.diff-size.maxFiles`, source),
      maxLines: normalizeNumber(raw.maxLines, fallback.maxLines, `checks.diff-size.maxLines`, source),
      ignore: normalizeList(raw.ignore, fallback.ignore, `checks.diff-size.ignore`, source),
    }
  }
  return base
}

const METRIC_OVERRIDE_KEYS = ['maxFileLines', 'maxFunctionLines', 'maxAny', 'duplication']

/** overrides：{ "目录前缀": { 阈值 } }。只允许四个阈值字段，未知字段直接报错。 */
function normalizeMetricOverrides(raw, source) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${source} 中 checks.metrics.overrides 必须是 { "目录前缀": { 阈值 } } 形式的对象`)
  }
  const result = {}
  for (const [prefix, def] of Object.entries(raw)) {
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      throw new UserError(`${source} 中 checks.metrics.overrides.${prefix} 必须是对象`)
    }
    for (const key of Object.keys(def)) {
      if (!METRIC_OVERRIDE_KEYS.includes(key)) {
        throw new UserError(
          `${source} 中 checks.metrics.overrides.${prefix} 不支持字段 "${key}"，可用：${METRIC_OVERRIDE_KEYS.join(', ')}`,
        )
      }
    }
    const label = (key) => `checks.metrics.overrides.${prefix}.${key}`
    const entry = {}
    for (const key of ['maxFileLines', 'maxFunctionLines', 'maxAny']) {
      if (def[key] !== undefined) entry[key] = normalizeNumber(def[key], 0, label(key), source)
    }
    if (def.duplication !== undefined) {
      if (def.duplication === null || typeof def.duplication !== 'object' || Array.isArray(def.duplication)) {
        throw new UserError(`${source} 中 ${label('duplication')} 必须是对象`)
      }
      for (const key of Object.keys(def.duplication)) {
        if (key !== 'maxRatio') {
          throw new UserError(`${source} 中 ${label('duplication')} 只支持 maxRatio（窗口参数是全局算法配置）`)
        }
      }
      if (def.duplication.maxRatio !== undefined) {
        entry.duplication = { maxRatio: normalizeNumber(def.duplication.maxRatio, 0, label('duplication.maxRatio'), source, 1) }
      }
    }
    result[prefix] = entry
  }
  return result
}

function normalizeMode(value, fallback, label, source) {
  const mode = value ?? fallback
  if (!['auto', 'root'].includes(mode)) {
    throw new UserError(`${source} 中 ${label} 只能是 auto 或 root，当前为 "${mode}"`)
  }
  return mode
}

function normalizeVue(value, fallback, source) {
  if (value === undefined) return fallback
  if (value === 'auto' || typeof value === 'boolean') return value
  throw new UserError(`${source} 中 checks.typescript.vue 只能是 auto、true 或 false`)
}

function normalizeTimeout(value, fallback, label, source) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UserError(`${source} 中 ${label} 必须是正数（毫秒）`)
  }
  return value
}

function normalizeList(value, fallback, label, source) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new UserError(`${source} 中 ${label} 必须是字符串数组`)
  }
  return [...value]
}

function normalizeRoots(value, label, source) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new UserError(`${source} 中 ${label} 必须是非空的目录数组`)
  }
  return [...value]
}

function normalizeNumber(value, fallback, label, source, max = Infinity) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new UserError(`${source} 中 ${label} 必须是 0${Number.isFinite(max) ? `-${max}` : ''} 之间的数字`)
  }
  return value
}

function normalizeCapabilities(raw, source) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${source} 中 checks.deps.capabilities 必须是对象`)
  }
  const result = {}
  for (const [name, def] of Object.entries(raw)) {
    if (def === null || typeof def !== 'object') {
      throw new UserError(`${source} 中 checks.deps.capabilities.${name} 必须是对象`)
    }
    result[name] = {
      allow: normalizeList(def.allow, [], `checks.deps.capabilities.${name}.allow`, source),
      block: normalizeList(def.block, [], `checks.deps.capabilities.${name}.block`, source),
      exempt: normalizeList(def.exempt, [], `checks.deps.capabilities.${name}.exempt`, source),
      useInstead: typeof def.useInstead === 'string' ? def.useInstead : '',
      example: typeof def.example === 'string' ? def.example : '',
    }
  }
  return result
}

function normalizeRegistry(raw, source) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${source} 中 checks.deps.registry 必须是 { "包名": "用途" } 形式的对象`)
  }
  const result = {}
  for (const [name, purpose] of Object.entries(raw)) {
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      throw new UserError(`${source} 中 checks.deps.registry.${name} 必须写明用途（非空字符串）`)
    }
    result[name] = purpose
  }
  return result
}

/** 该项检查是否参与运行（全局开关优先）。 */
export function checkEnabled(config, key) {
  return config.enabled && Boolean(config.checks[key]?.enabled)
}

/** ruleId 形如 "eslint/no-unused-vars"，这里取出所属检查名。 */
export function adapterOfRule(ruleId) {
  const index = ruleId.indexOf('/')
  return index === -1 ? ruleId : ruleId.slice(0, index)
}

const WORKFLOW_LEVELS = ['enforce', 'warn', 'off']
const GATE_MODES = ['full', 'diff-only', 'staged']

/**
 * 流程层配置。默认全开；`enabled: false` 一行退回 v1 纯检查模式。
 * 每个有约束的阶段可以单独 enforce / warn / off（deliver 是终态，implement 的约束由 plan 承担）。
 */
function normalizeWorkflow(raw = {}, source) {
  const stages = {}
  for (const stage of ['contract', 'plan', 'verify']) {
    const level = raw.stages?.[stage] ?? 'enforce'
    if (!WORKFLOW_LEVELS.includes(level)) {
      throw new UserError(
        `${source} 中 workflow.stages.${stage} 只能是 ${WORKFLOW_LEVELS.join(' / ')}，当前为 "${level}"`,
      )
    }
    stages[stage] = level
  }
  const mode = raw.gate?.mode ?? 'full'
  if (!GATE_MODES.includes(mode)) {
    throw new UserError(`${source} 中 workflow.gate.mode 只能是 ${GATE_MODES.join(' / ')}，当前为 "${mode}"`)
  }
  const testCommand = raw.gate?.testCommand ?? 'node --test'
  if (typeof testCommand !== 'string' || testCommand.trim() === '') {
    throw new UserError(`${source} 中 workflow.gate.testCommand 必须是非空字符串，例如 "node --test" 或 "npx vitest run"`)
  }
  const testTimeoutMs = normalizeTimeout(raw.gate?.testTimeoutMs, 120000, 'workflow.gate.testTimeoutMs', source)
  return { enabled: raw.enabled !== false, gate: { mode, testCommand: testCommand.trim(), testTimeoutMs }, stages }
}

export function stageLevel(config, stage) {
  return config.workflow.stages[stage] ?? 'enforce'
}

export function effectiveSeverity(violation, config) {
  const check = config.checks[adapterOfRule(violation.ruleId)]
  if (check?.level === 'warn') return 'warn'
  return violation.severity === 'warn' ? 'warn' : 'error'
}
