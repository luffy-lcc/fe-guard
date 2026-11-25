import path from 'node:path'
import { UserError } from './utils.js'
import { initCommand } from './commands/init.js'
import { checkCommand } from './commands/check.js'
import { baselineCommand } from './commands/baseline.js'
import { falsePositiveCommand } from './commands/feedback.js'
import { doctorCommand } from './commands/doctor.js'
import { taskCommand } from './commands/task.js'
import { startMcpServer } from './mcp/server.js'
import { TOOL_VERSION } from './version.js'

const VERSION = TOOL_VERSION

const HELP = `fe-guard ${VERSION} — 把前端规范变成可执行检查（多工具归一化 + baseline 棘轮）

用法:
  fe-guard init [--preset <js|vue|legacy|monorepo>] [--dry-run] [--force] [--root <dir>]
      先探测项目（tsconfig / ESLint / depcruise / .vue / workspaces），再按结果生成配置、
      baseline、AGENTS.md 片段，以及 .trae / .cursor 的规则、命令与 MCP 配置
        --preset      预设基调：js = 纯 JS（关 tsc/ui）；vue = 显式 vue-tsc 自动切换；
                      legacy = 放宽指标与大 diff 阈值；monorepo = 按包执行 + 放宽大 diff
        --dry-run     只打印将要写入的文件与内容，不落盘
        --force       覆盖已存在的配置与 baseline（并重新探测）

  fe-guard check [--diff-only | --staged] [--full | --profile <fast|full>]
                 [--all] [--json | --format <text|json|sarif|html>] [--config <file>] [--root <dir>]
      运行当前档位的检查，与 baseline 对比
        --diff-only   只检查本次改动（工作区 + 暂存 + 未跟踪）涉及的源文件
        --staged      检查暂存区内容（提交前钩子用；内容类检查读暂存快照）
        --full        本次跑全档（等价于 --profile full）
        --profile     选择内置档位：fast = ESLint/依赖/组件/指标；full = 再加 tsc、边界、大 diff
        --all         连存量违规一起逐条展示（默认只展示新增，存量给一行摘要）
        --json        等价于 --format json
        --format      输出格式：text（默认）/ json / sarif / html；
                      sarif 只含新增违规与“检查未执行”，供 GitHub Code Scanning 上传；
                      html 写到 report.path 同目录的 .html 文件（单文件、零外链），stdout 只打印路径
        --config      指定配置文件；也可用环境变量 FE_GUARD_CONFIG

  fe-guard doctor [--profile <fast|full>] [--config <file>] [--json] [--root <dir>]
      一条命令查看：当前档位、每项检查覆盖到哪些 package、哪些被跳过、
      上次耗时、baseline 规模，以及哪些检查是“空的”

  fe-guard baseline [--widen | --show [--by-rule] | --verify [--base <ref>] | --trend [--limit <n>]]
                    [--all] [--json] [--config <file>] [--root <dir>]
      默认：把当前违规记录为 baseline（显式接受历史欠债）
        --widen       允许把已有条目的允许条数调大（默认拒绝）
        --follow-renames  先把重命名文件的账本条目迁移到新路径（需先 git add，留审计）
        --show        查看存量；--by-rule 按规则聚合，按可清理条数排序
        --verify      对比 merge-base，未在 widenLog 登记的放宽直接失败
        --base <ref>  --verify 的比较基线；默认读 GITHUB_BASE_REF / GITHUB_BASE_SHA 或本地 upstream
        --all         --show 时展开全部文件（默认最多 20 个）
        --trend       只读 baseline 的 git 历史，展示存量随时间的变化（不写任何文件）
        --limit <n>   --trend 显示的版本数（默认 20）

  fe-guard false-positive --file <文件> --rule <规则> --reason <原因> [--line <行>]
                          [--json] [--config <file>] [--root <dir>]
      把某条违规标记为误报（只追加记录，不吞掉检查结果）
        --summary     汇总被标为误报最多的规则与检查
        --list        列出全部误报记录（含时间与原因）
        --suggest     按“规则 + 命中次数 + 误报率”给出降级/关闭建议（仍需人工决定）

  fe-guard task [status|events|reset|confirm|defer|stats] [<条件 id>] [--json] [--summary]
                [--note <text>] [--reason <text>] [--yes] [--root <dir>]
      查看任务、验收条件与门禁证据；events 看事件流；reset 归档并清空任务
        --summary     events 时输出聚合摘要（事件构成 / 门禁 / 拒绝 / 条件 / 复盘 / 交付）
        confirm       人工确认推断项（source 以 assumption 开头的条件），必须带 --note 与 --yes
        defer         把条件明确放弃或转为上线待办，必须带 --reason 与 --yes
        stats         只读聚合当前任务与归档（交付/降级、门禁失败率、top blocker、复盘与待办），--json 输出对象

  fe-guard mcp [--root <dir>]
      以 MCP stdio server 方式启动（给 Trae / Cursor 等 IDE 挂载）

  fe-guard --version | --help

档位与配置:
  默认档位是 full，保证直接运行 check 与旧版本行为一致。
  git 钩子建议用 fast：npx fe-guard check --staged --profile fast
  --config / FE_GUARD_CONFIG 只影响配置读取，baseline 与报告路径仍按配置里的相对路径解析。

退出码:
  0  通过            1  存在新增违规 / 有检查未真正执行
  2  配置或环境错误（配置缺失、schema 不兼容、baseline 拒绝放宽等）

报告: 每次 check 都会写 <root>/.fe-guard/report.json
任务状态: <root>/.fe-guard/task.json（只追加事件，阶段由事件推导）
误报记录: <root>/.fe-guard/false-positives.jsonl（只追加，可审计）
`

