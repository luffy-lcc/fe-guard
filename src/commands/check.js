import path from 'node:path'
import { loadConfig } from '../config.js'
import { runCheckCore } from '../check-core.js'
import { htmlReportPath, renderHtmlReport } from '../html.js'
import { printReport } from '../report.js'
import { buildSarif } from '../sarif.js'
import { run, toPosix, writeTextFile } from '../utils.js'

export async function checkCommand({ root, diffOnly, staged, json, all, configPath, profile, format }) {
  const mode = staged ? 'staged' : diffOnly ? 'diff-only' : 'full'
  const config = loadConfig(root, { configPath })
  const { report, reportFile, exitCode } = await runCheckCore({ root, mode, config, profile })

  // 机器可读输出时 stdout 只放那一份数据，方便 CI 直接管道给 jq / node / 上传动作。
  const output = format ?? (json ? 'json' : 'text')
  if (output === 'html') {
    const relative = htmlReportPath(config)
    writeTextFile(path.join(root, relative), renderHtmlReport(report))
    console.log(`HTML 报告: ${relative}`)
  } else if (output === 'sarif') {
    console.log(JSON.stringify(buildSarif(report, { pathPrefix: await gitPrefix(root) }), null, 2))
  } else if (output === 'json') {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report, {
      reportFile,
      baselineChanged: report.baseline.tightened.length > 0,
      baselineWritten: report.baseline.wroteBack,
      showKnown: Boolean(all),
    })
  }
  return exitCode
}

/**
 * SARIF 的 %SRCROOT% 按 git 仓库根解析；项目根是子目录时（前后端同仓），
 * 把子目录前缀拼进 uri，GitHub 才能把告警挂到正确的文件上。
 */
async function gitPrefix(root) {
  const result = await run('git', ['rev-parse', '--show-prefix'], { cwd: root })
  if (result.missing || result.code !== 0) return ''
  return toPosix(result.stdout.trim())
}
