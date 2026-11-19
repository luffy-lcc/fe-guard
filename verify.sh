#!/usr/bin/env bash
# fe-guard 一键验证：真实执行 CLI，断言退出码、报告内容和 baseline 变化。
# 用法: bash verify.sh    （或 npm run verify）
# 退出码: 0 = 全部验证通过，1 = 有失败项
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/bin/fe-guard.js"
SAMPLE="$ROOT/examples/sample-app"
WORK="$ROOT/.verify-tmp"
APP="$WORK/app"
REPORT="$APP/.fe-guard/report.json"
BASELINE="$APP/fe-guard.baseline.json"

PASS=0
FAIL=0
LAST_OUT=""

ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
step() { printf '\n== %s ==\n' "$1"; }
show() { if [ -n "$LAST_OUT" ]; then printf '%s\n' "$LAST_OUT" | sed 's/^/        /'; fi; }

# expect_exit <期望退出码> <说明> <命令...>
expect_exit() {
  local expected="$1"
  local desc="$2"
  shift 2
  LAST_OUT="$("$@" 2>&1)"
  local code=$?
  if [ "$code" -eq "$expected" ]; then
    ok "${desc}（退出码 ${code}，符合预期）"
  else
    bad "${desc}（期望退出码 ${expected}，实际 ${code}）"
    show
  fi
}

# assert_js <说明> <node -e 脚本>，脚本里可用 process.env.REPORT / process.env.BASELINE
assert_js() {
  local desc="$1"
  local body="$2"
  shift 2
  local err=""
  if err=$(REPORT="$REPORT" BASELINE="$BASELINE" node -e "$body" "$@" 2>&1); then
    ok "$desc"
  else
    bad "$desc"
    printf '%s\n' "$err" | sed 's/^/        /'
  fi
}

assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi
}

baseline_entry_count() {
  BASELINE="$BASELINE" node -e "
    const b = JSON.parse(require('fs').readFileSync(process.env.BASELINE, 'utf8'))
    console.log(Object.values(b.entries).reduce((sum, rules) => sum + Object.keys(rules).length, 0))
  "
}

reset_work() {
  git -C "$APP" reset -q
  git -C "$APP" checkout -- .
  git -C "$APP" clean -qfd
}

# 所有 CLI 调用都在临时工程目录里执行，与真实使用方式一致。
fg() {
  ( cd "$APP" && node "$CLI" "$@" )
}

# ---------------------------------------------------------------- 准备

printf 'fe-guard 验证开始\n'

if [ ! -d "$SAMPLE/node_modules" ]; then
  printf '样例工程缺少依赖，正在安装（npm install，仅首次）...\n'
  if ! (cd "$SAMPLE" && npm install --no-audit --no-fund >/dev/null 2>&1); then
    printf '依赖安装失败，请先手动在 %s 执行 npm install\n' "$SAMPLE"
    exit 1
  fi
fi

rm -rf "$WORK"
mkdir -p "$APP"
rsync -a --exclude node_modules --exclude .fe-guard "$SAMPLE/" "$APP/"
ln -s "$SAMPLE/node_modules" "$APP/node_modules"
git -C "$APP" init -q
git -C "$APP" config user.email "verify@fe-guard.local"
git -C "$APP" config user.name "fe-guard verify"
git -C "$APP" add -A
git -C "$APP" commit -qm "sample app: initial"
printf '临时工作区: %s\n' "$APP"

# ---------------------------------------------------------------- 1. 初始化

step "1. 初始化：一条命令生成配置、baseline、AGENTS.md 片段"
expect_exit 0 "init 执行成功" fg init
show
for file in fe-guard.config.json fe-guard.baseline.json AGENTS.md; do
  if [ -f "$APP/$file" ]; then ok "生成 $file"; else bad "缺少 $file"; fi
done
assert_eq "AGENTS.md 中写入了一份 fe-guard 约定片段" "$(grep -c 'fe-guard:begin' "$APP/AGENTS.md")" "1"
expect_exit 0 "init 可重复执行" fg init
assert_eq "重复 init 不会重复追加片段" "$(grep -c 'fe-guard:begin' "$APP/AGENTS.md")" "1"

# ---------------------------------------------------------------- 2. 空 baseline

step "2. 还没有记录 baseline 时，存量违规被当作新增 → 失败"
expect_exit 1 "空 baseline 下全量检查失败" fg check
show
assert_js "报告 ok=false，且有新增违规" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (r.ok !== false) throw new Error('ok 应为 false：' + JSON.stringify(r.summary))
  if (r.summary.new === 0) throw new Error('应存在新增违规')
"

# ---------------------------------------------------------------- 3. 记录 baseline

