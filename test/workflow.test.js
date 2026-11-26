import assert from 'node:assert/strict'
import test from 'node:test'
import { coverage, deriveStage, reduce } from '../src/workflow/state.js'
import { normalizeConfig, stageLevel } from '../src/config.js'
import { listTools } from '../src/workflow/tools.js'
import { estimateTokens, AGENTS_TOKEN_LIMIT } from '../src/ide/tokens.js'
import { AGENTS_BEGIN, AGENTS_END, agentsBlock } from '../src/ide/source.js'

const at = (index) => `2026-01-01T00:00:0${index}.000Z`

/** 构造一段事件流，seq 与 appendEvent 的语义一致。 */
function events(list) {
  return list.map((item, index) => ({ seq: index + 1, at: at(index), ...item }))
}

const base = [
  { type: 'task.started', taskId: 'T-1', title: 't', goal: 'g' },
  { type: 'criteria.declared', criteria: [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }] },
]

function gateEvent(seq, ok) {
  return { seq, at: at(seq), type: 'gate.recorded', evidence: { id: `E${seq}`, ok, exitCode: ok ? 0 : 1, summary: { known: 0, new: ok ? 0 : 1, newErrors: ok ? 0 : 1 } } }
}

test('阶段完全由事件推导：合同 → 计划 → 实现 → 验证 → 交付', () => {
  assert.equal(deriveStage(reduce([])), 'none')

  const contract = reduce(events([base[0]]))
  assert.equal(contract.stage, 'contract')

  const plan = reduce(events([...base]))
  assert.equal(plan.stage, 'plan')

  const implement = reduce(events([...base, { type: 'plan.written', steps: ['s1'] }]))
  assert.equal(implement.stage, 'implement')

  const verify = reduce(events([...base, { type: 'plan.written', steps: ['s1'] }, gateEvent(4, true)]))
  assert.equal(verify.stage, 'verify')

  const delivered = reduce(
    events([...base, { type: 'plan.written', steps: ['s1'] }, gateEvent(4, true), { type: 'task.delivered' }]),
  )
  assert.equal(delivered.stage, 'deliver')
  assert.equal(delivered.delivered.degraded, false)
})

test('验收条件只被「条件之后」的门禁证据覆盖', () => {
  const beforeCriteria = reduce(events([gateEvent(1, true), ...base]))
  // 证据在条件之前：不算覆盖
  assert.equal(coverage(beforeCriteria, 'enforce').filter((item) => item.evidence).length, 0)

  const afterCriteria = reduce(events([...base, gateEvent(3, true)]))
  const covered = coverage(afterCriteria, 'enforce')
  assert.equal(covered.filter((item) => item.evidence).length, 2)

  // enforce：只有成功的证据才算
  const failed = reduce(events([...base, gateEvent(3, false)]))
  assert.equal(coverage(failed, 'enforce').filter((item) => item.evidence).length, 0)
  // warn/off：允许失败证据覆盖（降级）
  assert.equal(coverage(failed, 'warn').filter((item) => item.evidence).length, 2)
})

test('事件流可回放：同样的输入得到同样的状态', () => {
  const stream = events([...base, { type: 'plan.written', steps: ['s1', 's2'] }, gateEvent(4, true), { type: 'task.delivered' }])
  const first = reduce(stream)
  const second = reduce(JSON.parse(JSON.stringify(stream)))
  assert.deepEqual(first, second)
})

test('workflow 配置：默认全开，一行可关掉整个流程层', () => {
  const enabled = normalizeConfig({})
  assert.equal(enabled.workflow.enabled, true)
  assert.equal(enabled.workflow.gate.mode, 'full')
  assert.equal(stageLevel(enabled, 'contract'), 'enforce')

  const disabled = normalizeConfig({ workflow: { enabled: false } })
  assert.equal(disabled.workflow.enabled, false)
  assert.deepEqual(
    listTools(disabled).map((tool) => tool.name),
    ['task_gate'],
  )
  assert.equal(listTools(enabled).length, 8)
})

test('workflow 配置：非法取值报错，阶段可单独降级', () => {
  assert.throws(() => normalizeConfig({ workflow: { stages: { contract: 'sometimes' } } }), /workflow\.stages\.contract/)
  assert.throws(() => normalizeConfig({ workflow: { gate: { mode: 'fast' } } }), /workflow\.gate\.mode/)

  const degraded = normalizeConfig({ workflow: { stages: { verify: 'warn' } } })
  assert.equal(stageLevel(degraded, 'verify'), 'warn')
  assert.equal(stageLevel(degraded, 'contract'), 'enforce')
})

test('工具集：数量 ≤ 8（v3 新增 ui_lookup），描述短，schema 拒绝自报状态', () => {
  const tools = listTools(normalizeConfig({}))
  assert.ok(tools.length <= 8)
  assert.ok(tools.some((tool) => tool.name === 'ui_lookup'))
  for (const tool of tools) {
    assert.ok(tool.description.length <= 90, `${tool.name} 描述过长`)
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} 应拒绝未知字段`)
  }
  // 验收条件的 schema 只允许合同字段：模型不能传 achieved
  const criteria = tools.find((tool) => tool.name === 'task_criteria')
  assert.deepEqual(Object.keys(criteria.inputSchema.properties.criteria.items.properties).sort(), [
    'evidenceFile',
    'evidenceKind',
    'id',
    'source',
    'testFile',
    'text',
    'type',
    'verify',
  ])
  assert.deepEqual(criteria.inputSchema.properties.criteria.items.required, ['text', 'type', 'source'])
})

test('AGENTS.md 片段：受管 marker 成对出现且不超过 token 上限', () => {
  const block = agentsBlock()
  assert.ok(block.startsWith(AGENTS_BEGIN))
  assert.ok(block.endsWith(AGENTS_END))
  assert.equal(block.split(AGENTS_BEGIN).length - 1, 1)
  assert.ok(estimateTokens(block) <= AGENTS_TOKEN_LIMIT, `实际 ${estimateTokens(block)}`)
})

test('token 估算：中文按字、英文按 4 字符折算', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcdefgh'), 2)
})
