# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

### Fixed

- **Vue projects no longer silently skip `.vue` type checking.** `init` used to write
  `"bin": "tsc"` for the `typescript` check, which overrode the auto-switch and made
  `.vue` diagnostics disappear (a real type error in a `.vue` file could pass the gate).
  The default config now leaves `bin` unset, so Vue projects really run `vue-tsc`.
  Configs that explicitly set `"bin": "tsc"` keep their behavior but now print a warning
  that `.vue` files are not type-checked.
- **Vue + TypeScript 7 fails fast with a clear message** instead of a vue-tsc crash reported
  as "check not executed": TypeScript 7 (the Go-native compiler) no longer exports
  `typescript/lib/tsc`, which every vue-tsc release resolves at startup.

### Changed

- `vue-tsc` 3.x is verified and supported (with TypeScript 5.x); devDependency bumped to 3.3.14.
- Non-Vue projects can use TypeScript 7 directly — the `tsc` diagnostic format is unchanged.
- New regression tests (`test/v63.test.js`) cover the default-config auto-switch, the
  TypeScript 7 guard, and the explicit-`bin` warning.

## [0.1.0]

First public release — consolidates the full feature set built during internal iterations.

### Added

- Check layer: orchestration of ESLint / TypeScript / dependency-cruiser plus four built-in
  checks (`deps`, `ui`, `metrics`, `diff-size`), normalized into one violation shape.
- Dual-track baseline ratchet: per-(file, rule) counts and per-(file, metric) maxima;
  only tightens, never loosens; `firstSeen` / `widenLog` audit fields; `baseline --verify`
  blocks unregistered widening against merge-base; `--follow-renames` migrates ledger keys.
- MCP workflow layer: contract → criteria → plan → implement → verify → deliver, with stages
  derived from append-only events (no "set stage" entry point); acceptance criteria can bind
  a `testFile` that the gate really runs.
- `fast` / `full` profiles, `doctor`, `baseline --show --by-rule`, false-positive recording
  and suggestions, tarball distribution, config/baseline schema validation.
- monorepo support: per-package ESLint / TypeScript runs with each package's own config;
  `metrics.overrides` per-directory thresholds; `metrics.duplication.normalizeIdentifiers`
  (opt-in) resists copy-and-rename duplication.
- Vue support: automatic `vue-tsc` switching; `boundaries` detects an incomplete Vue
  dependency graph and reports a non-baselineable `boundaries/not-executed` instead of a
  false pass.
- Subdirectory root support: when the project root is not the git root, `--staged`,
  `diff-size`, rename migration and `--verify` all use correct path semantics.
- Honest engineering: `not-executed` violations are non-baselineable; skipped ≠ passed;
  staged snapshot; subprocess timeout ceiling.

### Pre-release history

Internal iterations v1–v6.2 progressively built the capabilities above (external-check
orchestration, the MCP workflow, the four built-in checks, monorepo/Vue support,
subdirectory roots, and the "no false pass" fixes). 0.1.0 is the first public release and
includes all of them; the public version counter restarts here.
