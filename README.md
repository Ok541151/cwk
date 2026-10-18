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

`argv` 里可用的占位符：`{task}`（任务正文）、`{permflags}`、`{permission}`、`{model}`、`{image}`。

**`{permflags}` 是特殊的**：它会展开成**多个**参数，取值来自名册里的
`permFlags[<权限档>]`；没指定权限档时取 `defaultPermFlags`。
所以一条模板就能携带"权限档 → 这个 CLI 自己的 flag"的映射，调用方不必知道每个 CLI 的语法。

**`{image}` 只对命令行真的支持图片参数的 CLI 有意义**（例如 Codex 的 `-i/--image`）。
其余 CLI 就算它自己有读图能力，也**不是**靠这个占位符——那种情况请把图片路径写进任务正文，
让那个 Agent 用自己的读文件工具去读。

## 你需要自备什么

这个插件**只负责调度，不附带任何 Agent**。装好一个 CLI，它就会被自动发现并列出来。

探测来源（按顺序）：`PATH` → 托管目录（`~/dsh-clis/bin`，可用 `DSH_AGENT_PICKER_CLI_DIR` 覆盖）
→ `~/.local/bin`。

**出厂名册是空的，这是有意的** —— 列表里的成员全部来自"本机实际探测"。
所以别人机器上看到的列表，取决于他装了哪些 CLI。

## 各 Agent 的兼容性（实测声明）

内置识别 **28 个** Agent 名字。分两类：

- **11 个带启动配方** → 探测到即可直接调用
- **17 个只识别** → 探测到会出现在列表里（带名字和介绍），但需要你补一条启动配方才能真正调用

> 为什么不全给配方：启动参数写错比不写更糟 —— 那会变成"列表里能点，一点就报错"。
> 所以只有参数经过验证的才给配方，其余诚实标成"需配置"。

### ✅ 有启动配方（探测到即可调用）

| Agent | 启动参数 | 权限映射 | 参数验证 |
|---|---|---|---|
| **Aider** | `--message {task}` | `--dry-run` / `--yes-always` | `--help` 复核 ✓ |
| **Qwen Code** | `-p {task}` | `--approval-mode plan` / `yolo` | `--help` 复核 ✓ |
| **Gemini CLI** | `-p {task}` | `--approval-mode plan` / `yolo` | `--help` 复核 ✓ |
| **Goose** | `run -t {task}` | — | `--help` 复核 ✓ |
| **Hermes** | `-z {task}` | — | `--help` 复核 ✓ |
| **Codex** | `exec --skip-git-repo-check {task}` | `-s read-only` / `workspace-write` / `danger-full-access` | 取自已跑通的包装脚本 |
| **Claude Code** | `-p {task}` | `--permission-mode plan` / `acceptEdits` / `bypassPermissions` | 取自官方参数（未本机复核） |
| **Ollama** | `run qwen3:4b {task}` | — | 见下方条件 |
| **opencode** | `run {task}` | — | 官方文档给出 `run` 子命令；**未实机跑过** |
| **Cursor CLI** | `-p --trust {task}` | `--mode plan` / `--force` | 官方 `--help` 实测记录 ✓ |
| **Kimi** | `-p {task}` | 非交互模式自带 auto 权限 | 官方文档 ✓ |

### 🔍 只识别、不给配方（会显示"需配置启动方式"）

`GitHub Copilot CLI` · `Trae` · `Amp` · `Droid` · `Augment Code` ·
`OpenHands` · `Cline` · `Windsurf` · `ZCode` · `Qoder` · `CodeBuddy` · `Grok CLI` ·
(`OpenClaw` · `Kilo Code` · `CodeWhale` · `Crush` · `WorkBuddy`)

这些出现在列表里时是这样的：

```
○ GitHub Copilot CLI     已检测到，需配置启动方式
  自动发现（…\copilot.CMD）；识别到 CLI，但还没有启动配方
  ─────────────────────────────────────────────
  GitHub 官方的命令行 Copilot，和 GitHub 生态贴得最近。
  —— 用约定目录或名册补一条 launch 就能调用
```

### 怎么补一条配方（插件里有现成引导）

**不用翻这份文档** —— 在列表里点那一行的 **「怎么补？▼」**，会就地展开三步：

1. **查出它的参数** —— 命令里已经填好这个 CLI 的真实路径，一键复制：
   `"C:\...\copilot.CMD" --help`
2. **找“一次性执行”的标志** —— `--prompt` / `-p` / `exec` / `run` 这类
3. **存成约定目录里的文件** —— 路径和模板都由插件给出，`id` / 名字 / `bin` 已填好，
   你只改 `argv` 这一行，模板可一键复制：

```json
{
  "id": "copilot",
  "name": "GitHub Copilot CLI",
  "tool": "cli_copilot_direct",
  "kind": "task",
  "launch": { "bin": "C:\\AgentTools\\cli\\copilot.CMD", "argv": ["-p", "{task}"] }
}
```

存好后**重启 DSH**，它就会从「可安装」升到主列表。

> 引导是**纯提示**，不写盘、不拦截 —— 现在不想配也完全可以，那一行就安静待着。

### 关于探测名的取舍

探测名越短越容易**误报**（机器上有个同名的无关程序，就会被当成某个 agent）。
所以本项目有一条硬规则：**只接受 4 个字符以上的探测名** —— `amp` 是唯一例外，
因为它是 Sourcegraph 官方 CLI 名。`Pi`、`Roo Code` 这类既有条目因此被移除，
而不是靠猜名字去凑数量。

