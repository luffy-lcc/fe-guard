# fe-guard

> Turn frontend conventions into a single pass/fail command, and turn AI-driven repository rot into an enforceable gate.

[![CI](https://github.com/luffy-lcc/fe-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/luffy-lcc/fe-guard/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**English** · [简体中文](./README.zh-CN.md)

fe-guard orchestrates the ESLint, tsc and dependency-cruiser you already have, normalizes their output into one violation shape, and uses a **baseline ratchet** to freeze legacy debt — **only new violations can fail the gate**. On top of that, it turns the AI development workflow into **MCP tools**: the AI in Trae / Cursor must call tools to advance through "contract → acceptance criteria → plan → implement → verify → deliver". Stage decisions live in code, not in the model's self-reporting.

## Why

- **AI output outpaces human review**: rebuilt components, a second library for the same capability, bloated files, `any` everywhere, copy-paste — human review can't keep up.
- **Conventions in docs rely on memory**: turn on full lint and hundreds of legacy issues make the team disable the check entirely.
- **"Done" is unverifiable**: the AI claims completion with no auditable evidence.

fe-guard does one thing: make "**no worse than before**" automatic. Legacy debt is frozen, not demanded to be paid off at once; new violations must fail; fixing old debt auto-tightens the baseline, never loosens it.

## Features

- **Zero runtime dependencies**, Node 18+, ESM — the install is just a few source files.
- **Seven checks**: ESLint / TypeScript / architecture boundaries (orchestrating external tools) + dependency guard / component inventory / rot metrics / large-diff (built-in, lightweight).
- **Dual-track baseline ratchet**: counts + metric maxima, only tightens, auditable via `firstSeen` / `widenLog`.
- **MCP workflow layer**: event-sourced, stages derived from events, the AI cannot self-report "passed"; criteria can bind a test that the gate really runs.
- **fast / full profiles**: hooks under 3 seconds, full profile manually before merge.
- **Honest engineering**: a check that didn't run reports `not-executed` (non-baselineable); skipped ≠ passed; never a false green.
- **One config controls everything**: disable or downgrade by editing config; `workflow.enabled: false` falls back to pure checks.

## Quick start

```bash
npm i -D fe-guard          # before npm publish: npm i -D github:luffy-lcc/fe-guard
npx fe-guard init          # probe the project, then write config / ledger / AGENTS.md / IDE artifacts
npx fe-guard baseline      # record existing violations once (check turns green)
npx fe-guard check         # blocks only new violations; fixing old ones auto-tightens
# .husky/pre-commit:
npx fe-guard check --staged --profile fast
```

Close the loop: add `const unused = 1` → `check` fails → remove it → passes.

Adopting into a legacy codebase? `npx fe-guard init --preset legacy --dry-run` previews a looser starting config (thresholds and files) without writing anything; drop `--dry-run` to apply it. Presets: `js`, `vue`, `legacy`, `monorepo` — see [Getting started → Presets](docs/getting-started.md#presets-and---dry-run).

## Use in AI IDEs (MCP)

`npx fe-guard init` also wires the workflow layer into Trae / Cursor (`.trae/mcp.json`, `.cursor/mcp.json` — it only manages its own `mcpServers["fe-guard"]` entry, never overwrites your existing servers). Any MCP client can mount the stdio server manually:

```json
{ "mcpServers": { "fe-guard": { "command": "node", "args": ["./node_modules/fe-guard/bin/fe-guard-mcp.js"] } } }
```

The AI gets 6 `task_*` tools + `ui_lookup` and must call them to advance through contract → criteria → plan → implement → verify → deliver. Stage decisions live in code, so it cannot self-report "passed". On macOS, GUI apps don't load the shell PATH — with nvm/fnm, use absolute paths for `command`/`args` ([FAQ](docs/faq.md)).

Full walkthrough: [workflow](docs/workflow.md).

## Documentation

| Topic | Link |
| --- | --- |
| Quick start / commands / doctor / intranet distribution | [getting-started](docs/getting-started.md) |
| The seven checks and how they detect | [checks](docs/checks.md) |
| Baseline ratchet / profiles / exit codes | [baseline](docs/baseline.md) |
| AI IDE / MCP workflow layer | [workflow](docs/workflow.md) |
| Configuration reference / monorepo / Vue | [configuration](docs/configuration.md) |
| Progressive adoption and common concerns | [adoption](docs/adoption.md) |
| FAQ and troubleshooting | [faq](docs/faq.md) |
| Known limitations and non-goals | [limitations](docs/limitations.md) |
| Design trade-offs and architecture | [design](docs/design.md) |
| Real-world measurement report | [real-world](docs/real-world.md) |

Chinese documentation: [README.zh-CN.md](./README.zh-CN.md) · [docs/zh/](docs/zh/).

## Real-world evidence

Measured on copies of 3 real Vue repositories (100k–180k lines):

- 100k-line single repo: fast profile **2.0s**, full **2.5s** — the 3-second hook target holds.
- Legacy debt recorded once (956 / 11424 entries), then `check` exits 0; **error-level false positives: 0 / 1092**.
- boundaries (depcruise 18.8.0): 19 real circular dependencies, **0 false positives** in sampling, check < 1s.
- Caught real shared-component rebuilds, near-identical duplicate modules, and `.vue` type errors.

Full numbers and per-item judgments: [real-world report](docs/real-world.md).

## Requirements

- Node 18+, project is a git repository.
- The orchestrated tools (ESLint / TypeScript / dependency-cruiser) are installed by the project itself; fe-guard has zero runtime dependencies. Missing tools yield an explicit "not executed" or can be disabled.

## Contributing & license

Contributions welcome — read [CONTRIBUTING](./CONTRIBUTING.md) first (zero deps, no premature abstraction, real verification required). See [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md).

[MIT](./LICENSE) © fe-guard contributors
