// agent-picker 的内置发现表 + 探测函数（独立模块，先在本机实测）
//
// 关键点（都是实测结论，不是猜测）：
//  1. 必须在 PATH 上找，且【按 PATHEXT 顺序】找 —— Windows 的 npm 包会同时留下
//     无扩展名的 POSIX shell 脚本和 .cmd 两个文件；无扩展名那个 Windows 执行不了
//     （实测 C:\AgentTools\cli\claude 头部是 `#!/bin/sh`）。
//  2. 探测结果只说明"命令可用"，不代表"能跑"：端点/密钥是那个 agent 自己的事。
//  3. 只对【参数形态确定】的 agent 生成默认 argv。形态不确定的不猜，标 needsConfig。

import { existsSync, statSync, accessSync, constants, readdirSync } from 'node:fs'
import { dirname, extname, join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * 宿主 resolver 的同款语义：只试 PATHEXT（默认 .COM;.EXE;.BAT;.CMD）。
 *
 * `platform` 参数只为可测试。POSIX 上没有 PATHEXT 这回事 —— 命令就是裸名。
 * 老实现无条件套用 Windows 扩展名表，于是 macOS/Linux 上
 * `resolveOnPath('claude')` 只会去找 `claude.COM` / `claude.EXE` …
 * **永远找不到真正的 ./claude**，探测结果恒为空。
 */
export function pathExts(env, platform = process.platform) {
  if (platform !== 'win32') return ['']
  const raw = (env && env.PATHEXT) || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').map((s) => s.trim()).filter(Boolean)
}

/**
 * 在一个【指定目录】里解析命令，返回绝对路径或 null。
 *
 * 为什么需要它：实测本机的用户 PATH **不含** `~/dsh-clis/bin`（托管包装器在这）
 * 也**不含** `~/.local/bin`（aider 在这）。只扫 PATH 就永远找不到 codex 和 aider
 * —— 而它们恰好是最容易调的两个。所以探测顺序是：PATH → cliBinDir。
 */
export function resolveInDir(command, directory, env = process.env) {
  if (!command || !directory) return null
  const exts = extname(command) === '' ? pathExts(env) : ['']
  for (const ext of exts) {
    const cand = resolve(directory, command + ext)
    try {
      if (statSync(cand).isFile()) { accessSync(cand, constants.X_OK); return cand }
    } catch {}
  }
  return null
}

/** 在 PATH 上解析一个命令，返回绝对路径或 null。语义与 dsh-subprocess-local 一致。 */
export function resolveOnPath(command, env = process.env) {
  if (!command) return null
  if (isAbsolute(command)) {
    try { if (statSync(command).isFile()) { accessSync(command, constants.X_OK); return command } } catch {}
    return null
  }
  const exts = extname(command) === '' ? pathExts(env) : ['']
  const dirs = String(env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = resolve(d, command + ext)
      try {
        if (statSync(cand).isFile()) { accessSync(cand, constants.X_OK); return cand }
      } catch {}
    }
  }
  return null
}

/**
 * 内置表。
 *  discover : 在 PATH 上尝试的名字（按顺序）
 *  argv     : 参数模板；只对形态确定的 agent 给
 *  permFlags: 把权限档翻译成这个 CLI 自己的参数（`{permflags}` 处展开成多个参数）
 *  defaultPermFlags : 没指定权限档时用这组 —— 必须是"非交互"的，否则无头执行会卡在审批上
 *  needsEnv : 这个 agent 要工作，需要哪些环境变量（用于界面提示"待配置"）
 *  needsService : 需要本机有常驻服务
 */
