# Contributing to fe-guard

**English** · [简体中文](./CONTRIBUTING.zh-CN.md)

Thanks for your interest! fe-guard is a small tool designed to be maintainable by one person
over the long term. Contributions are welcome — please read the philosophy first, because it
shapes what we accept.

## Development setup

- Node 18+
- `npm install`
- `npm run verify:local` — the full gate: unit tests + v1–v4 real-subprocess verification + self-check

Every change must keep `npm run verify:local` green. The verification scripts spawn real
ESLint / tsc / dependency-cruiser / MCP processes — they do **not** mock. Please don't weaken
them to make a change pass.

## Philosophy (what we optimize for)

- **Zero runtime dependencies.** The only external tools are the ones being orchestrated
  (ESLint, tsc, dependency-cruiser). Don't add runtime deps.
- **No premature abstraction.** No plugin interface, event bus, or task queue. Seven runners
  each write their own; a little duplication buys readability.
- **Scope discipline.** Do only what's asked. New checks default to off for old configs.
- **Honest engineering.** A check that didn't run must fail (`not-executed`), never silently
  pass. Skipped ≠ passed.
- **Real verification.** Build a scenario, run the real command, record the output.

## Adding a check

1. Add a runner in `src/runners/<name>.js` producing the normalized violation shape.
2. Wire defaults in `src/config.js` and orchestration in `src/runners/index.js`.
3. Add unit tests + an end-to-end case in `test/` and a `verify-v*.mjs` scenario.
4. Document it in `docs/checks.md` and `docs/zh/checks.md`.
5. Keep files under ~500 lines (the tool gates itself on this).

## Pull requests

- One focused change per PR; describe the *why*, not just the *what*.
- Include verification evidence (command + output).
- Update both English and Chinese docs when behavior changes.
- Don't commit `fe-guard.baseline.json` widenings without a stated reason.

## Reporting issues

Use the issue templates. Include `npx fe-guard --version`, Node version, OS, the config, and
the relevant `.fe-guard/report.json` (run with `FE_GUARD_DEBUG=1` for MCP issues).

## Releasing

1. Bump the version in `package.json` and in both `version` fields of `package-lock.json`;
   add a `CHANGELOG.md` entry.
2. Run `npm run verify:local`; also run `npm run verify:ts7` when the TypeScript adapter or
   its supported versions changed.
3. Commit, push, and wait for the CI matrix to pass.
4. Build the tarball (`npm pack`) and create the release:

   ```bash
   gh release create v<version> fe-guard-<version>.tgz \
     --title "fe-guard v<version>" --notes-file <notes.md>
   ```

Keep release notes **short**: a runnable quick start plus a link into the README. Detailed
usage (tool table, manual MCP config, macOS PATH notes) lives only in the README so there is
a single source of truth; repeating it per release makes it drift.

```markdown
## Install

    npm i -D github:luffy-lcc/fe-guard   # or the attached tarball
    npx fe-guard init                     # writes .trae/mcp.json / .cursor/mcp.json

Reload the IDE's MCP panel to get 7 tools (`task_*` + `ui_lookup`).
Setup details, manual config and macOS PATH notes:
[README → Use in AI IDEs](https://github.com/luffy-lcc/fe-guard#use-in-ai-ides-mcp)

## Fixed / Changed
...
```

## License

By contributing, you agree that your contributions are licensed under the MIT License.
