import { resolveBin, run, tail } from '../utils.js'

/**
 * 环境预检：只执行项目自己配置的命令（不内置任何判断）。
 *
 * 未配置 = 关闭。配置后失败意味着「后续验证都可能不可信」：
 * - task_start 失败：不创建任务（别带病上岗）；
 * - task_gate 失败：本次检查未执行，不产出可入账的证据（绝不假通过）。
 */
export async function runPreflight({ root, config }) {
  const command = String(config?.workflow?.preflight?.command ?? '').trim()
  if (!command) return { configured: false, ok: true, command: null }

  const timeoutMs = config.workflow.preflight.timeoutMs ?? 60000
  // 与 workflow.gate.testCommand 同约定：按空白拆成 bin + args，不做 shell 解释。
  const [bin, ...args] = command.split(/\s+/)
  const result = await run(resolveBin(root, bin), args, { cwd: root, timeoutMs })
  const ok = result.code === 0 && !result.timedOut && !result.missing

  return {
    configured: true,
    ok,
    command,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    missing: Boolean(result.missing),
    output: tail(`${result.stdout}${result.stderr}`, 6),
  }
}