export const BUILTIN_AGENTS = [

  // ---- 有启动配方（可直接调用） ----
  {
    id: 'codex', name: 'Codex', kind: 'task',
    discover: ['codex'],
    // ChatGPT 桌面版把 CLI 装这里（bin\<哈希>\codex.exe），不在 PATH 上。
    // 真机反馈：另一台电脑只装了桌面版，于是 codex 一直探测不到。
    deep: ['%LOCALAPPDATA%/OpenAI/Codex/bin'],
    desc: '会自己敲命令、装依赖、跑构建，并把每一步记下来汇报的终端 agent。',
    // codex exec 默认 -s read-only（写不了文件），所以必须显式给沙箱档位。
    argv: ['exec', '--skip-git-repo-check', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['-s', 'read-only'],
      'workspace-write': ['-s', 'workspace-write'],
      'danger-full-access': ['-s', 'danger-full-access'],
    },
    defaultPermFlags: ['-s', 'workspace-write'],
    needsEnv: [],
  },
  {
    id: 'claude', name: 'Claude Code', kind: 'task',
    discover: ['claude'],
    desc: 'Anthropic 的编程 agent，改大范围代码时前后一致性最好。',
    // -p 是 print（非交互）模式；没有 permission-mode 时工具调用会被拒或卡住。
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--permission-mode', 'plan'],
      'workspace-write': ['--permission-mode', 'acceptEdits'],
      'danger-full-access': ['--permission-mode', 'bypassPermissions'],
    },
    defaultPermFlags: ['--permission-mode', 'acceptEdits'],
    needsEnv: [],
  },
  {
    id: 'qwen', name: 'Qwen Code', kind: 'task',
    discover: ['qwen'],
    desc: '从 Gemini CLI 改出来的开源编程助手，最擅长按要求输出固定格式。',
    // headless 下 --approval-mode default 会等审批等到超时，必须显式给。
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--approval-mode', 'plan'],
      'workspace-write': ['--approval-mode', 'yolo'],
      'danger-full-access': ['--approval-mode', 'yolo'],
    },
    defaultPermFlags: ['--approval-mode', 'yolo'],
    needsEnv: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'aider', name: 'Aider', kind: 'task',
    discover: ['aider'],
    desc: '只在代码里小步改，每改一处就是一次可回滚的 git 提交。',
    // 不加 --yes-always 时 aider 会停在追问上，无头执行会超时。
    argv: ['{permflags}', '--message', '{task}'],
    permFlags: {
      'read-only': ['--dry-run'],
      'workspace-write': ['--yes-always'],
      'danger-full-access': ['--yes-always'],
    },
    defaultPermFlags: ['--yes-always'],
    needsEnv: ['OPENAI_API_KEY', 'OPENAI_API_BASE'],
  },
  {
    id: 'goose', name: 'Goose', kind: 'task',
    discover: ['goose'],
    desc: '能把上网、读文件这些动作串成可复用「配方」的通用助手。',
    argv: ['run', '-t', '{task}'],
    needsEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'OPENAI_HOST'],
  },
  {
    id: 'hermes', name: 'Hermes', kind: 'task',
    discover: ['hermes'],
    desc: '会把做过的事攒成技能库，同类活第二次明显更顺。',
    argv: ['-z', '{task}'],
    needsEnv: [],
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'task',
    discover: ['gemini'],
    desc: 'Google 的终端编程助手，和 Qwen Code 是同一套底子。',
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--approval-mode', 'plan'],
      'workspace-write': ['--approval-mode', 'yolo'],
      'danger-full-access': ['--approval-mode', 'yolo'],
    },
    defaultPermFlags: ['--approval-mode', 'yolo'],
    needsEnv: ['GEMINI_API_KEY'],
    needsService: '需要中间层（如 LiteLLM）把 Gemini 协议转成你的端点',
  },
  {
    id: 'ollama', name: 'Ollama（本地）', kind: 'chat',
    discover: ['ollama'],
    desc: '在本机显卡上跑开源模型，断网也能用。',
    argv: ['run', 'qwen3:4b', '{task}'],
    needsEnv: [],
    needsService: '需要本机 ollama 服务在运行',
  },
  {
    id: 'opencode', name: 'opencode', kind: 'task',
    discover: ['opencode'],
    desc: '开源的终端编程 agent，以 TUI 为主，也支持一次性执行。',
    argv: ['run', '{task}'],
    needsEnv: [],
  },
  {
    id: 'crush', name: 'Crush', kind: 'task',
    discover: ['crush'],
    // 只识别：Charm 的 crush 目前有一个未关闭的 issue 在请求"非交互批处理模式"
    // （charmbracelet/crush#1030），说明 `crush run <任务>` 这条路当时还不存在。
    // 猜一个不存在的子命令 = 用户点了必报错，所以宁可不给。
    desc: 'Charm 出的终端编程助手，界面风格最华丽。',
    needsEnv: [],
  },
  {
    id: 'cursor', name: 'Cursor CLI', kind: 'task',
    discover: ['cursor-agent', 'cursor'],
    desc: 'Cursor 编辑器的终端 agent，和编辑器共享同一套代码理解。',
    // 参数取自 cursor-agent 的 --help（2026-06 版第三方实测记录）：
    //   -p/--print 非交互；--trust 跳过工作区信任提示（headless 必需，否则会等输入）
    //   --force 自动执行并应用改动（deny 名单仍然生效）；--mode plan 只读不改
    argv: ['-p', '{permflags}', '--trust', '{task}'],
    permFlags: {
      'read-only': ['--mode', 'plan'],
      'workspace-write': ['--force'],
      'danger-full-access': ['--force'],
    },
    defaultPermFlags: ['--force'],
    needsEnv: [],
  },
  {
    id: 'kimi', name: 'Kimi', kind: 'task',
    discover: ['kimi'],
    desc: '月之暗面的命令行编程助手，中文长上下文见长。',
    // 官方文档：-p/--prompt 单次非交互，不开 TUI。
    // 注意 --prompt **不能**和 --yolo/--auto/--plan 同用 —— 非交互模式本身就
    // 按 auto 权限跑，所以这里不带 {permflags}。
    argv: ['-p', '{task}'],
    needsEnv: [],
  },


  // ---- 只识别、不自动调用（启动参数未验证，避免"显示了却调不动"） ----
  {
    id: 'copilot', name: 'GitHub Copilot CLI', kind: 'task',
    discover: ['copilot'],
    desc: 'GitHub 官方的命令行 Copilot，和 GitHub 生态贴得最近。',
    needsEnv: [],
  },
  {
    id: 'trae', name: 'Trae', kind: 'task',
    discover: ['trae', 'trae-cli', 'traecode'],
    desc: '字节跳动的 AI 编程工具，有独立 IDE 也有终端形态。',
    needsEnv: [],
  },
  {
    id: 'amp', name: 'Amp', kind: 'task',
    discover: ['amp'],
    desc: 'Sourcegraph 的终端 coding agent，主打多文件重构。',
    needsEnv: [],
  },
  {
    id: 'droid', name: 'Droid', kind: 'task',
    discover: ['droid'],
    desc: 'Factory 的软件工程 agent，偏自动化流水线。',
    needsEnv: [],
  },
  {
    id: 'auggie', name: 'Augment Code', kind: 'task',
    discover: ['auggie'],
    desc: 'Augment 的命令行 agent，强项是在大代码库里定位上下文。',
    needsEnv: [],
  },
  {
    id: 'openhands', name: 'OpenHands', kind: 'task',
    discover: ['openhands'],
    desc: '开源的自主 agent，能在沙箱里从零跑完整个任务。',
    needsEnv: [],
  },
  {
    id: 'cline', name: 'Cline', kind: 'task',
    discover: ['cline'],
    desc: '开源的编程 agent，从 VS Code 插件起步，也有命令行。',
    needsEnv: [],
  },
  {
    id: 'windsurf', name: 'Windsurf', kind: 'task',
    discover: ['windsurf'],
    desc: 'Codeium 的 AI 编程环境，主打流程连贯。',
    needsEnv: [],
  },
  {
    id: 'qoder', name: 'Qoder', kind: 'task',
    discover: ['qoder'],
    desc: '阿里出的 AI 编程工具，通义灵码已并入它。',
    needsEnv: [],
  },
  {
    id: 'codebuddy', name: 'CodeBuddy', kind: 'task',
    discover: ['codebuddy'],
    desc: '腾讯的 AI 编程助手，有命令行和 IDE 插件两种形态。',
    needsEnv: [],
  },
  {
    id: 'grok', name: 'Grok CLI', kind: 'task',
    discover: ['grok', 'grok-cli'],
    desc: 'xAI 的命令行 agent，能直接执行终端命令。',
    needsEnv: [],
  },
  {
    id: 'openclaw', name: 'OpenClaw', kind: 'chat',
    discover: ['openclaw'],
    desc: '常驻本机的网关式助手，有网页控制台，记得住上下文。',
    needsEnv: [],
  },
  {
    id: 'kilo', name: 'Kilo Code', kind: 'task',
    discover: ['kilo'],
    desc: 'Cline / Roo 系的开源编程 agent。',
    needsEnv: [],
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', kind: 'task',
    discover: ['workbuddy'],
    desc: '面向工作流自动化的助手，偏工具调用而不是写代码。',
    needsEnv: [],
  },

  {
    id: 'codegeex', name: 'CodeGeeX', kind: 'task',
    discover: ['codegeex'],
    desc: '智谱的编程助手，有 IDE 插件也有命令行形态。',
    // 只识别、不给配方：非交互参数没核实过，不猜。
    needsEnv: [],
  },
  {
    id: 'plandex', name: 'Plandex', kind: 'task',
    discover: ['plandex'],
    desc: '把大任务拆成沙箱里逐步执行的终端 agent。',
    // 只识别、不给配方：非交互参数没核实过，不猜。
    needsEnv: [],
  },
  {
    id: 'codebuff', name: 'CodeBuff', kind: 'task',
    discover: ['codebuff'],
    desc: '开源的终端编程 agent，直接在项目里改文件。',
    // 只识别、不给配方：非交互参数没核实过，不猜。
    needsEnv: [],
  },
  {
    id: 'gptme', name: 'gptme', kind: 'task',
    discover: ['gptme'],
    desc: '开源的终端助手，能读写文件、执行 shell 命令。',
    // 只识别、不给配方：非交互参数没核实过，不猜。
    needsEnv: [],
  },
  {
    id: 'interpreter', name: 'Open Interpreter', kind: 'task',
    discover: ['interpreter'],
    desc: '用日常话指挥它在本机执行任务的终端工具。',
    // 只识别、不给配方：非交互参数没核实过，不猜。
    needsEnv: [],
  },
]

