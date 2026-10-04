# pi-better-footer

[English](README.md) · [简体中文](README_zh.md)

A compact, live status line for [Pi](https://pi.dev/). See your current model, available provider quota, session usage, and Git changes at a glance—without losing your model and thinking level when starting fresh.

![pi-better-footer demo](assets/pi-better-footer.svg)

*Illustrative output; available fields depend on your provider, session, and terminal width.*

## Why use it?

- **A clean footer with quota visibility.** One line shows the active provider/model, thinking level, remaining quota and time until reset (when available), output speed, session tokens, cache hit rate, session cost, and context usage. OpenAI Codex, Z.AI / GLM, OpenCode Go, and GitHub Copilot have dedicated quota sources; other providers can expose rate limits through response headers. Only the active provider's quota appears in the footer.
- **Git status where you work.** A right-aligned line above the editor shows the working directory, branch, and added/removed line counts, including untracked files. Counts are re-read whenever the tree may have changed (tool runs, submitted prompts, branch switches, `!` shell commands) — not on a fixed timer.
- **Keep your workflow across sessions.** Remember the last model and thinking level per working directory for new sessions and fresh Pi starts, without changing Pi's saved defaults. When cycling scoped models with `Ctrl+P` (or your configured cycle keys), skip providers **known** to have exhausted quota. Both behaviors are on by default and can be turned off independently. Unknown quota is never treated as exhausted.

`t/s` shows the last measurable reply's output speed, excluding time to first token and tool execution. Replies containing tool calls (including mixed text/tool replies) do not update it: providers do not report separate token counts for text and tool arguments. CLI output and tool results never count; the previous reading stays visible. Reported reasoning tokens are excluded; otherwise streamed thinking is included.

## Install

Install from npm:

```sh
pi install npm:pi-better-footer
```

Or from [GitHub](https://github.com/roy-tian/pi-better-footer):

```sh
pi install git:github.com/roy-tian/pi-better-footer
```

For a local checkout (no release needed):

```sh
pi install /absolute/path/to/pi-better-footer
```

To try the extension from the repository without installing it:

```sh
pi --no-extensions --extension ./extensions/index.ts
```

Restart Pi after installing; if the extension does not appear, check `pi config`. The package declares **one** extension entry, `better-footer`; there are no separate components to enable. Disable any older standalone footer or model-cycling extensions to avoid duplicate handlers. Local installs load directly from the source directory, so `/reload` or a restart picks up changes.

## Controls

| Command | What it does |
| --- | --- |
| `/better-footer` | Toggle model/thinking persistence and exhausted-quota skipping separately. Both default to on; settings persist. |
| `/scoped-models` | Configure Pi's model cycle. Quota skipping applies only to cycle keys (default `Ctrl+P`), not manual `/model` selection. |
| `pi --no-recent-model` | Neither restore nor record the recent model and thinking level for this run. |

Settings live in `better-footer.json` under Pi's agent directory (normally `~/.pi/agent/`); recent model selections are stored separately per working directory. Turning off model persistence stops both restoration and recording. Explicit `--model`, `--provider`, `--thinking`, and `--models` choices are respected; resuming a conversation uses Pi's own model restoration.

## Where quotas come from

| Provider | Source |
| --- | --- |
| OpenAI Codex (legacy) | Authenticated Codex app-server rate limits, supplemented by response headers where available; requires the `codex` CLI. |
| OpenAI — Sign in with ChatGPT (Pi 0.99+) | Official Responses API `subscription_sharing_usage_limit_exceeded` errors. The footer links to ChatGPT's usage page; no balance polling, guessed percentage/reset time, or Codex CLI account reuse. |
| Z.AI / GLM | Account quota endpoint using the key configured in Pi; 429-error fallback. The monthly tool-invocation quota is marked with a hammer icon ([Nerd Font](https://www.nerdfonts.com/)). |
| OpenCode Go | Usage API using `OPENCODE_GO_API_KEY`, the key configured in Pi, or OpenCode CLI credentials; optional dashboard-cookie fallback. |
| GitHub Copilot | Premium credits from Pi's authentication record. |
| Other providers | Rate-limit response headers, when available (not necessarily subscription balances). |

Quota reads are best-effort: some sources are polled while the current provider is active, and others update only after a provider response. Missing, failed, or stale readings do **not** mean a provider is unusable. The extension uses your existing local credentials; credentials are not committed to this repository. Optional OpenCode Go configuration details are in [`extensions/quota/opencode-go.ts`](extensions/quota/opencode-go.ts).

For **Sign in with ChatGPT**, the footer shows a clickable `ChatGPT` label (on terminals that support hyperlinks), changing to `ChatGPT limit` after an explicit app-limit denial. A denial can be app-specific, so it does not imply the whole plan is empty. Cycling treats it as a restriction for at most five minutes, or until a successful response clears it; this freshness limit is **not** a predicted quota reset. API-key billing and ordinary token-rate limits stay separate. See [OpenAI's documented recovery rules](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

**Virtual models** are not skipped based on their selection provider's quota: they may route to a different provider. The footer does not poll or attribute response-header quota to a virtual selection. Pi 0.99's `system` theme follows the reported `theme.appearance`, with a name/environment fallback on older Pi versions.

## Development

Tests require Node.js 24 and Bun:

```sh
bun install
bun run test
bun run lint
bun run typecheck
bun run build:check
```

Pi packages are peer dependencies at runtime.

## License

[MIT](LICENSE)
