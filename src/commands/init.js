import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { CONFIG_FILE, defaultConfig } from '../config.js'
import {
  AGENTS_BEGIN,
  AGENTS_END,
  agentsBlock,
  cursorRule,
  hooksExample,
  traeCommandGate,
  traeCommandNext,
  traeRule,
} from '../ide/source.js'
import { mergeMcpConfig, replaceMarkedBlock, writeManagedFile } from '../ide/artifacts.js'
import { AGENTS_TOKEN_LIMIT, estimateTokens } from '../ide/tokens.js'
import { UserError, writeJsonFile } from '../utils.js'
import { emptyBaseline } from '../baseline.js'

const BASELINE_FILE = 'fe-guard.baseline.json'
const AGENTS_FILE = 'AGENTS.md'

/** 由同一份源渲染出的 IDE 接入产物：重复执行 init 只会更新变了的部分。 */
const IDE_FILES = [
  ['.trae/rules/fe-guard.md', traeRule],
  ['.trae/commands/fe-guard-next.md', traeCommandNext],
  ['.trae/commands/fe-guard-gate.md', traeCommandGate],
  ['.cursor/rules/fe-guard.mdc', cursorRule],
  ['.trae/hooks.example.json', () => hooksExample('trae')],
  ['.cursor/hooks.example.json', () => hooksExample('cursor')],
]

const MCP_FILES = ['.trae/mcp.json', '.cursor/mcp.json']

export async function initCommand({ root, force }) {
  const created = []
  const updated = []
  const unchanged = []
  const skipped = []
  const record = (result) => {
    const bucket = result.status === 'created' ? created : result.status === 'updated' ? updated : unchanged
    bucket.push(result.file)
  }

  const configFile = path.join(root, CONFIG_FILE)
  let configKept = false
  if (existsSync(configFile) && !force) {
    skipped.push(CONFIG_FILE)
    configKept = true
  } else {
    writeJsonFile(configFile, defaultConfig())
    created.push(CONFIG_FILE)
  }

  const baselineFile = path.join(root, BASELINE_FILE)
  if (existsSync(baselineFile) && !force) {
    skipped.push(BASELINE_FILE)
  } else {
    writeJsonFile(baselineFile, emptyBaseline())
    created.push(BASELINE_FILE)
  }

  // AGENTS.md 是唯一需要写进"用户自己的文件"的产物：只替换 marker 之间的受管片段。
  const block = agentsBlock()
  const tokens = estimateTokens(block)
  if (tokens > AGENTS_TOKEN_LIMIT) {
    throw new UserError(
      `AGENTS.md 片段约 ${tokens} token，超过 ${AGENTS_TOKEN_LIMIT} 的上限；请精简 src/ide/source.js 里的措辞。`,
    )
  }
  const agentsFile = path.join(root, AGENTS_FILE)
  const existing = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : ''
  record(writeManagedFile(root, AGENTS_FILE, replaceMarkedBlock(existing, AGENTS_BEGIN, AGENTS_END, block)))

  for (const [file, render] of IDE_FILES) record(writeManagedFile(root, file, render()))
  for (const file of MCP_FILES) record(mergeMcpConfig(root, file))

  const lines = ['fe-guard init 完成']
  const section = (label, items) => {
    if (items.length > 0) lines.push(`${label}:\n${items.map((item) => `  ${item}`).join('\n')}`)
  }
  section('已生成', created)
  section('已更新', updated)
  section('已是最新', unchanged)
  section('已存在，跳过', skipped)
  lines.push(
    '',
    `AGENTS.md 受管片段约 ${tokens} token（上限 ${AGENTS_TOKEN_LIMIT}）`,
  )
  if (configKept && !hasWorkflowBlock(configFile)) {
    lines.push('提示: 已有配置里没有 workflow 段，流程层默认开启；要关掉请加 "workflow": { "enabled": false }。')
  }
  lines.push(
    '',
    '第一次接入会看到什么：',
    '  - init 只写配置和空账本，不改你的代码；此时 check 会把全部存量问题都算作“新增”，',
    '    老项目可能有几百上千条，这是正常的，不代表项目刚被改坏。',
    '  - 跑一次 baseline 入账后，check 默认只逐条展示新增；存量收敛成一行摘要。',
    '  - 想看存量明细：npx fe-guard baseline --show（按文件分组，含首次入账日期）。',
    '  - 觉得某条被冤枉：npx fe-guard false-positive --file <文件> --rule <规则> --reason "原因"。',
    '',
    '下一步:',
    '  1. 把存量违规记进 baseline（第一次运行后，检查才会从「全红」变成「只看新增」）:',
    '       npx fe-guard baseline',
    '  2. 跑一次检查:',
    '       npx fe-guard check',
    '  3. 在 Trae / Cursor 里重载 MCP（已写入 .trae/mcp.json 与 .cursor/mcp.json），',
    '     然后对 AI 说「按 fe-guard 流程开始」即可看到 task_start / task_criteria / ... 工具。',
    '  4. 想退回 v1 纯检查模式：把 fe-guard.config.json 里 workflow.enabled 设为 false。',
  )
  console.log(lines.join('\n'))
  return 0
}

/** 老项目（v1 配置）没有 workflow 段时给一条提示，不擅自改用户配置。 */
function hasWorkflowBlock(configFile) {
  try {
    return Boolean(JSON.parse(readFileSync(configFile, 'utf8')).workflow)
  } catch {
    return true
  }
}
