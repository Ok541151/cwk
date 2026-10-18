// agent-picker 的内置发现表 + 探测函数（独立模块，先在本机实测）
//
// 关键点（都是实测结论，不是猜测）：
//  1. 必须在 PATH 上找，且【按 PATHEXT 顺序】找 —— Windows 的 npm 包会同时留下
//     无扩展名的 POSIX shell 脚本和 .cmd 两个文件；无扩展名那个 Windows 执行不了
//     （实测 C:\AgentTools\cli\claude 头部是 `#!/bin/sh`）。
//  2. 探测结果只说明"命令可用"，不代表"能跑"：端点/密钥是那个 agent 自己的事。
//  3. 只对【参数形态确定】的 agent 生成默认 argv。形态不确定的不猜，标 needsConfig。

import { existsSync, statSync, accessSync, constants } from 'node:fs'
import { dirname, extname, join, isAbsolute, resolve } from 'node:path'

/** 宿主 resolver 的同款语义：只试 PATHEXT（默认 .COM;.EXE;.BAT;.CMD）。 */
export function pathExts(env) {
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
    desc: '会自己敲命令、装依赖、跑构建的终端 agent，把每一步都记下来再汇报。',
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
    desc: 'Anthropic 的编程 agent，习惯先把相关文件读完再动手，大范围改代码一致性最好。',
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
    desc: '最擅长按格式交东西：要表格给表格、要 JSON 给 JSON，适合批量整理与字段提取。',
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
    desc: '眼里只有代码的小步改选手，每改一处就是一次可回退的 git 提交；不会上网/看图/读文档。',
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
    desc: '可以给它加工具（上网、操作浏览器、读写文件）的通用助手，还能把流程存成"配方"复用。',
    argv: ['run', '-t', '{task}'],
    needsEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'OPENAI_HOST'],
  },
  {
    id: 'hermes', name: 'Hermes', kind: 'task',
    discover: ['hermes'],
    desc: '记性最好的一个：把做过的事攒成技能库，同类活儿第二次会明显更顺，代价是慢。',
    argv: ['-z', '{task}'],
    needsEnv: [],
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'task',
    discover: ['gemini'],
    desc: 'Google 官方编程助手，Qwen Code 就是从它改出来的，两者能力高度重叠。',
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
    desc: '跑在你自己显卡上的本地模型，不联网、不花钱、断网也能用；模型名默认 qwen3:4b。',
    argv: ['run', 'qwen3:4b', '{task}'],
    needsEnv: [],
    needsService: '需要本机 ollama 服务在运行',
  },
  {
    id: 'opencode', name: 'opencode', kind: 'task',
    discover: ['opencode'],
    desc: '开源的终端编程 agent，TUI 为主，也支持一次性执行。',
    argv: ['run', '{task}'],
    needsEnv: [],
  },
  {
    id: 'crush', name: 'Crush', kind: 'task',
    discover: ['crush'],
    desc: 'Charm 出的终端 AI 编程助手，界面风格偏华丽，同样支持非交互调用。',
    argv: ['run', '{task}'],
    needsEnv: [],
  },
  {
    id: 'cursor', name: 'Cursor CLI', kind: 'task',
    discover: ['cursor-agent', 'cursor'],
    desc: 'Cursor 官方的终端 agent，和编辑器共享同一套代码理解。',
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
    desc: 'Moonshot 的命令行编程 agent，中文场景表现好。',
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
    desc: '字节跳动出的 AI 编程工具，有终端形态。',
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
    desc: 'Factory 出的软件工程 agent，偏自动化流水线。',
    needsEnv: [],
  },
  {
    id: 'auggie', name: 'Augment Code', kind: 'task',
    discover: ['auggie'],
    desc: 'Augment 的命令行 agent，强项是在大代码库里定位相关上下文。',
    needsEnv: [],
  },
  {
    id: 'openhands', name: 'OpenHands', kind: 'task',
    discover: ['openhands'],
    desc: '开源自主 agent 平台的命令行入口，能在沙箱里跑完整任务。',
    needsEnv: [],
  },
  {
    id: 'cline', name: 'Cline', kind: 'task',
    discover: ['cline'],
    desc: '开源的编程 agent，原本是 VS Code 插件，也有命令行。',
    needsEnv: [],
  },
  {
    id: 'windsurf', name: 'Windsurf', kind: 'task',
    discover: ['windsurf'],
    desc: 'Codeium 出的 AI 编程环境，终端形态。',
    needsEnv: [],
  },
  {
    id: 'zcode', name: 'ZCode', kind: 'task',
    discover: ['zcode'],
    desc: '终端编程 agent，支持多会话。',
    needsEnv: [],
  },
  {
    id: 'qoder', name: 'Qoder', kind: 'task',
    discover: ['qoder'],
    desc: '面向真实工程任务的编程 agent。',
    needsEnv: [],
  },
  {
    id: 'codebuddy', name: 'CodeBuddy', kind: 'task',
    discover: ['codebuddy'],
    desc: '腾讯出的 AI 编程助手，有命令行入口。',
    needsEnv: [],
  },
  {
    id: 'grok', name: 'Grok CLI', kind: 'task',
    discover: ['grok', 'grok-cli'],
    desc: 'xAI 的命令行 agent。',
    needsEnv: [],
  },
  {
    id: 'openclaw', name: 'OpenClaw', kind: 'chat',
    discover: ['openclaw'],
    desc: '常驻在本机的网关式助手，有网页控制台、记得住上下文、能接别的频道。',
    needsEnv: [],
  },
  {
    id: 'roo', name: 'Roo Code', kind: 'task',
    discover: ['roo'],
    desc: 'Cline 的分支，同样是编辑器 agent，有命令行版本。',
    needsEnv: [],
  },
  {
    id: 'kilo', name: 'Kilo Code', kind: 'task',
    discover: ['kilo'],
    desc: 'Cline / Roo 系的开源编程 agent。',
    needsEnv: [],
  },
  {
    id: 'codewhale', name: 'CodeWhale', kind: 'task',
    discover: ['codewhale'],
    desc: '终端编程 agent。',
    needsEnv: [],
  },
  {
    id: 'pi', name: 'Pi', kind: 'task',
    discover: ['pi'],
    desc: '轻量的终端 agent。',
    needsEnv: [],
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', kind: 'task',
    discover: ['workbuddy'],
    desc: '面向工作流自动化的 agent。',
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
export function discoverAgents(env = process.env, extraDirs = []) {
  const dirs = (Array.isArray(extraDirs) ? extraDirs : [extraDirs]).filter((d) => typeof d === 'string' && d !== '')
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
