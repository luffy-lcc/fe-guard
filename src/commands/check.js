import { loadConfig } from '../config.js'
import { runCheckCore } from '../check-core.js'
import { printReport } from '../report.js'

export async function checkCommand({ root, diffOnly, staged, json, all, configPath, profile }) {
  const mode = staged ? 'staged' : diffOnly ? 'diff-only' : 'full'
  const config = loadConfig(root, { configPath })
  const { report, reportFile, exitCode } = await runCheckCore({ root, mode, config, profile })

  // --json 时 stdout 只输出 JSON，方便 CI 里直接管道给 jq / node 解析。
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    printReport(report, {
      reportFile,
      baselineChanged: report.baseline.tightened.length > 0,
      baselineWritten: report.baseline.wroteBack,
      showKnown: Boolean(all),
    })
  }
  return exitCode
}