/**
 * 探测本机哪些 agent 可用。
 *
 * 探测顺序（每一层都可能有，先命中先用）：
 *   ① PATH                      —— 系统级安装的标准 CLI
 *   ② extraDirs（cliBinDir 等） —— 托管的包装器目录；实测它**不在** PATH 上
 *
 * @param env       环境（决定 PATH 与"缺哪些环境变量"）
 * @param extraDirs 额外探测目录，按顺序
 * @returns [{ id, name, kind, found, exe, exeFrom, argv, missingEnv, ready, needsService }]
 */
/**
 * 默认要额外搜的目录 —— 都是"不放 PATH 上"的常见安装位置。
 *
 * 真机反馈（2026-10-20，另一台电脑）：`claude` 和 `qwen` 都用 `npm i -g` 装，
 * 落在 %APPDATA%\npm 里。那个目录**通常**在用户 PATH 上，但 DSH 桌面版从图形界面
 * 启动时拿到的 PATH 可能不含它 —— 结果插件完全探测不到，用户看到的还是旧名册里
 * 那行"借用别人的入口"。所以这里主动补上。
 */
export function defaultSearchDirs(env = process.env) {
  const out = []
  if (env.APPDATA) out.push(join(env.APPDATA, 'npm'))          // Windows npm 全局
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'npm')) // 少数安装器用这个
  out.push(join(homedir(), '.npm-global', 'bin'))               // POSIX npm 全局
  out.push(join(homedir(), '.local', 'bin'))                    // pipx / uv
  return out
}

