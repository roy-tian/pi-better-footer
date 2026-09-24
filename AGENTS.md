# AGENTS.md

Guidance for coding agents working in this repository: a Pi extension package
whose single entry is `extensions/index.ts`.

## Commands

Tests need Node.js 24 and Bun.

- `bun run test` runs the Node suites (`tests/*.test.mjs`), then the Bun suite (`tests/status-footer.test.ts`).
- One Node file: `node --experimental-vm-modules --test tests/<file>.test.mjs` (add `--test-name-pattern "<name>"` for one test).
- `bun run lint`, `bun run typecheck` and `bun run build:check` must also pass.
- `bun run lint` runs `biome check`: lint rules plus a formatting check. `bun run format` formats the code and applies safe lint fixes.

## Test harness gotchas

Most Node suites strip types with `stripTypeScriptTypes` and link the module into a `node:vm` context with hand-written dependency stubs. So:

- Use only erasable TypeScript: no `enum`, `namespace`, or constructor parameter properties.
- Write type-only imports as `import type` (or inline `type`). A plain import survives stripping and must then be stubbed.
- `bun run lint` enforces both rules above.
- Modules loaded this way: `index.ts`, `settings.ts`, `recent-model.ts`, `skip-unavailable.ts`, `footer/index.ts`, `footer/render.ts`, `quota/provider-quota.ts`. A new relative import in one of them needs a stub in that test's `dependencies` map.
- Stubs match the exact specifier, so keep relative imports extensionless (`./git`, not `./git.ts`). The `provider-quota` and `skip-unavailable` suites reject every unstubbed import, `node:` built-ins included. The `render` loader lets only `node:` built-ins through.
- `tests/status-footer-integration.test.mjs` builds its own `makeState()`. Add new `FooterState` fields there too.
- Other modules (quota parsers, `footer/git.ts`, `footer/session-stats.ts`) are imported directly by the Bun suite and need no stubs.

## Style

Biome formats all TypeScript and JavaScript: tabs, double quotes, semicolons, 120 columns (`biome.json`). Run `bun run format` after editing instead of formatting by hand. JSON files are not formatted.

## Behavior rules

- Poll, spawn processes, and make network requests only while the TUI footer is mounted (`ctx.mode === "tui"`). Print, json and rpc runs must not poll.
- Record the recent model only when `ctx.hasUI`: print and json runs skip it, rpc runs record it.
- Refresh on events, not fixed timers. Git is re-read only when the tree may have changed. Quota polling backs off to every 10 minutes, then hourly, while Pi is idle.
- Send a provider's API key only to that provider's own service. Decide from the host of the models' `baseUrl`, never from the provider id (see `zaiQuotaUrl`, `usesOpenCodeHost`).
- Missing, failed, or stale quota never counts as exhausted. Copilot credits of `0/N` do count, since every Copilot model consumes premium requests.
- Run git through `execFile` (`footer/git.ts`), not `pi.exec`. `pi.exec` reports a timeout as exit code 0 and needs an `env` binary to set variables, which Windows lacks.

## Pi API

Pi packages are peer dependencies. For the extension API and event names, read `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `dist/core/extensions/types.d.ts` in the same package.

## Repo conventions

- `README.md` and `README_zh.md` must be updated together. A new command, setting or flag goes in both controls tables; a new quota source goes in both quota-source tables.
- `.temp/` is gitignored scratch space. Deferred work is tracked in `.temp/TODO.md`.
- There is no build step: Pi loads the `.ts` source directly, and `build:check` only checks that it bundles.
- There is no CI. To release: run the test, lint, typecheck and build checks, bump `version` in `package.json`, commit, tag `vX.Y.Z`, push the branch and the tag, then run `npm publish`. The `files` field controls the tarball.
