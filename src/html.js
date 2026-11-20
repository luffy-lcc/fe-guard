import { CHECK_LABELS } from './runners/index.js'
import { isNotExecutedRule } from './not-executed.js'
import { TOOL_VERSION } from './version.js'

/**
 * 单文件 HTML 报告：内联 CSS + 少量渐进增强脚本，零外部资源。
 * 列出全部违规（新增 + 存量 + 未执行），禁用 JS 时表格仍然完整可读。
 */

/** HTML 与 report.json 放在同一目录：`.fe-guard/report.json` -> `.fe-guard/report.html`。 */
export function htmlReportPath(config) {
  const configured = config.report?.path ?? '.fe-guard/report.json'
  return /\.json$/i.test(configured) ? configured.replace(/\.json$/i, '.html') : `${configured}.html`
}

export function renderHtmlReport(report, { version = TOOL_VERSION } = {}) {
  const title = `fe-guard 报告 · ${report.mode}`
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    header(report),
    summaryCards(report),
    checksSection(report),
    violationsSection(report),
    baselineSection(report),
    timingsSection(report),
    `<footer>fe-guard ${esc(version)} · 报告生成于 ${esc(report.generatedAt)}</footer>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function header(report) {
  const meta = [
    `mode=${report.mode}`,
    report.profile?.name ? `profile=${report.profile.name}` : '',
    report.workspace?.isWorkspace ? `workspace=${report.workspace.source}（${report.workspace.packages.length} 个 package）` : '',
    report.staged ? '--staged' : '',
    report.scope ? `scope=${report.scope.length} 个变更文件` : '',
  ].filter(Boolean)
  const verdict = report.skipped
    ? { cls: 'ok', text: `已跳过（退出码 0）${report.note ? ` — ${report.note}` : ''}` }
    : report.ok
      ? { cls: 'ok', text: '通过（退出码 0）' }
      : { cls: 'bad', text: `失败（退出码 ${report.exitCode}）` }
  return `<header>
  <h1>fe-guard 报告</h1>
  <p class="verdict ${verdict.cls}">${esc(verdict.text)}</p>
  <p class="meta">${esc(meta.join(' · '))}</p>
</header>`
}

function summaryCards(report) {
  const cards = [
    ['存量违规', report.summary.known, ''],
    ['新增违规', report.summary.new, report.summary.new > 0 ? 'bad' : 'ok'],
    ['新增 error', report.summary.newErrors, report.summary.newErrors > 0 ? 'bad' : 'ok'],
    ['新增 warn', report.summary.newWarnings, ''],
    ['baseline 收紧', report.summary.tightened, ''],
    ['baseline 移除', report.summary.removed, ''],
  ]
  return `<section class="cards">${cards
    .map(([label, value, cls]) => `<div class="card ${cls}"><span class="num">${value}</span><span class="label">${esc(label)}</span></div>`)
    .join('')}</section>`
}

function checksSection(report) {
  const statusText = {
    ran: '已执行',
    unavailable: '未真正执行（不可入账）',
    skipped: '跳过（跳过 ≠ 通过）',
  }
  const rows = report.checks
    .map(
      (check) =>
        `<tr class="${check.status === 'unavailable' ? 'bad' : check.status === 'skipped' ? 'muted' : ''}">` +
        `<td>${esc(check.label ?? check.id)}</td><td><code>${esc(check.id)}</code></td>` +
        `<td>${esc(check.level)}</td><td>${esc(statusText[check.status] ?? check.status)}</td></tr>`,
    )
    .join('')
  return `<section>
  <h2>检查项</h2>
  <table><thead><tr><th>检查</th><th>ID</th><th>级别</th><th>状态</th></tr></thead><tbody>${rows || emptyRow(4)}</tbody></table>
</section>`
}

function violationsSection(report) {
  const violations = [...report.violations].sort(compareViolations)
  const rows = violations.map(violationRow).join('')
  return `<section>
  <h2>违规 <span class="count" id="count">（共 ${violations.length} 条）</span></h2>
  <div class="filters" role="group" aria-label="筛选">
    <button type="button" data-filter="all" class="active">全部</button>
    <button type="button" data-filter="new">新增</button>
    <button type="button" data-filter="known">存量</button>
    <button type="button" data-filter="not-executed">未执行</button>
    <input id="q" type="search" placeholder="搜索文件 / 规则 / 说明" aria-label="搜索违规">
  </div>
  <table id="violations">
    <thead><tr><th>状态</th><th>级别</th><th>位置</th><th>规则</th><th>说明</th><th>修复建议</th></tr></thead>
    <tbody>${rows || emptyRow(6, '没有违规')}</tbody>
  </table>
</section>`
}

function violationRow(violation) {
  const kind = isNotExecutedRule(violation.ruleId) ? 'not-executed' : violation.status
  const kindText = { new: '新增', known: '存量', 'not-executed': '未执行' }[kind] ?? kind
  const location = violation.line ? `${violation.file}:${violation.line}` : violation.file
  return (
    `<tr data-kind="${esc(kind)}" data-sev="${esc(violation.severity)}" class="row-${esc(kind)}">` +
    `<td><span class="tag ${esc(kind)}">${esc(kindText)}</span></td>` +
    `<td>${esc(violation.severity)}</td>` +
    `<td><code>${esc(location)}</code></td>` +
    `<td><code>${esc(violation.ruleId)}</code></td>` +
    `<td>${esc(violation.message)}</td>` +
    `<td>${esc(violation.fix ?? '')}</td></tr>`
  )
}

function baselineSection(report) {
  const { tightened, removed, wroteBack, path } = report.baseline
  const parts = []
  if (tightened.length > 0) {
    parts.push(
      `<p>${wroteBack ? 'baseline 已自动收紧' : 'baseline 可收紧（autoTighten=false，未写回）'}：</p>` +
        `<table><thead><tr><th>文件</th><th>规则</th><th>变化</th></tr></thead><tbody>${tightened
          .map(
            (item) =>
              `<tr><td><code>${esc(item.file)}</code></td><td><code>${esc(item.ruleId)}</code></td>` +
              `<td>${esc(`${item.from} -> ${item.to}`)}</td></tr>`,
          )
          .join('')}</tbody></table>`,
    )
  }
  if (removed.length > 0) {
    parts.push(
      `<p>baseline 移除 ${removed.length} 项：</p><ul>${removed
        .map((item) => `<li><code>${esc(item.file)}</code> <code>${esc(item.ruleId)}</code></li>`)
        .join('')}</ul>`,
    )
  }
  const empty = Object.keys(report.baseline.current ?? {}).length === 0 && Object.keys(report.baseline.ratchets ?? {}).length === 0
  if (empty && (report.summary.new > 0 || report.summary.known > 0)) {
    parts.push('<p class="muted">第一次接入：上面这些都是存量问题，不是这次改坏的。下一步运行 <code>npx fe-guard baseline</code>，之后默认只展示新增。</p>')
  }
  if (parts.length === 0) return ''
  return `<section>
  <h2>baseline</h2>
  <p class="meta">账本：<code>${esc(path)}</code></p>
  ${parts.join('\n  ')}
</section>`
}

function timingsSection(report) {
  const entries = Object.entries(report.timings?.checks ?? {}).sort((a, b) => b[1].ms - a[1].ms)
  const skipped = (report.timings?.packages ?? []).filter((pkg) => pkg.status === 'skipped')
  if (entries.length === 0 && skipped.length === 0) return ''
  const rows = entries
    .map(
      ([id, item]) =>
        `<tr><td>${esc(CHECK_LABELS[id] ?? id)}</td><td><code>${esc(id)}</code></td>` +
        `<td>${esc(item.status === 'failed' ? '失败' : formatMs(item.ms))}</td></tr>`,
    )
    .join('')
  const skippedLine =
    skipped.length > 0
      ? `<p class="muted">已跳过 ${skipped.length} 个没有对应配置的 package：${esc(
          skipped.map((pkg) => pkg.dir || pkg.package).slice(0, 10).join('、'),
        )}${skipped.length > 10 ? ' 等' : ''}</p>`
      : ''
  return `<section>
  <h2>耗时</h2>
  <table><thead><tr><th>检查</th><th>ID</th><th>耗时</th></tr></thead><tbody>${rows || emptyRow(3)}</tbody></table>
  ${skippedLine}
</section>`
}

function emptyRow(span, text = '无') {
  return `<tr><td colspan="${span}" class="muted">${esc(text)}</td></tr>`
}

function compareViolations(a, b) {
  const rank = (violation) => (isNotExecutedRule(violation.ruleId) ? 0 : violation.status === 'new' ? 1 : 2)
  const byKind = rank(a) - rank(b)
  if (byKind !== 0) return byKind
  if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
  const byFile = String(a.file).localeCompare(String(b.file))
  return byFile !== 0 ? byFile : (a.line ?? 0) - (b.line ?? 0)
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#58a6ff;--ok:#3fb950;--bad:#f85149}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 6px}h2{font-size:16px;margin:0 0 10px}
header{margin-bottom:18px}
.meta{color:var(--muted);margin:4px 0;word-break:break-all}
.verdict{display:inline-block;font-weight:600;margin:0 0 4px}
.verdict.ok{color:var(--ok)}.verdict.bad{color:var(--bad)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;background:none;border:0;padding:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .num{display:block;font-size:24px;font-weight:700}
.card .label{color:var(--muted);font-size:12px}
.card.bad .num{color:var(--bad)}.card.ok .num{color:var(--ok)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:0}
code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
tr.bad td{color:var(--bad)}
.muted,.muted td{color:var(--muted)}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.tag.new{color:var(--bad);border-color:var(--bad)}
.tag.known{color:var(--muted)}
.tag.not-executed{color:#b45309;border-color:#b45309}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filters button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:4px 12px;cursor:pointer;font:inherit}
.filters button.active{border-color:var(--accent);color:var(--accent)}
.filters input{flex:1;min-width:180px;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:5px 10px;font:inherit}
.count{color:var(--muted);font-size:13px;font-weight:400}
footer{color:var(--muted);font-size:12px;text-align:center;padding:8px 0 16px}
[hidden]{display:none!important}
`

const SCRIPT = `
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#violations tbody tr[data-kind]'))
  var count = document.getElementById('count')
  var search = document.getElementById('q')
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filters button'))
  if (!count || !search || rows.length === 0) return
  var kind = 'all'
  function apply() {
    var query = search.value.trim().toLowerCase()
    var shown = 0
    rows.forEach(function (row) {
      var matchesKind = kind === 'all' || row.dataset.kind === kind
      var matchesText = !query || row.textContent.toLowerCase().indexOf(query) !== -1
      row.hidden = !(matchesKind && matchesText)
      if (matchesKind && matchesText) shown += 1
    })
    count.textContent = '（显示 ' + shown + ' / ' + rows.length + ' 条）'
  }
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      kind = button.dataset.filter
      buttons.forEach(function (other) { other.classList.toggle('active', other === button) })
      apply()
    })
  })
  search.addEventListener('input', apply)
  apply()
})()
`
