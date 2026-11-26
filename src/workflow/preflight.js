import { resolveBin, run, tail } from '../utils.js'

/**
 * 环境预检：只执行项目自己配置的命令（不内置任何判断）。
 *
 * 两种写法：
 * - command：单条命令（旧配置，返回结构保持不变）；
 * - steps：命名多步检查，顺序执行、失败即停，错误里能指出具体步骤。
 *
 * 未配置 = 关闭。配置后失败意味着「后续验证都可能不可信」：
 * - task_start 失败：不创建任务（别带病上岗）；
 * - task_gate 失败：本次检查未执行，不产出可入账的证据（绝不假通过）。
 */
export async function runPreflight({ root, config }) {
  const settings = config?.workflow?.preflight ?? {}
  const steps = Array.isArray(settings.steps) ? settings.steps : []

  if (steps.length === 0) {
    const command = String(settings.command ?? '').trim()
    if (!command) return { configured: false, ok: true, command: null }
    return runCommand({ root, command, timeoutMs: settings.timeoutMs ?? 60000 })
  }

  const results = []
  for (const step of steps) {
    const result = await runCommand({
      root,
      command: step.command,
      timeoutMs: step.timeoutMs ?? settings.timeoutMs ?? 60000,
    })
    const item = {
      name: step.name,
      command: step.command,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      missing: result.missing,
      ms: result.ms,
      output: result.output,
    }
    results.push(item)
    if (!item.ok) return aggregateSteps(results, item)
  }
  return aggregateSteps(results, results.at(-1))
}

/** 单条命令的结果；旧 command 模式直接返回这个结构，保持兼容。 */
async function runCommand({ root, command, timeoutMs }) {
  const started = Date.now()
  // 与 workflow.gate.testCommand 同约定：按空白拆成 bin + args，不做 shell 解释。
  const [bin, ...args] = command.split(/\s+/)
  const result = await run(resolveBin(root, bin), args, { cwd: root, timeoutMs })
  return {
    configured: true,
    ok: result.code === 0 && !result.timedOut && !result.missing,
    command,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    missing: Boolean(result.missing),
    ms: Date.now() - started,
    output: tail(`${result.stdout}${result.stderr}`, 6),
  }
}

/** 多步模式的聚合结果：保留 failedStep，旧字段仍可取到失败步骤的退出码与输出。 */
function aggregateSteps(steps, failed) {
  return {
    configured: true,
    mode: 'steps',
    ok: steps.every((step) => step.ok),
    command: failed?.command ?? null,
    failedStep: failed && !failed.ok ? failed.name : null,
    steps,
    exitCode: failed?.exitCode ?? 0,
    timedOut: Boolean(failed?.timedOut),
    missing: Boolean(failed?.missing),
    ms: steps.reduce((total, step) => total + step.ms, 0),
    output: failed?.output ?? '',
  }
}
