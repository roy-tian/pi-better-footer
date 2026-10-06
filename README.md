# pi-better-footer

[English](README.md) · [简体中文](README_zh.md)

Keep [Pi](https://pi.dev/)'s familiar footer layout, with provider quotas, generation speed, and Git changes alongside your session usage.

![pi-better-footer demo](assets/pi-better-footer.svg)

*Available fields depend on your provider, session, and terminal width.*

## Features

- **Usage at a glance.** Provider quotas and reset countdowns sit alongside model information; session tokens, cache hit rate, cost, and context usage stay in their familiar place. Colors follow your theme, with warnings for low quota and high context usage.
- **Native token counters.** `↑` shows non-cached input, `↓` output, `R` cache reads, and `W` cache writes. These are session totals; zero counters are hidden. Cache reads and writes are shown separately, as in Pi's native footer.
- **Generation speed.** `t/s` excludes time to first token and tool execution. `~` marks a live estimate; replies without tool calls finish with a reading based on reported token usage, excluding reported reasoning tokens.
- **Project details.** The directory and branch are joined by the project's `package.json` version and added/removed line counts, including untracked files. Updates follow workspace activity.
- **Model continuity.** Restore the last model and thinking level per directory, and skip providers with confirmed exhausted quota when cycling models. Both options can be toggled independently.

## Install

```sh
pi install npm:pi-better-footer
```

Or install from GitHub or a local checkout:

```sh
pi install git:github.com/roy-tian/pi-better-footer
pi install /absolute/path/to/pi-better-footer
```

To try it from the repository without installing:

```sh
pi --no-extensions --extension ./extensions/index.ts
```

Restart Pi after installation. Manage enabled extensions in `pi config`; disable older footer or model-cycling extensions that overlap. For local source changes, use `/reload` or restart Pi.

## Controls

| Command | What it does |
| --- | --- |
| `/better-footer` | Toggle model/thinking persistence and exhausted-quota skipping. Both default to on; settings persist. |
| `/scoped-models` | Configure Pi's model cycle. Quota skipping applies to cycle keys (default `Ctrl+P`), not manual `/model` selection. |
| `pi --no-recent-model` | Disable both restoration and recording of the recent model and thinking level for this run. |

Settings are stored in `better-footer.json` under Pi's agent directory (normally `~/.pi/agent/`). Recent models are stored per working directory. Explicit `--model`, `--provider`, `--thinking`, and `--models` choices take precedence; resumed conversations use Pi's own restoration.

## Quota sources

Only the active provider's quota is shown. Missing, failed, or stale readings never count as exhausted.

| Provider | Source |
| --- | --- |
| OpenAI Codex (legacy) | Codex app-server rate limits and response headers; requires the `codex` CLI. |
| OpenAI — Sign in with ChatGPT (Pi 0.99+) | Explicit app-limit errors and a link to ChatGPT's usage page, rather than a numeric balance. |
| Z.AI / GLM | Account quota API using Pi's configured key, with a 429-error fallback. A hammer marks monthly tool quota ([Nerd Font](https://www.nerdfonts.com/)). |
| OpenCode Go | Usage API using `OPENCODE_GO_API_KEY`, Pi's key, or OpenCode CLI credentials; optional dashboard-cookie fallback. |
| GitHub Copilot | Premium credits from Pi's authentication record. |
| Other providers | Response-header rate limits, which may differ from subscription balances. |

Some sources are polled while active; others update after responses. The extension uses existing local credentials. Optional OpenCode Go settings are documented in [`extensions/quota/opencode-go.ts`](extensions/quota/opencode-go.ts).

The `ChatGPT` link becomes `ChatGPT limit` after an explicit app-limit denial. Cycling respects that restriction for up to five minutes, or until a successful response clears it; this is not a predicted reset time or a statement about the whole subscription balance. Virtual models are excluded from quota polling and quota-based skipping because they may route to another provider.

## Development

Requires Node.js 24 and Bun. Pi packages are runtime peer dependencies.

```sh
bun install
bun run test
bun run lint
bun run typecheck
bun run build:check
```

## License

[MIT](LICENSE)
