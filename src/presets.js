import { UserError } from './utils.js'

/**
 * init 的配置预设：只决定“基调”（开关取舍与阈值），不负责判断项目里到底有没有对应的工具。
 * 因此执行顺序固定为：默认配置 → 预设 → 探测降级。
 * 预设是人的意图，探测是项目的事实；事实只在“缺前置条件”时把检查关掉，从不推翻预设的阈值。
 */
export const INIT_PRESETS = {
  js: {
    summary: '纯 JavaScript：关闭 TypeScript 与组件清单（ui），其余沿用默认',
    checks: {
      typescript: { enabled: false },
      ui: { enabled: false },
    },
  },
  vue: {
    summary: 'Vue 项目：显式写出 vue-tsc 自动切换（默认值本就面向 Vue，其余沿用默认）',
    checks: {
      typescript: { vue: 'auto' },
    },
  },
  legacy: {
    summary: '老项目落地：放宽腐化指标与大 diff 阈值，存量交给 baseline 入账',
    checks: {
      metrics: {
        maxFileLines: 800,
        maxFunctionLines: 150,
        maxAny: 50,
        duplication: { maxRatio: 0.6 },
      },
      'diff-size': { maxFiles: 40, maxLines: 1200 },
    },
  },
  monorepo: {
    summary: 'monorepo：按 package 执行（默认即 auto），并放宽跨包 PR 的大 diff 阈值',
    checks: {
      eslint: { workspace: 'auto' },
      typescript: { workspace: 'auto' },
      'diff-size': { maxFiles: 40, maxLines: 1000 },
    },
  },
}

export const PRESET_NAMES = Object.keys(INIT_PRESETS)

/** 把预设补丁合并进配置（只合并普通对象，数组整体替换），并返回预设定义供 init 打印。 */
export function applyPreset(config, name) {
  const preset = INIT_PRESETS[name]
  if (!preset) {
    throw new UserError(`未知预设 "${name}"。可选：${PRESET_NAMES.join(' / ')}`)
  }
  merge(config.checks, preset.checks)
  return preset
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const nested = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (nested && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      merge(target[key], value)
    } else {
      target[key] = Array.isArray(value) ? [...value] : value
    }
  }
}