const COMMANDS = {
  init: { flags: ['--force', '--dry-run', '--root', '-C'], values: ['--preset'], positionals: 0 },
  check: {
    flags: ['--diff-only', '--staged', '--json', '--all', '--full', '--root', '-C'],
    values: ['--profile', '--config', '--format'],
    positionals: 0,
  },
  doctor: { flags: ['--json', '--root', '-C'], values: ['--profile', '--config'], positionals: 0 },
  baseline: {
    flags: ['--widen', '--show', '--by-rule', '--verify', '--follow-renames', '--all', '--json', '--trend', '--root', '-C'],
    values: ['--base', '--config', '--limit'],
    positionals: 0,
  },
  'false-positive': {
    flags: ['--summary', '--list', '--suggest', '--json', '--root', '-C'],
    values: ['--file', '--rule', '--line', '--reason', '--config'],
    positionals: 0,
  },
  task: {
    flags: ['--yes', '--json', '--summary', '--root', '-C'],
    values: ['--note', '--reason'],
    positionals: 2,
  },
  mcp: { flags: ['--root', '-C'], positionals: 0 },
}

const ALIASES = { fp: 'false-positive' }

function parseArgs(argv) {
  let [command, ...rest] = argv
  command = ALIASES[command] ?? command
  if (!command || command === '--help' || command === '-h' || command === 'help') return { command: 'help' }
  if (command === '--version' || command === '-v') return { command: 'version' }
  if (!COMMANDS[command]) throw new UserError(`未知命令 "${command}"\n\n${HELP}`)

  const spec = COMMANDS[command]
  const valueFlags = new Set(['--root', '-C', ...(spec.values ?? [])])
  const flags = new Set()
  const values = {}
  const positionals = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--help' || arg === '-h') return { command: 'help' }
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1)
    if (!spec.flags.includes(name) && !valueFlags.has(name)) {
      throw new UserError(`命令 ${command} 不支持参数 "${arg}"\n\n${HELP}`)
    }
    if (valueFlags.has(name)) {
      const value = inlineValue ?? rest[(index += 1)]
      if (value === undefined) throw new UserError(`${name} 需要一个值`)
      values[name === '-C' ? 'root' : name.replace(/^--/, '')] = value
    } else {
      flags.add(name)
    }
  }
  if (positionals.length > spec.positionals) {
    throw new UserError(`命令 ${command} 不接受位置参数 "${positionals[0]}"\n\n${HELP}`)
  }
  return { command, flags, values, positionals }
}

