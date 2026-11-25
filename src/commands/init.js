import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { CONFIG_FILE } from '../config.js'
import { configForProject } from '../detect.js'
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
import { MCP_CLIENTS, planManagedFile, planMcpConfig, replaceMarkedBlock } from '../ide/artifacts.js'
import { AGENTS_TOKEN_LIMIT, estimateTokens } from '../ide/tokens.js'
import { UserError, writeTextFile } from '../utils.js'
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

const MCP_CLIENT_LABELS = 'Trae / Cursor / Claude Code / VS Code / Gemini CLI'

const FIRST_RUN_NOTES = [
  '',
  '第一次接入会看到什么：',
  '  - init 只写配置和空账本，不改你的代码；此时 check 会把全部存量问题都算作“新增”，',
  '    老项目可能有几百上千条，这是正常的，不代表项目刚被改坏。',
  '  - 跑一次 baseline 入账后，check 默认只逐条展示新增；存量收敛成一行摘要。',
  '  - 想看存量明细：npx fe-guard baseline --show（按文件分组，含首次入账日期）。',
  '  - 觉得某条被冤枉：npx fe-guard false-positive --file <文件> --rule <规则> --reason "原因"。',
  '  - 接了 AI 流程后：npx fe-guard task stats 只读查看交付/降级、门禁失败率与复盘数量；',
  '    推断项由人执行 npx fe-guard task confirm <id> --note "..." --yes，AI 不能自己批准。',
  '',
  '下一步:',
  '  1. 把存量违规记进 baseline（第一次运行后，检查才会从「全红」变成「只看新增」）:',
  '       npx fe-guard baseline',
  '  2. 跑一次检查:',
  '       npx fe-guard check',
  '  3. 在你使用的 IDE / CLI 里重载 MCP（已写入项目级配置），',
  '     然后对 AI 说「按 fe-guard 流程开始」即可看到 task_start / task_criteria / ... 工具。',
  '  4. 想退回 v1 纯检查模式：把 fe-guard.config.json 里 workflow.enabled 设为 false。',
]

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`

export async function initCommand({ root, force, preset, dryRun }) {
  const state = collectPlans({ root, force, preset, dryRun })
  console.log(renderOutput(state).join('\n'))
  return 0
}

/**
 * 所有产物先算成 plan，再由 commit 决定是打印还是落盘：--dry-run 只是不 commit。
 * 顺序约定：默认配置 → 预设（定基调）→ 探测（只做缺前置条件的降级）。
 */
function collectPlans({ root, force, preset, dryRun }) {
  const state = { dryRun, preset, created: [], updated: [], unchanged: [], skipped: [], previews: [] }
  const commit = (plan) => {
    const bucket = plan.status === 'created' ? state.created : plan.status === 'updated' ? state.updated : state.unchanged
    bucket.push(plan.file)
    if (plan.status !== 'unchanged') state.previews.push(plan)
    if (!dryRun && plan.status !== 'unchanged') writeTextFile(path.join(root, plan.file), plan.content)
  }

  const configFile = path.join(root, CONFIG_FILE)
  state.configFile = configFile
  state.configKept = existsSync(configFile) && !force
  if (state.configKept) {
    state.skipped.push(CONFIG_FILE)
  } else {
    const detected = configForProject(root, { preset })
    state.detectionNotes = detected.notes
    commit({ file: CONFIG_FILE, status: existsSync(configFile) ? 'updated' : 'created', content: jsonText(detected.config) })
  }

  const baselineFile = path.join(root, BASELINE_FILE)
  if (existsSync(baselineFile) && !force) {
    state.skipped.push(BASELINE_FILE)
  } else {
    commit({
      file: BASELINE_FILE,
      status: existsSync(baselineFile) ? 'updated' : 'created',
      content: jsonText(emptyBaseline()),
    })
  }

  state.tokens = planAgents(root, commit)
  for (const [file, render] of IDE_FILES) commit(planManagedFile(root, file, render()))
  for (const client of MCP_CLIENTS) commit(planMcpConfig(root, client))
  return state
}

/** AGENTS.md 是唯一需要写进"用户自己的文件"的产物：只替换 marker 之间的受管片段。 */
function planAgents(root, commit) {
  const block = agentsBlock()
  const tokens = estimateTokens(block)
  if (tokens > AGENTS_TOKEN_LIMIT) {
    throw new UserError(
      `AGENTS.md 片段约 ${tokens} token，超过 ${AGENTS_TOKEN_LIMIT} 的上限；请精简 src/ide/source.js 里的措辞。`,
    )
  }
  const file = path.join(root, AGENTS_FILE)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  commit(planManagedFile(root, AGENTS_FILE, replaceMarkedBlock(existing, AGENTS_BEGIN, AGENTS_END, block)))
  return tokens
}

function renderOutput(state) {
  const { created, updated, unchanged, skipped, previews, detectionNotes = [], tokens, configKept, preset, dryRun } = state
  const lines = [dryRun ? 'fe-guard init 预览（--dry-run，不写入任何文件）' : 'fe-guard init 完成']
  if (detectionNotes.length > 0) {
    lines.push('探测结果:', ...detectionNotes.map((note) => `  ${note}`), '')
  }
  const section = (label, items) => {
    if (items.length > 0) lines.push(`${label}:\n${items.map((item) => `  ${item}`).join('\n')}`)
  }
  section(dryRun ? '将写入' : '已生成', created)
  section(dryRun ? '将更新' : '已更新', updated)
  section('已是最新', unchanged)
  section('已存在，跳过', skipped)
  lines.push('', `AGENTS.md 受管片段约 ${tokens} token（上限 ${AGENTS_TOKEN_LIMIT}）`)
  lines.push(`MCP 客户端: ${MCP_CLIENT_LABELS}（只写项目级配置，不碰用户 home）`)

  if (configKept && preset) {
    lines.push(`提示: 配置已存在，--preset ${preset} 没有应用；要按预设重写配置请加 --force。`)
  }
  if (configKept && !hasWorkflowBlock(state.configFile)) {
    lines.push('提示: 已有配置里没有 workflow 段，流程层默认开启；要关掉请加 "workflow": { "enabled": false }。')
  }
  return dryRun ? withPreview(lines, previews) : forFirstRun(lines)
}

function withPreview(lines, previews) {
  if (previews.length > 0) {
    lines.push('', '内容预览:')
    for (const plan of previews) {
      lines.push(`--- ${plan.file} (${plan.status}) ---\n${plan.content.replace(/\s*$/, '')}\n--- end ---`)
    }
  }
  return lines.concat('', '这是预览：去掉 --dry-run 才会写入文件。')
}

function forFirstRun(lines) {
  return lines.concat(FIRST_RUN_NOTES)
}

/** 老项目（v1 配置）没有 workflow 段时给一条提示，不擅自改用户配置。 */
function hasWorkflowBlock(configFile) {
  try {
    return Boolean(JSON.parse(readFileSync(configFile, 'utf8')).workflow)
  } catch {
    return true
  }
}