step "3. 把存量违规记入 baseline → 全量检查通过"
expect_exit 0 "baseline 记录成功" fg baseline
show
assert_eq "baseline 以 (文件, 规则) 为粒度记录，共 4 条" "$(baseline_entry_count)" "4"
expect_exit 0 "全量检查通过" fg check
show
assert_js "报告：存量 4 / 新增 0 / ok=true" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (r.summary.known !== 4 || r.summary.new !== 0 || r.ok !== true) throw new Error(JSON.stringify(r.summary))
"
assert_js "三类工具的输出都被归一化成统一字段" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  const fields = ['ruleId', 'file', 'line', 'severity', 'message', 'fix']
  for (const v of r.violations) for (const f of fields) {
    if (!(f in v)) throw new Error('违规缺少字段 ' + f + '：' + JSON.stringify(v))
  }
  const ids = r.violations.map((v) => v.ruleId.split('/')[0])
  for (const tool of ['eslint', 'typescript', 'boundaries']) {
    if (!ids.includes(tool)) throw new Error('缺少来自 ' + tool + ' 的归一化结果：' + ids.join(','))
  }
  if (!r.violations.every((v) => v.status === 'known')) throw new Error('应全部是 known')
"
git -C "$APP" add -A
git -C "$APP" commit -qm "chore: record fe-guard baseline"

# ---------------------------------------------------------------- 4. 新增违规

step "4. 某文件新增一条违规 → 失败，且 baseline 不被放宽"
BEFORE_BASELINE="$(cksum "$BASELINE")"
printf "\nexport function renderFooter(): string {\n  const orphan = 'never used'\n  return 'footer'\n}\n" >> "$APP/src/pages/home.ts"
expect_exit 1 "新增违规导致检查失败" fg check
show
assert_js "新增违规定位到 src/pages/home.ts 的 no-unused-vars" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  const fresh = r.violations.filter((v) => v.status === 'new')
  if (fresh.length !== 1) throw new Error('新增违规条数应为 1：' + JSON.stringify(fresh))
  if (fresh[0].file !== 'src/pages/home.ts' || fresh[0].ruleId !== 'eslint/@typescript-eslint/no-unused-vars') {
    throw new Error('定位错误：' + JSON.stringify(fresh[0]))
  }
"
assert_eq "失败时 baseline 文件字节未变化（没有被放宽）" "$(cksum "$BASELINE")" "$BEFORE_BASELINE"
reset_work

# ---------------------------------------------------------------- 5. 修复存量

step "5. 修掉一条存量违规 → 通过，baseline 自动收紧"
node -e "
  const fs = require('fs')
  const file = process.argv[1]
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  const unusedLocal = 42\n', ''))
" "$APP/src/utils/math.ts"
expect_exit 0 "修复后检查通过" fg check
show
assert_js "baseline 中 math.ts 的 no-unused-vars 条目被删除（1 → 0）" "
  const b = JSON.parse(require('fs').readFileSync(process.env.BASELINE, 'utf8'))
  const left = b.entries['src/utils/math.ts'] || {}
  if (left['eslint/@typescript-eslint/no-unused-vars']) throw new Error('条目仍存在：' + JSON.stringify(left))
"
assert_js "报告记录了收紧明细" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (!r.baseline.tightened.some((t) => t.from === 1 && t.to === 0)) throw new Error(JSON.stringify(r.baseline.tightened))
  if (!r.baseline.wroteBack) throw new Error('收紧应写回 baseline')
"
reset_work

# ---------------------------------------------------------------- 6. diff-only / staged

step "6. diff-only / --staged 只检查本次变更文件"
printf '\n// touched\n' >> "$APP/src/ui/format.ts"
expect_exit 0 "只改干净文件时 diff-only 通过" fg check --diff-only
show
assert_js "报告 mode=diff-only，scope 只含 src/ui/format.ts" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (r.mode !== 'diff-only') throw new Error('mode=' + r.mode)
  if (JSON.stringify(r.scope) !== JSON.stringify(['src/ui/format.ts'])) throw new Error('scope=' + JSON.stringify(r.scope))
"
assert_eq "未触碰文件的 baseline 条目没有被误删（仍为 4 条）" "$(baseline_entry_count)" "4"

git -C "$APP" add src/ui/format.ts
printf "\nexport function leak(): any {\n  return 1\n}\n" >> "$APP/src/utils/math.ts"
expect_exit 0 "--staged 只看暂存区，未暂存的违规不影响" fg check --staged
assert_js "staged 报告 scope 只含暂存文件" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (r.mode !== 'staged') throw new Error('mode=' + r.mode)
  if (JSON.stringify(r.scope) !== JSON.stringify(['src/ui/format.ts'])) throw new Error('scope=' + JSON.stringify(r.scope))