/** `%LOCALAPPDATA%/OpenAI/Codex/bin` 这种模板 → 实际路径；缺变量就返回 null。 */
export function expandEnvPath(template, env = process.env) {
  let missing = false
  const p = String(template).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name) => {
    const v = env[name]
    if (typeof v !== 'string' || v === '') { missing = true; return '' }
    return v
  })
  return missing ? null : p
}

/**
 * 在一个"里面还有一层哈希/版本子目录"的目录里找命令。
 *
 * 为什么要它：ChatGPT 桌面版把 Codex CLI 装在
 *   %LOCALAPPDATA%\OpenAI\Codex\bin\<一串哈希>\codex.exe
 * —— 既不在 PATH 上，也不在某个固定目录里，每更新一次哈希名还会变。
 * 只扫一层子目录，按目录修改时间从新到旧试。
 */
export function resolveInDeepDir(commands, baseDir, env = process.env) {
  if (!baseDir) return null
  let subs = []
  try {
    subs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = join(baseDir, d.name)
        let mtime = 0
        try { mtime = statSync(full).mtimeMs } catch { /* ignore */ }
        return { full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return null
  }
  const names = Array.isArray(commands) ? commands : [commands]
  for (const s of subs) {
    for (const c of names) {
      const hit = resolveInDir(c, s.full, env)
      if (hit) return hit
    }
  }
  return null
}

export function discoverAgents(env = process.env, extraDirs = []) {
  const dirs = (Array.isArray(extraDirs) ? extraDirs : [extraDirs])
    .filter((d) => typeof d === 'string' && d !== '')
    .concat(defaultSearchDirs(env))
    .filter((d, i, arr) => arr.indexOf(d) === i)
  const rows = []
  for (const spec of BUILTIN_AGENTS) {
    let exe = null
    let exeFrom = null
    for (const c of spec.discover) {
      exe = resolveOnPath(c, env)
      if (exe) { exeFrom = 'PATH'; break }
    }
    if (!exe) {
      for (const c of spec.discover) {
        for (const d of dirs) {
          exe = resolveInDir(c, d, env)
          if (exe) { exeFrom = 'cliDir'; break }
        }
        if (exe) break
      }
    }
    // 藏在别的程序安装目录里的一层子目录（例：ChatGPT 桌面版的 Codex）
    if (!exe && Array.isArray(spec.deep)) {
      for (const tpl of spec.deep) {
        const base = expandEnvPath(tpl, env)
        if (!base) continue
        exe = resolveInDeepDir(spec.discover, base, env)
        if (exe) { exeFrom = 'deep'; break }
      }
    }
    const missingEnv = (spec.needsEnv || []).filter((k) => !env[k])
    const hasArgv = Array.isArray(spec.argv) && spec.argv.length > 0
    rows.push({
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      desc: spec.desc || '',
      found: !!exe,
      exe,
      exeFrom,
      argv: hasArgv ? spec.argv : null,
      // 权限档 → 这个 CLI 自己的参数。没有这两项就表示"这个 CLI 没有权限开关"。
      permFlags: spec.permFlags || null,
      defaultPermFlags: spec.defaultPermFlags || null,
      missingEnv,
      needsService: spec.needsService || null,
      // "能用"：找到了 + 有明确 argv + 缺的环境变量为空 + 没有必须先起的服务
      ready: !!exe && hasArgv && missingEnv.length === 0 && !spec.needsService,
    })
  }
  return rows
}