另外 **Crush 目前只识别、不给配方**：Charm 的仓库里有一个未关闭的 issue 在请求
“非交互批处理模式”（`charmbracelet/crush#1030`），说明 `crush run <任务>` 这条路
当时并不存在。猜一个不存在的子命令 = 用户点了必报错，所以宁可不给。

### ⚠️ 需要额外条件

| Agent | 条件 |
|---|---|
| **Ollama** | 本机要有 ollama 服务在跑；配方里模型名写死为 `qwen3:4b`，装的是别的模型请改名册或约定目录 |
| **Gemini CLI** | 还要一个协议翻译层（如 LiteLLM）把你的端点转成 Gemini 协议 |
| **Qwen Code** | 需要 `DEEPSEEK_API_KEY`（它自己读 `~/.qwen/.env`） |
| **Goose** | 需要 `GOOSE_PROVIDER` / `GOOSE_MODEL` / `OPENAI_API_KEY` / `OPENAI_HOST` |

### ❗ 已知陷阱：**探测到 ≠ 能调用**

别只看它出现在列表里就以为能用。三种典型情况：

1. **没配方的**（上面那 20 个）。列表里会明确写「需配置启动方式」——
   它只是"我看到了你装了这个"，不是"我能用它"。
2. **悬空的 npm shim**（最常见）。用 `npm i -g` 装过某个 CLI、之后又把包删了，
   `claude.cmd` 这类 shim 会留下，但它指向的 `xxx.exe` 已经不在了。
   探测只检查 shim 文件存在 → 判定"已安装"；调用时子进程报 **"系统找不到指定的路径"**。
   → 处理：重装那个 CLI，或删掉残留 shim。
3. **缺凭据 / 缺服务**。这类成员在「可安装」区标「已安装，待配置」并写明缺什么。

**自查这个 shim 还活着吗**：

```powershell
Get-Content (Get-Command <cmd>).Source     # 看它指向哪个 exe，再去那个路径看还在不在
```

## 参数与权限

工具参数里有一个可选的 `permission`，取值 `read-only` / `workspace-write` / `danger-full-access`。

**它会被翻译成每个 CLI 自己的参数**（见上表），不是本插件自己实施的控制：

- **不传时用默认档**（Codex 是 `workspace-write`，Aider/Qwen/Claude 是自动批准那一档）。
  这不是偏好问题：无头执行没有人去点「允许」，默认档必须是"不会卡在审批上"的那个，
  否则每次调用都会等到超时。
- 想精确控制就显式传 `permission`，或者写自己的名册配方（`permFlags`）。

## 参数约定

所有 Agent 工具的正文参数统一叫 **`prompt`**（配一个 3–5 词的 `description` 作标题；
`task` 是兼容别名）。新加 Agent 请沿用，别另起名字。

## 兼容性

`dsh.compatibility` 声明为 `>=0.1.5`。
本插件**不依赖** `settings.register()` / `installSection()` 这类会随宿主版本变动的设置 API ——
它只用 `ctx.tools.register` / `ctx.tools.guard` / `ctx.subprocess` / `ctx.webServer.register`。

> 背景：DSH 0.1.7 移除了旧的 settings 注册入口，凡是用到它的插件会在启动时抛
> `TypeError: ... is not a function`。本插件从设计上避开了这条路径。

## 安全声明（请务必读）

**这个插件的本质是：按你的配置，在本机启动外部程序并执行任务。**

它不是沙箱，也不是审核者。请清楚以下几点：

### 1. 它具备"在本机执行程序"的能力

被选为默认执行体后，插件会启动对应的 CLI 进程，并**继承你的用户权限**（能读写你能读写的文件）。
所以"把任务交给哪个 Agent"这件事，等同于"允许哪个程序在你这台机器上干活"。

### 2. 三条可能的滥用面

| 面 | 说明 |
|---|---|
| **名册文件** | `$DSH_HOME/agent-picker.agents.json` 里 `launch.bin` / `launch.argv` 写什么，插件就执行什么。**拿到该文件写权限的人，等于拿到本机执行权。** |
| **约定目录** | `$DSH_HOME/agent-picker.d/*.agent.json` 是**任何程序都能丢文件进来**的落地目录。它带来的正是"装了就自动出现"的便利，也是它的风险面。 |
| **自动探测** | 插件会在 `PATH`、`cliBinDir`、`~/.local/bin` 里找已知名字的命令（`codex` / `claude` / `aider` …）。**同目录下放一个同名恶意程序，就会被选中。** |

### 3. 插件做了什么缓解

- 启动子进程时**剥离敏感环境变量**：名字里含 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` 一类的一律不传，
  且**所有 `DSH_*` 一律不传**（避免把会话身份交给外部进程）。
- 每个 Agent 都有**超时上限**（默认 15 分钟，可按成员覆盖）与**输出上限**（默认 200,000 字节），
  防止一个挂住的子进程拖垮会话。
- 缺环境变量或需要常驻服务的 Agent，会标为"待配置"而**不是**静默执行。

### 4. 你的责任

- 用之前**看一眼** `agent-picker.agents.json` 和 `agent-picker.d/` 里到底有什么
- **只安装你信任的 Agent CLI**。插件不审核、不签名、也不沙箱化它们
- 不要把名册文件或约定目录**共享给不可信的人或程序**
- 若你在多用户机器上使用，注意 `$DSH_HOME` 的目录权限

> 一句话：**你交给它多少个 Agent，就等于打开了多少条本机执行通道。** 请按这个前提使用。

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