"
expect_exit 1 "diff-only 能看到工作区里未暂存的新违规" fg check --diff-only
show
reset_work

# ---------------------------------------------------------------- 7. 同文件修一加一

step "7. 同一文件内「修掉一条旧违规 + 新增一条新规则违规」→ 必须失败"
node -e "
  const fs = require('fs')
  const file = process.argv[1]
  let text = fs.readFileSync(file, 'utf8')
  text = text.replace('n % 2 == 0', 'n % 2 === 0')
  text += '\nexport function parse(input: any): string {\n  return String(input)\n}\n'
  fs.writeFileSync(file, text)
" "$APP/src/utils/math.ts"
printf '  该文件违规总数仍是 2 条（与 baseline 相同），但规则组合变了\n'
expect_exit 1 "同文件修一条加一条仍然失败（不是看总数）" fg check
show
assert_js "新增的是新规则 no-explicit-any，同时旧规则 eqeqeq 被收紧" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  const fresh = r.violations.filter((v) => v.status === 'new')
  if (fresh.length !== 1 || fresh[0].ruleId !== 'eslint/@typescript-eslint/no-explicit-any') {
    throw new Error('新增违规定位错误：' + JSON.stringify(fresh))
  }
  if (!r.baseline.tightened.some((t) => t.ruleId === 'eslint/eqeqeq' && t.from === 1 && t.to === 0)) {
    throw new Error('eqeqeq 应同时被收紧：' + JSON.stringify(r.baseline.tightened))
  }
"
reset_work

# ---------------------------------------------------------------- 8. 关闭与降级

step "8. 一处配置即可关掉或降级检查"
node -e "
  const fs = require('fs')
  const file = process.argv[1]
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config.enabled = false
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
" "$APP/fe-guard.config.json"
expect_exit 0 "enabled=false 时检查直接通过" fg check
assert_js "报告标记为 skipped" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (!r.skipped || r.ok !== true) throw new Error(JSON.stringify(r))
"
reset_work

node -e "
  const fs = require('fs')
  const file = process.argv[1]
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config.checks.eslint.level = 'warn'
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
" "$APP/fe-guard.config.json"
printf "\nexport function leak(): any {\n  return 1\n}\n" >> "$APP/src/utils/math.ts"
expect_exit 0 "eslint 降级为 warn 后，新违规不再导致失败" fg check
show
assert_js "新增违规被记为 warn 而不是 error" "
  const r = JSON.parse(require('fs').readFileSync(process.env.REPORT, 'utf8'))
  if (r.summary.newWarnings !== 1 || r.summary.newErrors !== 0) throw new Error(JSON.stringify(r.summary))
  if (r.violations.filter((v) => v.status === 'new').some((v) => v.severity !== 'warn')) {
    throw new Error('新违规的 severity 应为 warn')
  }
"
reset_work

# ---------------------------------------------------------------- 9. 退出码

step "9. 退出码语义：0 通过 / 1 新增违规 / 2 配置或环境错误"
printf '{ broken json' > "$APP/fe-guard.config.json"
expect_exit 2 "配置不是合法 JSON → 退出码 2" fg check
show
reset_work

printf "\nexport function leak(): any {\n  return 1\n}\n" >> "$APP/src/utils/math.ts"
expect_exit 2 "baseline 拒绝被自动放宽 → 退出码 2" fg baseline
show
reset_work

expect_exit 0 "恢复原状后全量检查仍通过" fg check

# ---------------------------------------------------------------- 10. 机器可读输出

step "10. --json 输出可直接被 CI 解析"
fg check --json > "$WORK/cli-output.json" 2>&1
CODE=$?
assert_eq "--json 模式下退出码为 0" "$CODE" "0"
assert_js "--json 的 stdout 是合法 JSON，且含必需字段" "
  const fs = require('fs')
  const r = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
  for (const key of ['schemaVersion', 'ok', 'exitCode', 'mode', 'summary', 'violations', 'baseline']) {
    if (!(key in r)) throw new Error('缺少字段 ' + key)
  }
  if (r.exitCode !== 0 || r.ok !== true) throw new Error(JSON.stringify(r))
" "$WORK/cli-output.json"

# ---------------------------------------------------------------- 汇总

step "汇总"
printf '  PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
printf '\n最终的 baseline（证据）:\n'
sed 's/^/    /' "$BASELINE"

if [ "$FAIL" -gt 0 ]; then
  printf '\n验证失败：%d 项不符合预期\n' "$FAIL"
  exit 1
fi
printf '\n全部验证通过\n'
