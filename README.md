# dsh-agent-picker

**Agent 模式选择器** —— 在 DSH（DeepSeek Harness）Web 界面的输入框右侧加一个控件，
像选推理档位那样选定一个**外部 Agent CLI**作为当前会话的默认执行体。

它把"有哪些外部 Agent、各自怎么启动"做成**数据**（`agents.json`），
所以加一个新 Agent **只需加一条数据，不必改代码**。

---

## 它解决什么问题

DSH 本身能调用外部 CLI，但"调哪一个"通常要写死在配置里。这个插件把选择权交回给你：
输入框右边一个下拉，选谁，这一轮就交给谁。名册驱动的设计意味着
**同一个插件能挂任意多个 Agent**，包括你自己写的。

## 安装

```bash
dsh plugin add dsh-agent-picker
```

装完重启 DSH。插件第一次启动会把自带的 `agents.json` 复制一份到
`$DSH_HOME/agent-picker.agents.json`（默认 `~/.dsh/`），**之后你改的是这一份**，
插件升级不会覆盖它。

## 名册：怎么加一个新 Agent

编辑 `$DSH_HOME/agent-picker.agents.json`，往 `agents` 数组里加一条：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识 |
| `name` | 显示名 |
| `tool` | DSH 里对应的工具名 |
| `bin` | 包装器文件名（用于"是否已安装"的探测） |
| `available` | 初始可用性建议；**真实可用性由插件探测包装器是否存在** |
| `kind` | `task`=任务型（结果可概括）／`chat`=对话型（原样转述） |
| `expertise` | 菜单里显示的「擅长」一行 |
| `note` | 健康状态／接线说明 |
| `desc` | 展开后的详细能力介绍 |
| `launch` | **可选**。自带执行配方：`bin` / `argv` / `env` / `timeoutMs` / `graceMs` / `maxBytes`。写了它，本插件就自己注册 `cli_<id>_direct` 工具 |

改完**重启 DSH** 生效。

### `launch.argv` 的路径规则（重要）

名册是**跨机器**的，所以**不要写死绝对路径**。`argv` 里写**裸文件名**即可，
插件会在运行时按下面顺序解析：

```
codex-dsh.ps1            ->  <cliBinDir>/codex-dsh.ps1
{cliDir}/codex-dsh.ps1   ->  <cliBinDir>/codex-dsh.ps1
C:\some\where\x.ps1      ->  原样保留（你想钉死绝对路径时用）
```

`cliBinDir` 的取值：环境变量 **`DSH_AGENT_PICKER_CLI_DIR`** 优先，
否则默认 `~/dsh-clis/bin`（与 `dsh-sub-cli` 的约定一致）。

### 占位符

`argv` 里可用的占位符：`{task}`（任务正文）、`{permission}`、`{model}`、`{image}`。

**`{image}` 只对命令行真的支持图片参数的 CLI 有意义**（例如 Codex 的 `-i/--image`）。
其余 CLI 就算它自己有读图能力，也**不是**靠这个占位符——那种情况请把图片路径写进任务正文，
让那个 Agent 用自己的读文件工具去读。

## 你需要自备什么

这个插件**只负责调度，不附带任何 Agent**。要用哪个，请自行安装并确认它在命令行可用：

Claude Code · Codex · Qwen Code · Gemini CLI · Aider · Goose · Hermes · OpenClaw · Ollama …

插件按 `cliBinDir` 下的包装器探测可用性；**探测不到的成员不会出现在可选区**。

> 封装脚本的写法与各 CLI 的接入细节，取决于你接哪个模型端点、有哪些凭据。
> 这部分**不在本插件范围内**，请按你自己的环境准备。

## 参数约定

所有 Agent 工具的正文参数统一叫 **`prompt`**（配一个 3–5 词的 `description` 作标题；
`task` 是兼容别名）。新加 Agent 请沿用，别另起名字。

## 兼容性

`dsh.compatibility` 声明为 `>=0.1.5`。
本插件**不依赖** `settings.register()` / `installSection()` 这类会随宿主版本变动的设置 API ——
它只用 `ctx.tools.register` / `ctx.tools.guard` / `ctx.subprocess` / `ctx.webServer.register`。

> 背景：DSH 0.1.7 移除了旧的 settings 注册入口，凡是用到它的插件会在启动时抛
> `TypeError: ... is not a function`。本插件从设计上避开了这条路径。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

Copyright (c) 2026 dsh-agent-picker contributors

你可以自由使用、修改、再分发（保留版权声明即可）。本插件**不附带任何 Agent**，
调度的是你自己安装的第三方 CLI，那些工具各自的许可与费用由你自行遵守。

## 开发

```bash
git clone https://github.com/Ok541151/cwk.git
cd cwk
```

离线自检脚本依赖宿主自带的 `@deepseek-ai/dsh-tools`。若在仓库外单独跑断言，
需要在 `node_modules/@deepseek-ai/` 下指向宿主那份（**这个目录不要提交**）。

