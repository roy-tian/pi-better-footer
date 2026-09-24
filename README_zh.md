# pi-better-footer

[English](README.md) · [简体中文](README_zh.md)

给 [Pi](https://pi.dev/) 用的轻量状态栏：一眼看到当前模型、额度、会话用量和 Git 状态；切换模型、重启 Pi 时也尽量延续你的工作习惯。

## 能做什么

- **清晰的状态栏，按当前 provider 显示额度。** 底部一行展示模型与思考强度、额度剩余百分比及重置倒计时、生成速度、会话 token / 缓存命中率和上下文占用。支持 OpenAI Codex、Z.AI / GLM、OpenCode Go、GitHub Copilot 等来源；其他 provider 若返回限流响应头，也会显示可用的额度信息。额度信息会随当前模型切换更新，并尽力定期刷新；查不到时不会虚构数值。
- **实时 Git 信息。** 输入框上方显示工作目录、分支及 `+新增/-删除` 行数（含未跟踪文件）；工作区变化会定期刷新，无需手动运行 `git status`。
- **记住模型与思考强度。** 按工作目录记录最近使用的设置，在新会话或重新启动 Pi 时恢复，不修改 Pi 的默认设置；已有会话继续遵循 Pi 自身的恢复机制。需要时可关闭，也可用 `--no-recent-model` 仅对本次运行停用。
- **跳过额度已耗尽的 scoped model。** 在交互界面用 `Ctrl+P` 轮换模型时，自动跳过**已确认**额度耗尽的 provider，不必一个个试；反向轮换也支持。未取得额度信息不等于额度耗尽，因此不会因为查询失败而跳过。此功能可单独关闭，不影响状态栏显示额度。

示意（具体字段取决于 provider、终端宽度和可用数据）：

```text
                                      ~/project  main · +12 -3
openai-codex/model high · 5h 72% · 1d 48% · 36t/s    ↑62k/1.2M ↓8k CH75.0% · 66k/1.0M
```

## 安装与使用

需要已安装 Pi。从 npm 安装：

```sh
pi install npm:pi-better-footer
```

或从 [GitHub 仓库](https://github.com/roy-tian/pi-better-footer)安装：

```sh
pi install git:github.com/roy-tian/pi-better-footer
```

已有本地仓库时，也可以从本地路径安装：

```sh
pi install /absolute/path/to/pi-better-footer
```

或者在仓库目录中临时试用（不加载其他扩展）：

```sh
pi --no-extensions --extension ./extensions/better-footer/index.ts
```

安装后启动 Pi；如果没有生效，请在 `pi config` 中确认 **better-footer** 已启用。状态栏、模型记忆和额度跳过功能都包含在同一个扩展里，无需分别启用。如果之前单独安装过同类扩展，请先在 `pi config` 中停用旧版本，避免重复显示或处理。使用本地包时，修改源码后运行 Pi 的 `/reload` 或重新启动即可生效。

| 操作 | 作用 |
| --- | --- |
| `/better-footer` | 分别开关「记住模型与思考强度」和「跳过耗尽额度的 scoped model」；两项默认开启，选择一次即可切换，退出菜单即可完成。 |
| `/scoped-models` | 在 Pi 中配置轮换范围；默认用 `Ctrl+P` 轮换（若改过快捷键，以 Pi 的配置为准）。仅轮换时触发额度跳过，不影响 `/model` 手动选择。 |
| `pi --no-recent-model` | 本次运行不恢复、也不记录最近的模型与思考强度。 |

设置保存在 Pi agent 目录下的 `better-footer.json`（默认 `~/.pi/agent/better-footer.json`）；关闭「记住模型」会同时停止恢复和记录。最近模型记录按工作目录分别保存。显式传入的 `--model` / `--provider`、`--thinking`，以及已有对话的恢复和 `--models` 范围会受到尊重。

## 额度数据从哪里来

| Provider | 数据来源 |
| --- | --- |
| OpenAI Codex | Codex app-server 的额度信息，必要时结合响应头；需要 `codex` CLI。 |
| Z.AI / GLM | 使用 Pi 已配置的 provider 密钥查询账户额度；遇到 429 时可从错误信息补充。 |
| OpenCode Go | 使用 `OPENCODE_GO_API_KEY`、Pi 中配置的 key 或 OpenCode CLI 凭据访问用量 API；也可使用可选的 dashboard cookie 配置作为后备。 |
| GitHub Copilot | Pi 登录记录中的 premium credits。 |
| 其他 provider | 支持时读取 API 返回的限流响应头（不一定代表订阅额度）。 |

额度读取是尽力而为：当前 provider 的部分来源会周期查询，其他来源依赖响应头；没有返回、认证失败或数据过期时，不会当作额度耗尽。扩展读取本机已有的认证信息，不在仓库中存放凭据。OpenCode Go 的可选配置路径与环境变量见 [`extensions/better-footer/quota/opencode-go.ts`](extensions/better-footer/quota/opencode-go.ts)。

## 开发

需要 Bun；测试使用 Node.js 24：

```sh
bun install
bun run test
bun run lint
bun run typecheck
bun run build:check
```

Pi 相关包以 peer dependency 提供运行时支持；dev dependency 用于本地检查。

## 许可证

[MIT](LICENSE)