export async function main(argv) {
  try {
    const parsed = parseArgs(argv)
    const code = await dispatch(parsed)
    process.exitCode = code
    return code
  } catch (error) {
    process.exitCode = 2
    if (error instanceof UserError) {
      console.error(`fe-guard: ${error.message}`)
    } else {
      console.error(`fe-guard: 未预期的错误\n${error.stack ?? error}`)
    }
    return 2
  }
}

async function dispatch({ command, flags, values, positionals }) {
  if (command === 'help') {
    console.log(HELP)
    return 0
  }
  if (command === 'version') {
    console.log(VERSION)
    return 0
  }

  const root = path.resolve(values.root ?? process.cwd())
  if (command === 'init') {
    return initCommand({
      root,
      force: flags.has('--force'),
      preset: values.preset,
      dryRun: flags.has('--dry-run'),
    })
  }
  if (command === 'check') return runCheck(flags, values, root)
  if (command === 'baseline') return runBaseline(flags, values, root)
  if (command === 'doctor') {
    return doctorCommand({
      root,
      configPath: values.config,
      profile: values.profile,
      json: flags.has('--json'),
    })
  }
  if (command === 'false-positive') {
    return falsePositiveCommand({
      root,
      file: values.file,
      rule: values.rule,
      line: values.line,
      reason: values.reason,
      summary: flags.has('--summary'),
      list: flags.has('--list'),
      suggest: flags.has('--suggest'),
      json: flags.has('--json'),
      configPath: values.config,
    })
  }
  if (command === 'task') {
    return taskCommand({
      root,
      action: positionals[0] ?? 'status',
      criterionId: positionals[1],
      yes: flags.has('--yes'),
      json: flags.has('--json'),
      summary: flags.has('--summary'),
      note: values.note,
      reason: values.reason,
    })
  }
  if (command === 'mcp') {
    await startMcpServer({ root })
    return 0
  }
  return 0
}

async function runCheck(flags, values, root) {
  if (flags.has('--diff-only') && flags.has('--staged')) {
    throw new UserError('--diff-only 和 --staged 不能同时使用')
  }
  const format = values.format
  if (format && !['text', 'json', 'sarif', 'html'].includes(format)) {
    throw new UserError(`--format 只支持 text / json / sarif / html，收到 "${format}"`)
  }
  if (format && flags.has('--json') && format !== 'json') {
    throw new UserError('--json 等价于 --format json，不能与其它 --format 值同时使用')
  }
  return checkCommand({
    root,
    diffOnly: flags.has('--diff-only'),
    staged: flags.has('--staged'),
    json: flags.has('--json'),
    all: flags.has('--all'),
    configPath: values.config,
    profile: flags.has('--full') ? 'full' : values.profile,
    format,
  })
}

async function runBaseline(flags, values, root) {
  if (values.limit !== undefined) {
    const limit = Number(values.limit)
    if (!Number.isInteger(limit) || limit < 1) throw new UserError('--limit 需要正整数')
  }
  if (flags.has('--trend')) {
    const exclusive = ['--widen', '--show', '--by-rule', '--verify', '--follow-renames', '--all']
    if (values.base !== undefined || exclusive.some((flag) => flags.has(flag))) {
      throw new UserError('--trend 只读 baseline 历史，不能与 --widen / --show / --verify / --follow-renames / --all / --base 同时使用')
    }
  } else if (values.limit !== undefined) {
    throw new UserError('--limit 只用于 baseline --trend')
  }
  return baselineCommand({
    root,
    widen: flags.has('--widen'),
    show: flags.has('--show'),
    verify: flags.has('--verify'),
    all: flags.has('--all'),
    json: flags.has('--json'),
    base: values.base,
    byRule: flags.has('--by-rule'),
    followRenames: flags.has('--follow-renames'),
    configPath: values.config,
    trend: flags.has('--trend'),
    limit: values.limit === undefined ? undefined : Number(values.limit),
  })
}
