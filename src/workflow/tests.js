import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBin, run, toPosix } from '../utils.js'

/**
 * 验收条件的语义绑定：模型只能给条件挂「测试文件路径」，
 * 执行命令来自 workflow.gate.testCommand（人类配置），不开放任意命令执行面。
 * 测试执行复用 utils.run（自带超时 / SIGTERM / 输出上限）。
 */

/** 校验 testFile：仓库内相对路径，禁绝对路径与 ..。返回归一化 posix 路径。 */
export function checkTestFile(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('testFile 必须是非空字符串（仓库内测试文件的相对路径）')
  }
  const file = toPosix(value.trim())
  if (path.isAbsolute(file) || file.split('/').includes('..')) {
    throw new Error(`testFile "${value}" 不合法：只允许仓库内的相对路径，禁止绝对路径与 ..`)
  }
  return file
}

/**
 * 真实执行条件挂的测试，只在门禁检查通过后调用。
 * 同一文件被多条条件引用时只跑一次，结果共享。
 * 返回 [{ criterionId, file, ok, exitCode, reason? }]。
 */
export async function runCriterionTests({ root, config, criteria }) {
  const targets = criteria.filter((criterion) => criterion.testFile)
  if (targets.length === 0) return []

  const [bin, ...args] = config.workflow.gate.testCommand.trim().split(/\s+/)
  const timeoutMs = config.workflow.gate.testTimeoutMs
  // 嵌套在 node --test 里跑门禁时，子测试进程会继承外层 runner 的上下文，
  // 结果改走 IPC、退出码恒 0。剥掉它，让条件测试作为独立 runner 真实退出。
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const results = new Map()

  for (const file of [...new Set(targets.map((criterion) => criterion.testFile))]) {
    if (!existsSync(path.join(root, file))) {
      results.set(file, { ok: false, exitCode: null, reason: 'missing' })
      continue
    }
    const result = await run(resolveBin(root, bin), [...args, file], { cwd: root, timeoutMs, env })
    const reason = result.timedOut ? 'timeout' : result.missing ? 'no-runner' : undefined
    results.set(file, { ok: result.code === 0 && !reason, exitCode: result.code, ...(reason ? { reason } : {}) })
  }

  return targets.map((criterion) => ({
    criterionId: criterion.id,
    file: criterion.testFile,
    ...results.get(criterion.testFile),
  }))
}

const REASONS = {
  missing: '测试文件不存在',
  timeout: '测试执行超时',
  'no-runner': '测试命令不可用（检查 workflow.gate.testCommand）',
}

/** 失败测试的 blockers：给模型可修复的方向，不回传整份日志。 */
export function testBlockers(tests) {
  return tests
    .filter((test) => !test.ok)
    .map((test) => {
      const detail = REASONS[test.reason] ?? `退出码 ${test.exitCode}`
      return `验收条件 ${test.criterionId} 的测试未通过：${test.file}（${detail}）`
    })
}
