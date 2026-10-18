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
  {
    id: 'codex', name: 'Codex', kind: 'task',
    discover: ['codex'],
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
    // headless 下 --approval-mode default 会等审批等到超时，必须显式给。
    // 只用 plan / yolo 两个取值：这两个是上游实测确认支持的。
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--approval-mode', 'plan'],
      'workspace-write': ['--approval-mode', 'yolo'],
      'danger-full-access': ['--approval-mode', 'yolo'],
    },
    defaultPermFlags: ['--approval-mode', 'yolo'],
    needsEnv: ['DEEPSEEK_API_KEY'],   // 它自己读 ~/.qwen/.env
  },
  {
    id: 'aider', name: 'Aider', kind: 'task',
    discover: ['aider'],
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
    argv: ['run', '-t', '{task}'],
    needsEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'OPENAI_HOST'],
  },
  {
    id: 'hermes', name: 'Hermes', kind: 'task',
    discover: ['hermes'],
    argv: ['-z', '{task}'],
    needsEnv: [],
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'task',
    discover: ['gemini'],
    argv: ['-p', '{task}'],
    needsEnv: ['GEMINI_API_KEY'],
    needsService: '需要中间层（如 LiteLLM）把 Gemini 协议转成你的端点',
  },
  {
    id: 'ollama', name: '通义千问（本地）', kind: 'chat',
    discover: ['ollama'],
    // 模型名是这条配方的默认值；本机装的模型不同时，用名册或约定目录覆盖。
    argv: ['run', 'qwen3:4b', '{task}'],
    needsEnv: [],
    needsService: '需要本机 ollama 服务在运行',
  },
  {
    id: 'opencode', name: 'opencode', kind: 'task',
    discover: ['opencode'],
    argv: ['run', '{task}'],
    needsEnv: [],
  },
  {
    id: 'crush', name: 'Crush', kind: 'task',
    discover: ['crush'],
    argv: ['run', '{task}'],
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
