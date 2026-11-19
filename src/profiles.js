/**
 * 内置档位：定义“跑哪些检查”，不依赖配置文件里的 enabled。
 *
 * 为什么不在配置里维护两份 enabled：两档会随使用漂移，改一处忘一处，
 * 最后没人说得清“钩子到底跑了什么”。档位是代码里的常量，可审计、可测试。
 */

export const PROFILES = {
  fast: {
    checks: ['eslint', 'deps', 'ui', 'metrics'],
    description: '提交前/会话内用：不跑 tsc、vue-tsc、架构边界、大 diff，目标 3 秒内完成',
  },
  full: {
    checks: ['eslint', 'typescript', 'boundaries', 'deps', 'ui', 'metrics', 'diff-size'],
    description: '全量核对用：包含类型检查、架构边界与大 diff',
  },
}

export const DEFAULT_PROFILE = 'full'
export const PROFILE_NAMES = Object.keys(PROFILES)

export function isProfileName(name) {
  return PROFILE_NAMES.includes(name)
}
