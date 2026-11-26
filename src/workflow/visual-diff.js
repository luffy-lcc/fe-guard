import { resolveBin, run, tail } from '../utils.js'
import { isVisualCriterion } from './criteria.js'
import { writeEvidenceOutput } from './evidence.js'

/**
 * 视觉对比：只执行项目自己的命令，不启动浏览器、不安装依赖。
 *
 * 只有在存在 `verify: gate` + `evidenceKind: diff` 的条件时才需要执行；
 * 同一次门禁只跑一次，命令结果覆盖所有视觉条件。
 */
export async function runVisualDiff({ root, config, taskId, evidenceId, criteria = [], reportOk }) {
  const settings = config?.workflow?.visualDiff ?? {}
  const command = String(settings.command ?? '').trim()
  const needed = criteria.some(isVisualCriterion)

  if (!needed) {
    return {
      configured: Boolean(command),
      needed: false,
      ran: false,
      ok: true,
      reason: 'no-visual-criteria',
      command: command || null,
    }
  }
  if (!command) {
    return { configured: false, needed: true, ran: false, ok: false, reason: 'not-configured', command: null }
  }
  // 检查本身没通过时不再跑视觉命令：结果不可信，也避免无谓的外部调用。
  if (!reportOk) {
    return { configured: true, needed: true, ran: false, ok: false, reason: 'check-failed', command }
  }

  const timeoutMs = settings.timeoutMs ?? 120000
  const started = Date.now()
  const [bin, ...args] = command.split(/\s+/)
  const result = await run(resolveBin(root, bin), args, { cwd: root, timeoutMs })
  const ms = Date.now() - started
  const text = `${result.stdout}${result.stderr}`
  const artifact = writeEvidenceOutput({ root, taskId, evidenceId, text, suffix: 'visual' })
  const missing = Boolean(result.missing)
  const timedOut = Boolean(result.timedOut)
  const wrote = Boolean(artifact)
  const ok = result.code === 0 && !timedOut && !missing && wrote

  return {
    configured: true,
    needed: true,
    ran: true,
    ok,
    command,
    exitCode: result.code,
    timedOut,
    missing,
    ms,
    ...(artifact ? { file: artifact.file, bytes: artifact.bytes, sha256: artifact.sha256 } : {}),
    output: tail(text, 8),
    ...(ok
      ? {}
      : {
          reason: missing
            ? 'missing'
            : timedOut
              ? 'timeout'
              : !wrote
                ? 'evidence-write-failed'
                : 'failed',
        }),
  }
}
