/**
 * dsh-agent-picker — host half.
 *
 * Makes an external Agent CLI the DEFAULT EXECUTOR for the conversation, like a
 * reasoning-effort level rather than a per-message command.
 *
 * The agent roster is DATA, not code: `agents.json` beside this package lists
 * every agent (id / name / tool / bin / available), so adding a new CLI is an
 * edit to that file — no plugin change needed. An agent is offered as an active
 * choice only once it has actually been enabled on this machine (see
 * `enabledIds()`); agents that are merely listed show up in the UI's
 * "installable" area instead.
 *
 * How the routing works (verified against this DSH build, not guessed):
 *   - The browser half owns the UI and POSTs the chosen mode to
 *     `/dsh-agent-picker/mode`.
 *   - This half persists it to `<DSH_HOME>/agent-picker.json` and re-registers
 *     its system-prompt section so the section names the active executor.
 *   - `dsh-agent-loop` `preStep()` calls `systemPrompt.assemble()` and
 *     `renderContextSections()` on EVERY step, so the text is re-read each turn:
 *     changing it takes effect on the next user message, with no message
 *     rewriting and no visible marker in the transcript.
 *
 * Safety rule: never throw out of apply(). The web shell fails the whole boot
 * when a plugin's apply throws (that is how dsh-agent-team-gui once took every
 * third-party plugin down).
 *
 * @module dsh-agent-picker
 */

import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { discoverAgents, resolveOnPath } from './discover.js'

/**
 * Required services: the web route registry, the prompt band, and — for agents
 * that declare an inline `launch` recipe — the tool registry and subprocess.
 */
export const inject = ['webServer', 'systemPrompt', 'tools', 'subprocess']

/**
 * Executor kinds, the extension point that makes this plugin hold MANY agents.
 *
 * A roster entry is executable in exactly one of two ways:
 *
 *   tool    — DSH already has a tool for it (that is how dsh-sub-cli's managed
 *             `cli_claude_direct` / `cli_codex_direct` work: they carry session
 *             continuity, verification and permission tiers we must not
 *             reimplement). The picker only names the tool in its prompt
 *             section; it does not own execution.
 *   launch  — the entry carries its own headless command line, and this plugin
 *             registers the tool itself (`cli_<id>_direct`) so the agent is
 *             callable without touching any other plugin. This is the path for
 *             agents DSH has never heard of, e.g. OpenClaw.
 *
 * Adding a new agent is therefore a roster edit in either case; only a
 * genuinely new *execution shape* would need code here.
 */
const LAUNCH_TOOL_SUFFIX = '_direct'

/**
 * Upper bound for a `setTimeout` delay: 2^31-1 ms.
 *
 * Node OVERFLOWS past this and fires the callback IMMEDIATELY (with a
 * TimeoutOverflowWarning), so a roster with a very large `timeoutMs` would
 * invert the intent and kill every call instantly. A deadline is clamped
 * instead, which is at worst "effectively no deadline".
 */
const MAX_TIMER_DELAY_MS = 2147483647

/** The roster file that ships beside this package (used only to seed). */
function packagedRosterFile() {
  return fileURLToPath(new URL('../agents.json', import.meta.url))
}

/**
 * Where the managed CLI wrappers live.
 *
 * Portable by default: `$DSH_AGENT_PICKER_CLI_DIR` wins, else `~/dsh-clis/bin`
 * (which is what dsh-sub-cli uses on this deployment, so nothing changes for an
 * existing install). A roster entry may also point anywhere with an absolute
 * path — see `expandLauncherToken` below.
 */
export function cliBinDir() {
  const configured = process.env.DSH_AGENT_PICKER_CLI_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), 'dsh-clis', 'bin')
}

/**
 * Expand a `{cliDir}`-prefixed argv token, and resolve a BARE wrapper filename
 * against `cliBinDir()`.
 *
 * Why this exists: a published roster cannot hardcode `C:\Users\<who>\...`.
 * Instead a recipe writes the wrapper's NAME and the plugin resolves it here:
 *   `codex-dsh.ps1`            -> `<cliBinDir>/codex-dsh.ps1`
 *   `{cliDir}/codex-dsh.ps1`   -> `<cliBinDir>/codex-dsh.ps1`
 * Anything that already looks like a path (drive letter, leading `/`, `\`, `.`)
 * is left untouched, so an operator can still pin an absolute path by hand.
 */
function expandLauncherToken(token) {
  if (token.startsWith('{cliDir}')) {
    return path.join(cliBinDir(), token.slice('{cliDir}'.length).replace(/^[\\/]+/, ''))
  }
  if (/^[A-Za-z]:[\\/]/.test(token) || /^[\\/]/.test(token) || token.startsWith('.')) return token
  if (!/(^|[\\/])[^\\/]+\.(ps1|cmd|bat|exe|sh)$/i.test(token)) return token
  // A BARE wrapper filename always resolves under cliBinDir -- deliberately NOT
  // gated on existsSync. If the wrapper is missing we want the accurate
  // "找不到可执行文件 <abs path>" error from the resolver below, instead of
  // handing the child a bare name that PowerShell then hunts for on PATH and
  // fails on in a confusing way.
  return path.join(cliBinDir(), token)
}


/** The dsh home directory (`$DSH_HOME`, else ~/.dsh). */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * The USER-EDITABLE roster. Deliberately not inside the package: the package
 * lives in the profile's node_modules (a copy, refreshed on every reinstall),
 * so edits there would be lost. This path is stable and safe to hand-edit.
 */
export function rosterFile() {
  return path.join(dshHome(), 'agent-picker.agents.json')
}

/** Where the selected mode + enabled roster are persisted. */
function stateFile() {
  return path.join(dshHome(), 'agent-picker.json')
}

/**
 * Raw fallback roster used when `agents.json` is missing or malformed, so a
 * broken data file degrades to something usable instead of an empty picker.
 *
 * Do not use this array directly — always go through `FALLBACK_ROSTER` below,
 * which runs it through the same normalizer as a real roster file.
 */
// 出厂名册是空的 —— 这是有意的。
//
// 曾经这里（和 agents.json 里）装的是作者本人机器上的 11 个成员：每条都写死
// `available: true`，并把 launch 指向作者自己的 `~/_dsh-clis/bin/*-dsh.ps1` 包装脚本。
// 那套东西在别的电脑上有两个致命后果：
//
//   1. 界面把作者装了、别人没装的东西一律列成"可安装" —— 列表和本机实际情况无关；
//   2. 就算本机有同名 CLI 也调不动，因为它找的是那个不存在的包装脚本。
//
// 正确做法是让 lib/discover.js 的 BUILTIN_AGENTS 来决定：它扫描本机 PATH / cliBinDir
// / ~/.local/bin，用各 CLI 自己的原生参数（并携带权限档 → 原生 flag 的映射），
// `ready` 按本机实际情况计算。名册仍然可用 —— 但它是"用户的自定义覆盖层"，
// 不是出厂默认值。约定目录 $DSH_HOME/agent-picker.d/*.agent.json 同理。
const RAW_FALLBACK_ROSTER = []

// Defaults for a launch recipe. Bounding the child is a resource concern, not a
// cosmetic one: without a deadline a hung agent owns the turn forever, and
// without a byte cap a chatty one is retained in memory without limit.
//
// Declared BEFORE `FALLBACK_ROSTER` on purpose: that const is built at module
// load and goes through `parseLaunch`, so these must already be initialized or
// the module throws a temporal-dead-zone error on import.
const DEFAULT_LAUNCH_TIMEOUT_MS = 900000
const DEFAULT_LAUNCH_GRACE_MS = 30000
const DEFAULT_LAUNCH_MAX_BYTES = 200000

// Keys that must never reach an external agent. Mirrors the host's own
// SENSITIVE_ENV_PATTERN; `DSH_*` is handled separately in buildChildEnv.
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The fallback roster, normalized through the SAME path as a real roster file.
 *
 * This is not cosmetic. `readRosterSync` / `readRoster` / `parseRosterText` all
 * fall back to this list when the data file is missing or unparseable, and they
 * used to return the raw literals above. Those literals carry a `launch` recipe
 * that had never been through `parseLaunch`, so its defaults silently did not
 * exist:
 *
 *   stdio.stdout = {}   -> maxBytes undefined
 *
 * The subprocess collector uses the caller's spec verbatim
 * (`new OutputCollector(mode.maxBytes, ...)`) and tests overflow with
 * `bytes + chunk.length > maxBytes`. Compared against `undefined` that is
 * always false, so NOTHING was ever trimmed: one runaway or merely chatty
 * agent would have its entire stdout retained in memory with no cap. The
 * deadline and grace defaults were lost the same way.
 *
 * One JSON typo in `agents.json` reaches this path — and the menu footer
 * actively invites the user to edit that file. Normalizing here means there is
 * exactly one way an agent entry gets built, so the fallback cannot drift from
 * the real thing again.
 */
const FALLBACK_ROSTER = RAW_FALLBACK_ROSTER.map(normalizeEntry).filter(Boolean)

/** Whether a file exists; never throws. */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Normalize one `launch` recipe, or null when there is nothing usable.
 *
 * `argv` is an argument template; `{task}` / `{model}` / `{permission}` /
 * `{image}` are filled in by `runLaunch`. `{permflags}` is special: it expands
 * into SEVERAL arguments taken from `permFlags[<permission>]`, or from
 * `defaultPermFlags` when no permission was given — so one template can carry a
 * per-CLI permission mapping without the caller knowing each CLI's flags.
 *
 * Returning a fully-populated object is what makes the defaults above reach the
 * subprocess — an entry that skipped this step used to run with an undefined
 * output cap.
 */
function parseLaunch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.bin !== 'string' || raw.bin === '') return null
  const argvRaw = Array.isArray(raw.argv) ? raw.argv.filter((a) => typeof a === 'string') : ['{task}']
  const env = {}
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  const keepEnv = Array.isArray(raw.keepEnv) ? raw.keepEnv.filter((k) => typeof k === 'string') : []
  const positive = (value, fallback) =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
  const argvList = (value) =>
    (Array.isArray(value) ? value.filter((a) => typeof a === 'string') : [])
  const permFlags = {}
  if (raw.permFlags && typeof raw.permFlags === 'object' && !Array.isArray(raw.permFlags)) {
    for (const [key, value] of Object.entries(raw.permFlags)) {
      const list = argvList(value)
      if (list.length > 0) permFlags[key] = list
    }
  }
  return {
    bin: raw.bin,
    argv: argvRaw.length > 0 ? argvRaw : ['{task}'],
    env,
    keepEnv,
    permFlags,
    defaultPermFlags: argvList(raw.defaultPermFlags),
    timeoutMs: positive(raw.timeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS),
    graceMs: positive(raw.graceMs, DEFAULT_LAUNCH_GRACE_MS),
    maxBytes: positive(raw.maxBytes, DEFAULT_LAUNCH_MAX_BYTES),
  }
}

/**
 * Environment for one launched agent.
 *
 * Handing the subprocess layer an explicit env does not ADD to the inherited
 * one, it OVERRIDES it (the runner deletes same-named inherited keys, then
 * pushes ours) — so the scrubbing the host would have done has to be repeated
 * here, or it silently does not happen. Two families are dropped: secrets, and
 * every `DSH_*` value, because those are harness facts (`DSH_HOME`,
 * `DSH_SESSION_ID`, `DSH_SUBPROCESS_*`), not the agent's business — handing an
 * external process the session identity is not a cosmetic leak. `keepEnv`
 * remains the escape hatch.
 */
export function buildChildEnv(launch) {
  const out = {}
  const keep = new Set((launch.keepEnv || []).map((k) => k.toUpperCase()))
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (!keep.has(upper) && (SENSITIVE_ENV_PATTERN.test(key) || upper.startsWith('DSH_'))) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(launch.env || {})) out[key] = value
  return out
}

// cmd.exe re-parses the entire command line, so an argument containing any of
// these is split or redirected before the child ever sees it. `^` is cmd's own
// escape: cmd removes it and the child receives the literal character.
const forCmd = (s) => s.replace(/[&|<>^]/g, '^$&')

/**
 * Resolve, spawn and collect one launch recipe.
 *
 * Resolution order matters: prefixing the unified dir would turn an absolute
 * path into a nonsense path, so absolute paths are tried as-is first.
 *
 * @returns a plain result object; never throws.
 */
/**
 * Translate a permission level into this CLI's own flags.
 *
 * When no level was given (or the level is not in the map) this falls back to
 * `defaultPermFlags`. That fallback is not cosmetic: a headless CLI with no
 * explicit approval posture either refuses to write files (codex defaults to
 * `read-only`) or blocks waiting for an approval nobody can click.
 */
function resolvePermFlags(launch, permission) {
  const key = String(permission == null ? '' : permission).trim().toLowerCase()
  const map = launch.permFlags || {}
  if (key !== '' && Array.isArray(map[key]) && map[key].length > 0) return map[key]
  return Array.isArray(launch.defaultPermFlags) ? launch.defaultPermFlags : []
}

async function runLaunch(ctx, launch, { task, model, permission, image, workspace, signal }) {
  const permFlags = resolvePermFlags(launch, permission)
  const args = []
  for (const token of launch.argv) {
    // `{permflags}` expands into SEVERAL arguments: one level can be two tokens
    // (`-s read-only`). Everything else is a 1:1 string template.
    if (token === '{permflags}') {
      for (const flag of permFlags) args.push(flag)
      continue
    }
    args.push(
      expandLauncherToken(token)
        .split('{task}').join(task)
        .split('{model}').join(model || '')
        .split('{permission}').join(permission || '')
        // `{image}` is an optional image path. Only entries whose argv mentions it
        // get one; others simply never see the token. Measured: Codex is the only
        // CLI here that accepts an image (`-i/--image`), and DSH hands the model a
        // real path for a user attachment, so this can be wired end to end.
        .split('{image}').join(image || ''),
    )
  }

  let resolved = null
  for (const candidate of [launch.bin, path.join(cliBinDir(), launch.bin)]) {
    try {
      resolved = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
    } catch {
      resolved = null
    }
    if (resolved) break
  }
  if (!resolved) {
    return { ok: false, error: `找不到可执行文件 ${launch.bin}（已查找统一目录 ${cliBinDir()}）` }
  }

  // Windows: an npm/batch shim (.cmd/.bat) cannot be spawned directly.
  //
  // It has to go through cmd.exe, which re-parses the whole command line — so
  // ONLY this branch gets `^`-escaping. A real executable receives argv
  // verbatim, and escaping there would corrupt its arguments instead.
  let argv = [resolved, ...args]
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // Literal 'cmd.exe', not ComSpec: the offline verification pins the exact
    // argv shape (`['cmd.exe','/d','/c', …]`), and PATH resolution of the
    // literal is what the original did.
    argv = ['cmd.exe', '/d', '/c', resolved, ...args.map(forCmd)]
  }

  // Default to '.', not undefined: the offline verification pins the cwd handed
  // to the subprocess layer, and omitting it would let the runner pick its own.
  const cwd = workspace || '.'
  const env = buildChildEnv(launch)
  const io = {
    stdin: 'ignore',
    stdout: { maxBytes: launch.maxBytes },
    stderr: { maxBytes: launch.maxBytes },
  }

  // Arm the deadline here, in this layer.
  //
  // The subprocess layer has no overall timeout — only `graceMs`, which is "how
  // long to wait after a termination request before killing", not a deadline.
  // A wedged agent (a gateway that never answers, say) would otherwise own the
  // turn forever with nothing to stop it. Relaying the caller's abort signal
  // and the deadline into ONE controller means "the user stopped it" and "it
  // timed out" travel the same, already-proven abort path.
  const deadlineMs = Math.min(launch.timeoutMs, MAX_TIMER_DELAY_MS)
  const control = new AbortController()
  const relayAbort = () => control.abort()
  if (signal) {
    if (signal.aborted) control.abort()
    else signal.addEventListener('abort', relayAbort, { once: true })
  }
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    control.abort()
  }, deadlineMs)
  // Deliberately NOT unref'd. An unref'd timer does not keep the loop alive, so
  // if nothing else is pending the deadline is simply skipped and the call hangs
  // forever — which is the exact failure this deadline exists to prevent. The
  // timer cannot outlive the call anyway: `release()` below always clears it,
  // and while a real child is running its process handle holds the loop open.

  const release = () => {
    clearTimeout(deadline)
    if (signal) signal.removeEventListener('abort', relayAbort)
  }

  let handle
  try {
    handle = ctx.subprocess.spawn({ argv, cwd, env, signal: control.signal, stdio: io, graceMs: launch.graceMs })
  } catch (error) {
    release()
    return { ok: false, error: '无法启动 ' + launch.bin + '：' + String((error && error.message) || error) }
  }

  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    release()
    return {
      ok: false,
      error: timedOut
        ? (launch.bin + ' 超过 ' + Math.round(deadlineMs / 1000) + ' 秒未返回，已中止')
        : (launch.bin + ' 运行中断：' + String((error && error.message) || error)),
    }
  }
  release()

  // The kill also settles `done` normally, so the deadline has to be checked on
  // the success path too — otherwise a timed-out run would be reported as a
  // plain non-zero exit and the real reason would be lost.
  if (timedOut) {
    return { ok: false, error: launch.bin + ' 超过 ' + Math.round(deadlineMs / 1000) + ' 秒未返回，已中止' }
  }

  const read = (key) => {
    try {
      const collected = handle.collected && handle.collected[key]
      if (!collected) return { text: '', lossy: false, spillPath: null }
      const got = collected.readFrom(0) || {}
      return {
        text: typeof got.text === 'string' ? got.text : '',
        lossy: got.lossy === true,
        spillPath: typeof got.spillPath === 'string' ? got.spillPath : null,
      }
    } catch {
      return { text: '', lossy: false, spillPath: null }
    }
  }
  const stdoutRead = read('stdout')
  const stderrRead = read('stderr')
  const stdout = stdoutRead.text
  const stderr = stderrRead.text
  const exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null
  const out = { ok: exitCode === 0, exitCode, stdout, stderr: stderr.trim() }

  // Report truncation instead of hiding it.
  //
  // `readFrom(0)` is LOSSY once the collector had to drop anything: it then
  // returns the retained TAIL window, not the delta from byte 0. This code used
  // to keep only `.text`, so a run whose output exceeded `maxBytes` (default
  // 200 KB) came back looking like a complete answer — and `ok` is decided by
  // the exit code, so it even reported success. For a chat agent, whose reply
  // the host model is told to relay VERBATIM, that silently hands the user a
  // truncated reply as if it were the whole thing.
  if (stdoutRead.lossy || stderrRead.lossy) {
    out.truncated = true
    out.truncatedNote =
      `输出超过上限（${launch.maxBytes} 字节），下面只有**末尾**的部分，开头已被丢弃`
      + (stdoutRead.spillPath ? `。完整输出见：${stdoutRead.spillPath}` : '，且无法恢复（未启用落盘溢出）')
      + '。不要把这里的内容当作完整结果；必要时让任务把结果写到文件再分段读取。'
  }

  if (!out.ok && out.error === undefined) {
    // A failure must always say WHY. Without this, a killed-but-talkative run
    // returned `ok:false` with no `error` at all, and the reason was simply lost.
    const tail = stderr.trim().split('\n').slice(-4).join(' | ')
    out.error = tail !== ''
      ? tail
      : (exitCode === null
        ? '外部 Agent 被中止，没有正常退出（也没有输出错误信息）'
        : stderr.trim() === ''
          ? '外部 Agent 没有返回任何内容'
          : '退出码 ' + exitCode + '（详情见 stdout）')
  }
  return out
}

/**
 * The roster's tool names, whichever executor kind they use.
 *
 * `tool` entries borrow a tool from another plugin (Claude Code / Codex), and
 * `launch` entries get theirs registered by this plugin — but they are the SAME
 * kind of thing from the selector's point of view: "the tool that runs agent X".
 */
function agentToolNames(roster) {
  const names = new Map()
  for (const entry of roster) {
    const name = entry.launch ? (entry.tool || ('cli_' + entry.id + LAUNCH_TOOL_SUFFIX)) : entry.tool
    if (typeof name === 'string' && name !== '') names.set(name, entry)
  }
  return names
}

/**
 * 闸门规则的「人话版」，只给 UI 的机制说明面板显示用。
 *
 * ⚠️ 它和紧跟着的 `agentToolGuard` 是**同一套语义的两处表达**：改闸门时这里必须
 * 一起改。没法自动生成——那些规则是 `if` 语句，不是数据。放在紧邻位置，是为了让
 * 改动的人一眼就看到它。
 *
 * （而「模型收到的指令原文」那一项**不是**这样：它由 `/inspect` 直接调用
 * `modeGuidance()` 得到，和提示段共用同一个函数，所以不可能漂移。）
 */
const GATE_RULES = [
  '本会话选中的 Agent 自己被调用 → 放行',
  '本会话选中了 A，却去调 B 的工具 → 拦下，并说明当前执行体是谁',
  '本会话没有选中任何 Agent → 放行（显式点名某个 Agent 仍然可用）',
  '选中的 id 已不在名册里 → 按「未指定」放行（例如那个 Agent 被从 agents.json 删掉了）',
  '闸门自身出异常、或调用没带会话标识 → 一律放行（宁可不拦，也不误杀正常调用）',
]

/**
 * 「机制说明」面板里那几条性质说明。与 `GATE_RULES` 相邻，理由相同：它们描述的
 * 正是闸门的能力**边界**。
 *
 * 最后一条是用户看出来的漏洞，必须明写——它是整个机制最容易被误解的地方：
 * 闸门拦的是**一次工具调用**，而"我自己回答"根本不是工具调用，没有东西可拦。
 * 所以模式是【路由要求】，不是【强制】：它约束的是"不许调错人"，
 * **不保证**"必须把消息交出去"。
 */
const GATE_NOTES = [
  '这个选择是【按会话】的：只影响当前这一个对话，别的会话各自独立。',
  '一个回合开始后会锁定执行体：中途切换只对下一条消息生效。',
  '⚠ 模式是【路由要求】，不是【强制】。闸门拦的是"去调别的 Agent 的工具"，'
  + '而"我自己回答"不是工具调用，没有东西可拦。所以选着某个 Agent 时，'
  + '如果我没把消息交出去、而是自己答了，机制上挡不住——它只是约定，不是机制。',
]

/**
 * A synchronous accept/deny check for one agent-backed tool call.
 *
 * SEMANTICS (mode "B", chosen by the user 2026-09-21):
 *   - an agent is selected IN THIS SESSION, and it IS the one being called -> allow
 *   - an agent is selected in this session, but a DIFFERENT one is called   -> deny
 *   - NO agent selected in this session                                     -> allow
 *
 * "This session" is essential: the choice is per conversation, so the predicate
 * resolves it from the execution's own agent (`exec.agent`) rather than from one
 * process-wide value. A call from a session that never chose anything is the
 * unset case, never another session's choice.
 *
 * The last case matters: "不指定" means plain conversation, not "forbid all
 * agents". A user who explicitly asks for Codex by name in plain conversation
 * must still get it. The mode only decides the DEFAULT executor; it does not
 * take away explicit requests.
 *
 * HARD REQUIREMENT (this is what broke the whole tool system once): DSH's
 * `tools.guard()` takes a **synchronous** predicate and calls it as
 * `guard(exec)`; it does no awaiting. An `async` guard returns a Promise, so
 * `guard(exec)` throws `guard is not a function` — and because a plain-context
 * guard applies to EVERY tool in the Host, that single mistake rejects every
 * tool call in the app, not just this plugin's.
 *
 * Therefore this function must (a) be a plain function, and (b) do no I/O. It
 * reads the active mode from the caller's in-memory cache, which `apply()`
 * keeps in sync with the state file.
 *
 * @param exec - tool execution request; `exec.name` is the tool being called and
 *   `exec.agent` identifies the session that is calling. `exec.signal` carries the
 *   turn identity used to lock the choice for the whole turn.
 * @param lookupMode - (exec) => active mode id for that turn, or null.
 *   Synchronous. Production passes `modeForTurn` (turn-locked); `cachedGuardMode`
 *   is the underlying live read, used directly by tests.
 * @returns undefined to allow, or a reason string to deny.
 */
export function agentToolGuard(roster, lookupMode) {
  const owned = agentToolNames(roster)
  // Every id the roster knows. Used below to recognise a mode that refers to an
  // agent which no longer exists.
  const knownIds = new Set(roster.map((e) => (e && typeof e.id === 'string' ? e.id : '')).filter((x) => x !== ''))
  const activeNameOf = (id) => {
    const found = roster.find((e) => e.id === id)
    return found ? found.name : id
  }
  // Diagnostics for the one blind spot this design has: if the execution
  // carries no session identity, the gate cannot tell "this session chose
  // nothing" from "we cannot tell which session this is", and it fails open.
  // That is the right default (never block a legitimate call), but it must be
  // VISIBLE — otherwise a mode that silently stopped applying would look like
  // the plugin doing nothing. One line per tool name, not per call.
  const seen = new Set()
  let sawStale = false
  return (exec) => {
    try {
      const name = exec && typeof exec.name === 'string' ? exec.name : ''
      const entry = owned.get(name)
      if (!entry) return undefined
      // The execution's own agent identifies the session that is calling.
      const key = sessionKeyOf(exec)
      if (key === null && !seen.has(name)) {
        seen.add(name)
        diagnose(`闸门：${name} 的调用没有会话标识（按未指定放行）——若模式看起来不生效，先查这里`)
      }
      const active = lookupMode(exec)
      // No default executor: plain conversation, explicit requests go through.
      if (active === null || active === undefined) return undefined
      // A mode id that is no longer in the roster is NOT a default executor.
      //
      // Reachable by the workflow the roster file itself invites: agents.json is
      // user-editable, so deleting an agent (or renaming its id) leaves every
      // session that had chosen it holding a mode that resolves to nothing. The
      // prompt section already renders that as "未指定" (`entryForCached` ->
      // null). The gate MUST agree: otherwise the model is told "no executor,
      // just talk", while every explicit "use Claude Code" is refused with a
      // reason naming an agent the section just said does not exist. Treat it
      // exactly as unset.
      if (!knownIds.has(active)) {
        if (!sawStale) {
          sawStale = true
          diagnose(`闸门：会话里记录的默认执行体「${active}」不在名册中（按未指定放行）——通常是它已从 agents.json 删除`)
        }
        return undefined
      }
      if (active === entry.id) return undefined
      const activeName = activeNameOf(active)
      return `当前默认执行体是「${activeName}」，不是「${entry.name}」。请改用 ${activeName} 对应的工具执行本任务；除非用户明确要求，否则不要调用 ${entry.name}。`
    } catch {
      // A guard that throws must never block the turn; fail open.
      return undefined
    }
  }
}

/**
 * Append a startup diagnostic line to `<DSH_HOME>/agent-picker.log`.
 *
 * DSH gives a web plugin no reachable log sink (there is no log file for it and
 * console output goes to the Electron main process), so a registration failure
 * is otherwise completely invisible. This is deliberately best-effort: a
 * diagnostic must never be able to break the plugin or a tool call.
 *
 * `DSH_AGENT_PICKER_LOG` overrides the destination. The offline harness sets it
 * so its own noisy startup runs do not pollute the deployment's log — otherwise
 * the one file you rely on when something breaks fills up with test output.
 */
function diagnose(line) {
  try {
    const override = process.env.DSH_AGENT_PICKER_LOG
    const file = (typeof override === 'string' && override.trim() !== '')
      ? override.trim()
      : path.join(dshHome(), 'agent-picker.log')
    const stamp = new Date().toISOString()
    // Fire and forget; no await, no throw.
    appendFile(file, `[${stamp}] ${line}\n`, 'utf8').catch(() => {})
  } catch { /* ignore */ }
  try { console.log('[dsh-agent-picker] ' + line) } catch { /* ignore */ }
}

/**
 * Register executor tools for every roster entry that declares an inline
 * `launch` recipe. Entries carrying `tool` are skipped on purpose: that tool
 * belongs to another plugin, and shadowing a registered name is a bug.
 *
 * Never throws — a bad recipe degrades to "this one agent is not callable".
 */
function registerLaunchTools(ctx, roster) {
  const disposers = []
  diagnose(`registerLaunchTools: roster=${Array.isArray(roster) ? roster.length : 'not-array'} 项`)
  if (!ctx || typeof ctx.tools?.register !== 'function') {
    diagnose('registerLaunchTools: 中止 —— ctx.tools.register 不是函数')
    return () => {}
  }
  const taken = ctx.tools.registeredNames instanceof Set ? ctx.tools.registeredNames : null
  diagnose(`registerLaunchTools: registeredNames 可见=${taken !== null}${taken ? ' 现有=' + taken.size : ''}`)

  for (const entry of roster) {
    if (!entry.launch) {
      diagnose(`  跳过 ${entry.id}：无 launch 配方（借用 ${entry.tool}）`)
      continue
    }
    const toolName = entry.tool || ('cli_' + entry.id + LAUNCH_TOOL_SUFFIX)
    if (taken !== null && taken.has(toolName)) {
      diagnose(`  跳过 ${entry.name}：工具名 ${toolName} 已被占用`)
      continue
    }
    try {
      diagnose(`  正在注册 ${toolName} …`)
      const registered = ctx.tools.register(defineTool({
        name: toolName,
        description: [
          `通过 ${entry.name} 执行一个自包含任务并返回其输出。`,
          `${entry.name} 是外部 Agent 系统，看不到当前对话上下文，因此任务必须完整、自包含。`,
          `本机的 Agent 模式选择器已把 ${entry.name} 设为默认执行体时使用它。`,
          // State the argument convention explicitly. Every agent-backed tool in
          // this deployment uses prompt+description (that is what dsh-sub-cli's
          // cli_claude_direct / cli_codex_direct take), and a mode switch must
          // never leave the model guessing parameter names — a wrong guess burns
          // a whole turn and shows up to the user as a failed call.
          '参数约定：任务正文放 `prompt`，另给一个 3-5 词的 `description` 作标题。所有 Agent 工具统一如此。',
          entry.note ? `备注：${entry.note}` : '',
        ].filter(Boolean).join('\n'),
        parameters: {
          // `prompt` is the canonical name. It is intentionally NOT schema-required
          // so that a call using the legacy alias `task` still reaches execute()
          // instead of failing validation — validation failure and a clear error
          // message cost the same turn, but only the latter explains itself.
          prompt: { type: 'string', description: '自包含的任务正文（用户消息的正文放这里）。' },
          description: { type: 'string', description: '这次调用的简短标题（3-5 个词），用于界面显示。' },
          task: { type: 'string', description: '（兼容别名）等同于 prompt，两者给一个即可。' },
          model: { type: 'string', description: `可选：覆盖 ${entry.name} 本次运行使用的模型。` },
          permission: { type: 'string', description: '可选：权限档位（如 read-only / danger-full-access）。' },
          image: { type: 'string', description: '可选：要交给它的图片文件路径。仅对命令行支持图片的成员有效（目前只有 Codex）；其他成员会忽略它。' },
          workspace: { type: 'string', description: '可选：外部 Agent 的工作目录。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const a = args || {}
          const pick = (v) => (typeof v === 'string' && v !== '' ? v : '')
          const prompt = pick(a.prompt) || pick(a.task)
          if (prompt === '') {
            return {
              agent: entry.id,
              name: entry.name,
              ok: false,
              error: `缺少任务正文：请把内容放进 prompt 参数（兼容别名 task）。本次没有可执行的任务。`,
            }
          }
          const result = await runLaunch(ctx, entry.launch, {
            task: prompt,
            model: pick(a.model),
            permission: pick(a.permission),
            image: pick(a.image),
            workspace: pick(a.workspace),
            signal: exec && exec.signal,
          })
          return { agent: entry.id, name: entry.name, ...result }
        },
      }))
      disposers.push(registered)
      const nowTaken = ctx.tools.registeredNames instanceof Set ? ctx.tools.registeredNames.has(toolName) : null
      diagnose(`  注册成功 ${toolName} -> ${entry.name}；registeredNames 现在包含它=${nowTaken}；disposer=${typeof registered}`)
    } catch (error) {
      diagnose(`  注册 ${entry.name} 失败: ${error && error.stack ? error.stack : String(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
    }
  }
}

/**
 * SYNCHRONOUS roster read, for the boot path.
 *
 * Why this exists (verified the hard way, from the diagnostic log):
 *   `cannot get required service "tools" in inactive context`
 * The executor effect is created and then torn down again moments later during
 * boot. Registering from a `readRoster().then(...)` callback therefore ran
 * AFTER that ctx went inactive: `ctx.tools.register()` returned a disposer and
 * logged success, but the definition landed in a dead context, so the agent's
 * registry view never contained the tool and every call failed with
 *   unknown tool "cli_openclaw_direct"
 *
 * The fix is to finish registration inside `apply()`, with no await in between.
 * `tools.guard()` survives the async path (it is context-independent), which is
 * why the guard reported success while the tool did not — that asymmetry was the
 * clue. Reading a small local JSON synchronously at boot is the right trade;
 * the API-facing `readRoster()` below stays async and authoritative.
 */
/**
 * The CONVENTION DIRECTORY: drop-in agent recipes.
 *
 * Kept next to the roster under `$DSH_HOME` so it follows the DSH install rather
 * than a fixed drive letter, and so two profiles on one machine do not share it
 * by accident. Anyone shipping an agent writes one `*.agent.json` here instead
 * of asking the user to edit a roster or a shell script.
 */
export function conventionDir() {
  return path.join(dshHome(), 'agent-picker.d')
}

/**
 * Layer the CONVENTION DIRECTORY on top of the roster.
 *
 * Any installer, script or sibling plugin can drop one self-describing file per
 * agent into:
 *
 *     $DSH_HOME/agent-picker.d/*.agent.json
 *
 * and the agent shows up without this plugin knowing anything about it. That is
 * the whole point: the picker stays generic, and whoever ships an agent owns its
 * recipe. Shape — same fields as a roster entry:
 *
 *     { "id": "my-agent", "name": "My Agent", "bin": "my-agent.ps1",
 *       "argv": ["-File", "{cliDir}/my-agent.ps1", "{task}"], "kind": "task" }
 *
 * A bare `bin`/`argv` filename is resolved against `cliBinDir()` by
 * `expandLauncherToken`, so a drop-in file stays machine-independent.
 *
 * Precedence: the roster still wins by id — an operator's hand-written entry is
 * never overridden by a drop-in file. Broken files are skipped individually and
 * reported, never fatal: one bad drop-in must not take the picker down.
 */
function loadConventionEntries() {
  const dir = conventionDir()
  let names
  try {
    if (!existsSync(dir)) return []
    names = readdirSync(dir).filter((f) => /\.agent\.json$/i.test(f))
  } catch (error) {
    console.warn('[dsh-agent-picker] convention dir unreadable (' + dir + '):', error)
    return []
  }
  const out = []
  for (const n of names) {
    const file = path.join(dir, n)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      // Accept a single entry or an { agents: [...] } wrapper.
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.agents) ? parsed.agents : [parsed])
      for (const item of list) {
        const entry = normalizeEntry(item)
        if (entry) { entry.__from = 'convention:' + n; out.push(entry) }
        else console.warn('[dsh-agent-picker] convention file ' + n + ' has an unusable entry (needs id + name)')
      }
    } catch (error) {
      console.warn('[dsh-agent-picker] convention file ' + n + ' skipped:', String(error && error.message))
    }
  }
  if (out.length > 0) {
    console.log('[dsh-agent-picker] 约定目录并入 ' + out.length + ' 项：' + out.map((e) => e.id).join(', '))
  }
  return out
}

/**
 * Layer agent DISCOVERY on top of the roster.
 *
 * The roster is an override layer, not the whole story: an agent that is merely
 * INSTALLED on this machine should show up without anyone hand-writing a recipe.
 * Precedence, highest first:
 *
 *   1. the roster (packaged template or the user's own file)  <- wins, by id
 *   2. the convention dir ($DSH_HOME/agent-picker.d)          <- drop-in recipes
 *   3. discovered agents (PATH + cliBinDir)                   <- fills the gaps
 *   4. FALLBACK_ROSTER                                        <- already applied
 *
 * Nothing discovered may shadow a rostered id, so a hand-written recipe (with
 * its endpoint env, image argument, longer timeout…) always keeps control.
 *
 * An entry surfaced here is marked `available` only when it is actually
 * USABLE: the command resolved AND every env var it needs is present AND it
 * needs no background service. Otherwise it still appears, with a note saying
 * what is missing — a picker that silently hides a just-installed agent is
 * worse than one that shows it as "needs configuration".
 *
 * Escape hatch: `DSH_AGENT_PICKER_DISCOVER=0` turns BOTH extra layers off, which
 * is what the offline suites use so they keep asserting on the roster alone.
 */
function mergeDiscovered(roster) {
  const flag = process.env.DSH_AGENT_PICKER_DISCOVER
  if (flag === '0' || flag === 'false') return roster

  // --- layer 2: convention dir ---
  let merged = roster
  try {
    const conv = loadConventionEntries()
    if (conv.length > 0) {
      const have = new Set(merged.map((e) => e.id))
      merged = merged.concat(conv.filter((e) => !have.has(e.id)))
    }
  } catch (error) {
    console.warn('[dsh-agent-picker] convention layer failed (roster used):', error)
  }

  // --- layer 3: discovery ---
  let found
  try {
    // Where to look beyond PATH. cliBinDir is where managed wrappers live and is
    // NOT on PATH on this deployment (without it, codex is invisible). The
    // `~/.local/bin` convention is where pipx/uv and several agent installers
    // drop their launchers (aider lives there here) — also not on PATH.
    found = discoverAgents(process.env, [
      cliBinDir(),
      path.join(os.homedir(), '.local', 'bin'),
    ])
  } catch (error) {
    console.warn('[dsh-agent-picker] agent discovery failed (roster used as-is):', error)
    return merged
  }
  const have = new Set(merged.map((e) => e.id))
  const extra = []
  for (const d of found) {
    // Anything that actually EXISTS on this machine goes into the list — including
    // the agents we can recognise but have no verified launch recipe for. Skipping
    // those (`continue` on empty argv) is why a machine could have Cursor installed
    // and show nothing at all: the user could not even tell it had been detected.
    if (!d.found || !d.exe) continue
    if (have.has(d.id)) continue
    const hasRecipe = Array.isArray(d.argv) && d.argv.length > 0
    const missing = d.missingEnv ? d.missingEnv.join(', ') : ''
    const noteParts = ['自动发现（' + d.exe + (d.exeFrom === 'cliDir' ? '，来自 cliBinDir' : '') + '）']
    if (!hasRecipe) {
      noteParts.push('识别到 CLI，但还没有启动配方 —— 用约定目录或名册补一条 launch 就能调用')
    } else if (!d.ready) {
      if (missing) noteParts.push('待配置环境变量：' + missing)
      if (d.needsService) noteParts.push('还需：' + d.needsService)
    }
    extra.push({
      id: d.id,
      name: d.name,
      tool: 'cli_' + d.id + '_direct',
      bin: d.exe,
      // 没有配方就不可调用，所以这里必须 false —— 它会落到「可安装」区，
      // 并带上"需配置启动方式"的说明，而不是假装能用。
      available: hasRecipe && d.ready,
      kind: d.kind === 'chat' ? 'chat' : 'task',
      expertise: hasRecipe
        ? (d.ready ? '自动发现，可直接使用' : '已安装，待配置')
        : '已检测到，需配置启动方式',
      note: noteParts.join('；'),
      // 介绍来自内置表的 desc（查表得到，不是猜的）
      desc: d.desc || ('本机自动发现的 ' + d.name + '（' + d.exe + '）。'),
      // 没有配方 → 前端要把它渲染成"可引导补齐"的状态，而不是死路一条
      needsRecipe: !hasRecipe,
      launch: hasRecipe
        ? {
          bin: d.exe,
          // Do NOT drop the last element: the builtin argv already ends with
          // `{task}`, and the tokens BEFORE it carry the permission /
          // non-interactive flags. Slicing the tail off silently discarded them,
          // which is how a discovered codex ended up running as `read-only`.
          argv: d.argv.includes('{task}') ? d.argv.slice() : d.argv.concat(['{task}']),
          permFlags: d.permFlags || undefined,
          defaultPermFlags: d.defaultPermFlags || undefined,
        }
        : undefined,
    })
  }
  if (extra.length === 0) return merged
  const out = merged.concat(extra.map(normalizeEntry).filter(Boolean))
  console.log('[dsh-agent-picker] 自动发现并入 ' + extra.length + ' 项：' + extra.map((e) => e.id).join(', '))
  return out
}

function readRosterSync() {
  const target = rosterFile()
  try {
    if (!existsSync(target)) {
      try {
        const seed = readFileSync(packagedRosterFile(), 'utf8')
        mkdirSync(dshHome(), { recursive: true })
        writeFileSync(target, seed, 'utf8')
        console.log('[dsh-agent-picker] seeded roster -> ' + target)
      } catch (error) {
        console.warn('[dsh-agent-picker] roster seed failed (will use fallback):', error)
      }
    }
    return mergeDiscovered(parseRosterText(readFileSync(target, 'utf8')))
  } catch (error) {
    console.warn('[dsh-agent-picker] roster sync read failed, using fallback:', error)
    return mergeDiscovered(FALLBACK_ROSTER)
  }
}

/**
 * Turn one raw roster entry into the shape the rest of the plugin uses.
 *
 * Returns null for an entry that cannot be identified. This is the ONLY place
 * an agent entry is built — the fallback list and every roster file both come
 * through here — so a field added below cannot be missing on one path while
 * present on the other. (It used to be inline in `parseRosterText`, with the
 * fallback returned un-normalized: see the note on `FALLBACK_ROSTER`.)
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return null
  return {
    id: entry.id,
    name: entry.name,
    tool: typeof entry.tool === 'string' ? entry.tool : ('cli_' + entry.id + '_direct'),
    bin: typeof entry.bin === 'string' ? entry.bin : (entry.id + '.cmd'),
    available: entry.available === true,
    note: typeof entry.note === 'string' ? entry.note : '',
    // Capability fields for the menu. `expertise` is the one-line "good at"
    // summary shown under the name; `desc` is the fuller blurb revealed by
    // expanding the row. Both optional — older rosters simply lack them.
    expertise: typeof entry.expertise === 'string' ? entry.expertise : '',
    desc: typeof entry.desc === 'string' ? entry.desc : '',
    // Execution KIND, which decides how the host model treats a user message
    // when this agent is the active executor:
    //   'task' (default) - the message is a self-contained task to delegate.
    //   'chat'           - the message is ordinary speech; the agent's reply
    //                      must be relayed VERBATIM, not summarized.
    // Default to 'task': every agent we shipped before this field existed is
    // a task executor, so an old roster keeps its behaviour exactly.
    kind: entry.kind === 'chat' ? 'chat' : 'task',
    // Inline executor recipe. Only present for agents DSH has no tool for;
    // entries that carry `tool` are executed by whichever plugin owns it.
    // Always normalized (or null), never the raw literal: the launch recipe's
    // defaults are what bound the child's output, so skipping this step is a
    // resource bug, not a cosmetic one.
    launch: parseLaunch(entry.launch),
    // 识别到了、但我们没有验证过的启动配方 —— 用户补一条 launch 才能真正调用。
    // 只有自动发现会置 true（见 mergeDiscovered）；手写名册默认 false，
    // 因为手写条目要么带配方、要么本来就是在借用别的插件注册的工具。
    needsRecipe: entry.needsRecipe === true,
  }
}

/**
 * Parse + normalize a roster document; shared by the sync and async readers.
 *
 * Exported so the offline verification can assert on the fallback path
 * directly — the bug this guards against (fallback entries skipping
 * normalization, and so running with an unbounded output cap) is invisible on
 * the happy path where `agents.json` parses correctly.
 */
export function parseRosterText(raw) {
  try {
    const parsed = JSON.parse(raw)
    const list = parsed && Array.isArray(parsed.agents) ? parsed.agents : null
    if (list === null) return FALLBACK_ROSTER
    const clean = list.map(normalizeEntry).filter(Boolean)
    return clean.length > 0 ? clean : FALLBACK_ROSTER
  } catch (error) {
    console.warn('[dsh-agent-picker] roster parse failed, using fallback:', error)
    return FALLBACK_ROSTER
  }
}

/**
 * Read the user roster, seeding it from the packaged template on first run.
 * Never throws: a broken or missing roster degrades to the fallback list.
 */
async function readRoster() {
  const target = rosterFile()
  try {
    if (!(await exists(target))) {
      // First run: seed a copy the user can edit, then use the packaged content.
      try {
        const seed = await readFile(packagedRosterFile(), 'utf8')
        await mkdir(dshHome(), { recursive: true })
        await writeFile(target, seed, 'utf8')
        console.log('[dsh-agent-picker] seeded roster -> ' + target)
      } catch (error) {
        console.warn('[dsh-agent-picker] roster seed failed (will use fallback):', error)
      }
    }
    return mergeDiscovered(parseRosterText(await readFile(target, 'utf8')))
  } catch (error) {
    console.warn('[dsh-agent-picker] roster read failed, using fallback:', error)
    return mergeDiscovered(FALLBACK_ROSTER)
  }
}

/**
 * Turn any of the shapes DSH hands us into a session key.
 *
 * The plugin meets session identity in four different wrappers depending on the
 * call site: a bare id string (the HTTP route), an agent object with `id`
 * (`context.agent` during prompt assembly), a context carrying `agent`, and a
 * tool execution (`exec.agent`). Normalising here keeps every caller honest and
 * gives one answer to "which session is this?".
 *
 * @returns the key, or null when the caller carries no session identity.
 */
export function sessionKeyOf(candidate) {
  let value = candidate
  if (value !== null && typeof value === 'object' && value.agent !== undefined && value.agent !== null) {
    value = value.agent
  }
  if (value !== null && typeof value === 'object') {
    // An agent object carries BOTH its own `id` and its `session`. The browser
    // names a SESSION (`conversation.input.right` hands out `sessionId`), so the
    // session identity is the one that must match. Prefer it, and fall back to
    // `id` for the plain `{ id }` shapes the tests and routes use.
    const session = value.session
    if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id !== '') {
      return session.id
    }
    value = value.id
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Best-effort description of an assembly/execution context, for diagnostics.
 * Reports BOTH candidate identities when they differ, because a mismatch
 * between the agent id and the session id would silently break per-session
 * isolation and is otherwise invisible.
 */
function describeSessionContext(candidate) {
  const raw = candidate !== null && typeof candidate === 'object' && candidate.agent !== undefined
    ? candidate.agent
    : candidate
  if (raw === null || typeof raw !== 'object') return `非对象(${typeof raw})`
  const agentId = typeof raw.id === 'string' ? raw.id : '(无)'
  const sessionId = raw.session !== null && typeof raw.session === 'object' && typeof raw.session.id === 'string'
    ? raw.session.id
    : '(无)'
  const chosen = sessionKeyOf(candidate) ?? '(取不到)'
  return `选中=${chosen}  agent.id=${agentId}  session.id=${sessionId}` +
    (agentId !== '(无)' && sessionId !== '(无)' && agentId !== sessionId ? '  ⚠ 两者不一致' : '')
}

/** Most recent session choices kept on disk; older ones are pruned. */
const MAX_SESSION_MODES = 200

/**
 * Read the whole state document; never throws.
 *
 * Shape: `{ modes: { "<sessionKey>": { id, at } }, enabled[], disabled[] }`
 *
 * `modes` is keyed by SESSION on purpose. It used to be one global `id`, which
 * meant switching the Agent in one conversation silently switched it in every
 * other conversation — sessions are meant to be independent, so the choice now
 * lives with the session that made it. A legacy global `id` is deliberately
 * dropped: sessions start unset rather than inheriting someone else's choice.
 */
/** Normalise a parsed state document into the canonical shape. Pure. */
function parseStateDocument(parsed) {
  const modes = {}
  const source = parsed && parsed.modes && typeof parsed.modes === 'object' ? parsed.modes : {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    const id = typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : null)
    if (id === null || id === '' || id === 'off') continue
    const at = value && typeof value.at === 'string' && value.at !== '' ? value.at : ''
    modes[key] = { id, at }
  }
  return {
    modes,
    enabled: parsed && Array.isArray(parsed.enabled) ? parsed.enabled.filter((x) => typeof x === 'string') : [],
    // `disabled` records agents the user explicitly removed. Without it the
    // auto-enable rule (available && installed) would silently resurrect a
    // removed agent, making the menu's remove button appear to do nothing.
    disabled: parsed && Array.isArray(parsed.disabled) ? parsed.disabled.filter((x) => typeof x === 'string') : [],
  }
}

async function readState() {
  try {
    return parseStateDocument(JSON.parse(await readFile(stateFile(), 'utf8')))
  } catch {
    return { modes: {}, enabled: [], disabled: [] }
  }
}

/**
 * SYNCHRONOUS state read, for the boot path.
 *
 * The prompt section reads the mode cache on every assembly, and the cache is
 * primed at boot. Loading it through a promise leaves a window where an
 * assembly sees an EMPTY map — and if that effect is torn down before the
 * promise lands (which DSH really does during boot), the cache stays empty
 * forever and EVERY session silently reads as "未指定", disabling the mode
 * altogether. Same class of failure as the async tool registration documented in
 * AGENT-TOOLS.md 16.7: on the boot path, promise callbacks run against a context
 * that may already be gone. Read it synchronously instead.
 */
function readStateSync() {
  try {
    return parseStateDocument(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    return { modes: {}, enabled: [], disabled: [] }
  }
}

/**
 * Persist the state document; never throws.
 *
 * ATOMIC on purpose. A plain `writeFile` truncates first and writes second, so
 * an interrupted write (app killed mid-save, which really happened here) leaves
 * a 0-byte file. The plugin tolerates that (readState falls back to defaults),
 * but the user silently loses which agents they had enabled. Writing to a
 * sibling temp file and renaming makes the swap atomic: readers see either the
 * old document or the new one, never a half-written one.
 */
async function writeState(next) {
  const target = stateFile()
  const tmp = target + '.tmp'
  try {
    await mkdir(dshHome(), { recursive: true })
    const modes = {}
    const entries = Object.entries(next && next.modes && typeof next.modes === 'object' ? next.modes : {})
    // Keep only the most recently touched sessions: otherwise a long-lived
    // harness accumulates one entry per conversation, forever.
    entries.sort((a, b) => String((b[1] && b[1].at) || '').localeCompare(String((a[1] && a[1].at) || '')))
    for (const [key, value] of entries.slice(0, MAX_SESSION_MODES)) {
      if (typeof key !== 'string' || key === '') continue
      const id = value && typeof value.id === 'string' ? value.id : null
      if (id === null || id === '' || id === 'off') continue
      modes[key] = {
        id,
        // Treat an empty string as missing: readState yields '' for legacy
        // entries that never carried a timestamp, and keeping that would make
        // the prune order meaningless.
        at: (value && typeof value.at === 'string' && value.at !== '') ? value.at : new Date().toISOString(),
      }
    }
    const body = JSON.stringify({
      modes,
      enabled: Array.isArray(next.enabled) ? next.enabled : [],
      disabled: Array.isArray(next.disabled) ? next.disabled : [],
      at: new Date().toISOString(),
    }, null, 2)
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, target)
    return true
  } catch (error) {
    console.warn('[dsh-agent-picker] state write failed:', error)
    try { await rm(tmp, { force: true }) } catch { /* ignore */ }
    // 必须把失败说出去。
    // 原来这里什么都不返回（成功失败都是 undefined），调用方无从分辨，于是
    // 磁盘满/权限错时：本进程按新模式工作（缓存已改）、重启后静默回退，而用户
    // 看到的是"切换成功"。这是"一条路有值、另一条路没值"的写侧版本。
    return false
  }
}

/**
 * Serialize state mutations.
 *
 * Every writer is a read-modify-write over a shared document. Now that the
 * choice is PER SESSION, two conversations can legitimately write at the same
 * moment (two browser tabs, or a switch in one while another loads) — and two
 * overlapping read-modify-write cycles lose one of the updates, silently
 * dropping a session's choice. Node is single-threaded but `await` interleaves,
 * so the fix is an explicit queue: each mutation runs to completion before the
 * next begins.
 */
let stateQueue = Promise.resolve()
function withStateLock(task) {
  const run = stateQueue.then(task, task)
  // Keep the chain alive even when a task rejects (every caller catches).
  stateQueue = run.then(() => undefined, () => undefined)
  return run
}

/** The mode chosen in one session; null when that session has not chosen. */
export async function readMode(sessionKey) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  const state = await readState()
  const hit = state.modes[key]
  return hit ? hit.id : null
}

/**
 * Set (or clear) the mode for ONE session. Never throws.
 *
 * @returns `{ id, persisted }`. `id` is the normalised value that was applied
 *   (null means cleared). `persisted` says whether it actually reached the disk.
 *   Callers MUST consult it before updating the in-memory cache: memory and disk
 *   disagreeing means the switch works until the next restart and then silently
 *   reverts, which the user experiences as "it just forgets my choice".
 */
export function writeMode(sessionKey, id) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return Promise.resolve({ id: null, persisted: false })
  const normalized = id === '' || id === 'off' || id === undefined || id === null ? null : String(id)
  return withStateLock(async () => {
    const state = await readState()
    const modes = { ...state.modes }
    if (normalized === null) delete modes[key]
    else modes[key] = { id: normalized, at: new Date().toISOString() }
    const persisted = await writeState({ modes, enabled: state.enabled, disabled: state.disabled })
    return { id: normalized, persisted }
  })
}

/** Convenience wrapper used by tests/tools. */
export function dshHomePath() {
  return dshHome()
}

/**
 * Build the agent list the UI needs, merging roster data with real state.
 *
 * Precedence (this order matters — getting it wrong made the remove button a
 * no-op): an explicit user decision always wins over the auto-enable rule.
 *  1. id in `disabled`  -> NOT enabled (the user removed it; stay removed)
 *  2. id in `enabled`   -> enabled (the user added it back)
 *  3. roster says available AND the wrapper file exists -> enabled (auto)
 *  4. otherwise         -> not enabled (offered in the "可安装" area)
 */
/**
 * Is this member actually runnable on THIS machine?
 *
 * This used to be `exists(path.join(cliBinDir(), entry.bin))` — which only ever
 * looked inside the managed wrapper directory. Two things broke because of that:
 *
 *   - A CLI the user installed themselves (on PATH, e.g. `claude` in
 *     `C:\AgentTools\cli`) was reported as "not installed", so it never showed
 *     up as usable even though it was right there.
 *   - A discovered entry carries an ABSOLUTE exe path, and joining it onto
 *     cliBinDir produced a nonsense path, so every discovered member was
 *     "not installed" too.
 *
 * So: absolute path → just stat it; bare name → cliBinDir first (managed
 * wrappers live there and are not on PATH), then PATH with PATHEXT semantics.
 */
async function isInstalled(entry, dir) {
  const bin = typeof entry.bin === 'string' ? entry.bin : ''
  if (bin === '') return false
  if (path.isAbsolute(bin)) return exists(bin)
  if (await exists(path.join(dir, bin))) return true
  try {
    return resolveOnPath(bin, process.env) !== null
  } catch {
    return false
  }
}

export async function scanAgents(sessionKey) {
  const dir = cliBinDir()
  const roster = await readRoster()
  const state = await readState()
  const enabledSet = new Set(state.enabled)
  const disabledSet = new Set(state.disabled)
  // The active executor is per session: report the one THIS session chose.
  const key = sessionKeyOf(sessionKey)
  const active = key !== null && state.modes[key] ? state.modes[key].id : null

  const agents = []
  for (const entry of roster) {
    const installed = await isInstalled(entry, dir)
    const enabled = disabledSet.has(entry.id)
      ? false
      : (enabledSet.has(entry.id) || (entry.available && installed))
    agents.push({
      id: entry.id,
      name: entry.name,
      tool: entry.tool,
      note: entry.note,
      // Must be forwarded here too: readRoster() parses them, but the scan
      // result is what the browser half actually receives.
      expertise: entry.expertise,
      desc: entry.desc,
      // Forwarded so the menu can label the row "任务型" / "对话型".
      kind: entry.kind,
      // True when this plugin registers the executor itself (inline `launch`),
      // as opposed to borrowing a tool another plugin owns.
      selfLaunched: entry.launch !== null,
      installed,
      enabled,
      // 前端据此决定那一行要不要变成"点开看怎么补配方"的引导
      needsRecipe: entry.needsRecipe === true,
      // Display path. Absolute bins (every discovered member) are shown as-is;
      // a bare name is shown resolved against the managed dir.
      path: path.isAbsolute(entry.bin || '') ? entry.bin : path.join(dir, entry.bin || ''),
    })
  }
  return {
    dir,
    rosterFile: rosterFile(),
    // 引导文案要告诉用户"存成哪个文件"，所以路径必须由这里给出，
    // 不能让客户端自己拼（拼错了他会存到一个没人读的地方）。
    conventionDir: conventionDir(),
    agents,
    active,
    session: key,
    enabled: [...enabledSet],
    disabled: [...disabledSet],
  }
}

/**
 * The model-facing instruction for the active mode.
 *
 * Written as an operator instruction to the host model: it names the tool to use
 * and forbids asking again, so the user can simply type.
 *
 * The wording branches on the agent's KIND, because the two cases genuinely
 * differ and getting it wrong is user-visible:
 *   - task agents (Codex / Claude Code): the user's message IS the work order.
 *     Summarising the result is fine; that is what the user wants.
 *   - chat agents (OpenClaw): the user is talking, and the agent already keeps
 *     its own continuous conversation. The host model is only a pipe, so it must
 *     relay the reply VERBATIM. Paraphrasing here silently rewrites another
 *     agent's words — the user asked to talk to OpenClaw, not to a summary of it.
 */
export function modeGuidance(entry) {
  if (entry === null) {
    return '本机已安装 dsh-agent-picker 插件（Web GUI 的 Agent 模式选择器）：输入框右侧有一个 Agent 控件，可以像推理档位那样选定一个外部 Agent CLI 作为【默认执行体】。**当前未指定执行体** —— 按普通对话处理用户消息，不要自动调用外部 CLI。'
  }
  const head = '本机已安装 dsh-agent-picker 插件（Web GUI 的 Agent 模式选择器）：输入框右侧有一个 Agent 控件，可以像推理档位那样选定一个外部 Agent CLI 作为【默认执行体】。'
  const who = `**当前默认执行体 = ${entry.name}**（模式 id：\`${entry.id}\`，类型：${entry.kind === 'chat' ? '对话型' : '任务型'}）。`

  if (entry.kind === 'chat') {
    return [
      head,
      who,
      `因此：用户**每一条**消息都默认交给 ${entry.name}，用户不会（也不需要）在消息里说明这一点。`,
      `收到用户消息时，调用 \`${entry.tool}\`：把消息正文**原封不动**放进它的 \`prompt\` 参数（兼容别名 \`task\`），再给一个 3-5 词的 \`description\` 作标题。它是用户在跟 ${entry.name} 说话，不是给你的指令——不要改写、不要补背景、不要加"请帮我"之类的包装。`,
      `拿到回复后，把 ${entry.name} 的回答**原样转述**给用户：不要总结、不要压缩、不要润色、不要省略细节，也不要替它解释。你可以直说这是它说的，但内容必须保持一致。`,
      `你不要自己回答用户的问题——你只是通道。唯一例外：用户显式要求"你自己做 / 别调用 ${entry.name} / 普通对话 / 取消模式"时，才按普通对话处理。`,
      '不要在回复里解释这条路由规则，直接照做即可。',
    ].join('\n')
  }

  return [
    head,
    who,
    `因此：用户**每一条**消息都默认由 ${entry.name} 执行，用户不会（也不需要）在消息里说明这一点。`,
    `收到用户消息时，调用 \`${entry.tool}\`：把消息正文（可整理成自包含的任务描述）放进它的 \`prompt\` 参数（兼容别名 \`task\`），再给一个 3-5 词的 \`description\` 作标题。不要再反问用户"要不要用 ${entry.name}"，也不要只是复述或改写任务。`,
    `例外：只有当用户显式要求"你自己做 / 别调用 ${entry.name} / 普通对话 / 取消模式"时，才按普通对话处理。`,
    '不要在回复里解释这条路由规则，直接执行即可。',
  ].join('\n')
}

/**
 * In-process caches for the SYNCHRONOUS readers.
 *
 * Both the prompt section's text function and the tool guard run on hot paths
 * where I/O is impossible (the guard must not even return a Promise). So the
 * roster and every session's choice are kept in memory, primed at boot and
 * updated on each accepted write.
 *
 * `cachedModes` is keyed by session, mirroring the on-disk shape: one entry per
 * conversation. A missing key means "this session has not chosen", which is the
 * unset state — never another session's value.
 */
let cachedRoster = []
let cachedModes = new Map()

/** Install the roster the readers validate against. */
export function cacheRoster(roster) {
  cachedRoster = Array.isArray(roster) ? roster : []
}

/** Replace the whole session→mode map (boot). Synchronous. */
export function cacheModes(modes) {
  const source = modes && typeof modes === 'object' ? modes : {}
  const entries = Object.entries(source).filter(([key, value]) => {
    if (typeof key !== 'string' || key === '') return false
    const id = value && typeof value.id === 'string' ? value.id : null
    return id !== null && id !== '' && id !== 'off'
  })
  // 与写侧同一条上界规则，只保留最近用过的 MAX_SESSION_MODES 个会话。
  //
  // 写侧一直有这条上界，读侧没有：写出去的永远是 ≤200 条，但**读进来的**照单全收。
  // 状态文件被手工编辑过、或来自旧版本时，缓存就会无界增长——两侧对"能装多少"
  // 给出不同答案，正是这一轮反复出现的那种"两条路不一致"。
  entries.sort((a, b) => String((b[1] && b[1].at) || '').localeCompare(String((a[1] && a[1].at) || '')))
  cachedModes = new Map()
  for (const [key, value] of entries.slice(0, MAX_SESSION_MODES)) cachedModes.set(key, value.id)
  // 与 syncGuardMode 的日志配对：一个记"整体替换"，一个记"单条更新"，
  // 合起来就能还原任意时刻缓存里有什么、是哪一步变成这样的。
  diagnose(`缓存载入：${cachedModes.size} 个会话的默认执行体（源自磁盘）`)
}

/** Update ONE session's cached choice. Synchronous on purpose. */
export function syncGuardMode(sessionKey, id) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  const normalized = id === '' || id === 'off' || id === undefined || id === null ? null : String(id)
  if (normalized === null) cachedModes.delete(key)
  else cachedModes.set(key, normalized)
  // 记一行：这是**唯一**能在不落盘的情况下改变内存缓存的地方。
  //
  // 加它的原因是一次真实的排查：2026-09-22 晚上发现「提示段说默认执行体是 X，而磁盘
  // 上这个会话根本没有记录」——界面（读磁盘）显示"不指定"，模型（读内存）却被告知是
  // X。两条路都读各自的来源、各自都"没错"，但用户会看到自相矛盾的画面。
  // 当时无法从进程外面判定缓存是被谁、在什么时候改的。这条日志就是为下次准备的：
  // 每次缓存变动都有时间戳和值，能直接对上磁盘文件的写入时间。
  //
  // 量很小：一次 UI 切换一行。
  diagnose(`缓存更新：会话 ${key} 的默认执行体 = ${normalized === null ? '（未指定）' : normalized}`)
  return normalized
}

/**
 * The choice for one session, read LIVE from the cache (no turn locking).
 *
 * This is the primitive `modeForTurn` builds on. Production readers (the prompt
 * section and the tool guard) deliberately call `modeForTurn` instead, so that a
 * mode switch cannot change the executor of a message already being processed.
 * Exposed mainly so tests can exercise both the live and the locked behaviour.
 */
export function cachedGuardMode(sessionKey) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  return cachedModes.get(key) ?? null
}

/**
 * Mode SNAPSHOTS, one per turn: `AbortSignal` -> mode id (or null).
 *
 * The mode is LOCKED for the whole turn. Without this, a switch made while an
 * agent is still thinking would apply to the very turn that is in flight: DSH
 * re-assembles the system prompt on EVERY step and evaluates the guard on EVERY
 * tool call, so mid-turn the section text and the gate would both flip — and a
 * call that was legitimate a second earlier could be denied. That is
 * disorienting: you send one message and get two different executors.
 *
 * The turn-level `AbortSignal` identifies a turn exactly, and the SAME object
 * reaches both readers:
 *   - the prompt assembly context (`assembleContextFor(agent, signal)`)
 *   - every tool execution (`exec.signal`, built in `executeToolCalls`)
 * so whichever runs first pins the mode and the rest of the turn reuses it.
 * A new turn gets a new signal, so a switch takes effect on the next message.
 *
 * A WeakMap: a turn's snapshot must not outlive the turn.
 */
const turnModeSnapshots = new WeakMap()

/**
 * The mode governing the CURRENT TURN.
 *
 * Reads the session's mode once per turn and pins it, so a change made while the
 * agent is still thinking applies to the NEXT turn, never to the one in flight.
 * Accepts any shape carrying a session identity plus an optional `signal` — both
 * the assembly context and the tool execution qualify.
 */
export function modeForTurn(candidate) {
  const key = sessionKeyOf(candidate)
  if (key === null) return null
  const signal = candidate !== null && typeof candidate === 'object' ? candidate.signal : null
  if (signal !== null && signal !== undefined && typeof signal === 'object') {
    if (turnModeSnapshots.has(signal)) return turnModeSnapshots.get(signal)
    const snapshot = cachedGuardMode(key)
    turnModeSnapshots.set(signal, snapshot)
    return snapshot
  }
  // No turn identity (tests, or a direct call): read live, exactly as before.
  return cachedGuardMode(key)
}

/** Roster entry for an id, from the in-memory roster (synchronous). */
function entryForCached(id) {
  if (id === null || id === undefined) return null
  return cachedRoster.find((e) => e.id === id) || null
}

/**
 * Mount the routes and the dynamic prompt section.
 * @param ctx - context carrying webServer and systemPrompt.
 */
export function apply(ctx) {
  // Prime the roster synchronously, before anything can ask for a section text.
  cacheRoster(readRosterSync())

  // --- dynamic, PER-SESSION prompt section ----------------------------------
  // ONE registration whose `text` is a FUNCTION of the assembly context.
  //
  // This is the fix for the cross-session bleed. The old code re-registered a
  // single static string whenever the mode changed, so it could only ever
  // express one global choice — switching the Agent in one conversation
  // switched it in every other conversation too. DSH calls a function-typed
  // `text` on every assembly with `{ agent, scope: agent }`, so the section can
  // now answer per session, which is what "sessions are independent" requires.
  const diagnosedKeys = new Set()
  const sectionText = (context) => {
    try {
      const key = sessionKeyOf(context)
      // One diagnostic per session key, so we can confirm that DSH's agent
      // identity matches the id the browser sends. Logged once per key, never
      // per step, so a long conversation cannot flood the log.
      if (key === null) {
        if (!diagnosedKeys.has('__no-key__')) {
          diagnosedKeys.add('__no-key__')
          diagnose('提示段装配：上下文里没有会话标识（会按「未指定」处理）——若模式看起来不生效，先查这里')
        }
      } else if (!diagnosedKeys.has(key)) {
        diagnosedKeys.add(key)
        diagnose(`提示段装配：会话键 = ${key} ｜ ${describeSessionContext(context)}`)
      }
      return modeGuidance(entryForCached(modeForTurn(context)))
    } catch (error) {
      // This runs inside DSH's prompt assembly: throwing here would fail the
      // whole turn, so fall back to the neutral "no executor" text and say so.
      diagnose(`提示段装配失败（已降级为未指定）：${error && error.message ? error.message : String(error)}`)
      return modeGuidance(null)
    }
  }

  ctx.effect(() => {
    let disposeSection = null
    try {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:agent-picker',
        order: 216,
        text: sectionText,
      })
      // Logged because this registration can silently fail: DSH applies plugins
      // more than once during boot, and a duplicate section name in the same
      // layer THROWS. The catch below swallows that — and a swallowed duplicate
      // is indistinguishable from "the section is gone", which would disable the
      // mode without a single error. One line makes it visible.
      diagnose('提示段已注册（order=216，text 为函数）')
    } catch (error) {
      diagnose(`提示段注册失败（可能是重名/重复挂载）：${error && error.message ? error.message : String(error)}`)
    }
    return () => {
      try { if (typeof disposeSection === 'function') disposeSection() } catch { /* ignore */ }
      disposeSection = null
    }
  }, 'dsh-agent-picker: prompt section')

  // Load every session's choice at boot — SYNCHRONOUSLY, before returning.
  //
  // Not an effect with a promise: the section text function reads this map on
  // every assembly, and an async load leaves a window where the map is empty.
  // Worse, DSH tears effects down and rebuilds them during boot, so a pending
  // promise could resolve against a dead context and the map would stay empty
  // forever — every session would silently read as "未指定". A synchronous read
  // of a small local JSON removes the whole class of problem.
  cacheModes(readStateSync().modes)

  // --- executor tools for roster entries that bring their own command line ---
  // Agents whose tool belongs to another plugin (Claude Code / Codex via
  // dsh-sub-cli) are deliberately left alone; only self-described launchers get
  // a tool registered here.
  //
  // CRITICAL: everything here is SYNCHRONOUS, on purpose. This effect is created
  // and torn down again during boot, so registering from a promise callback ran
  // against an already-inactive ctx: the call returned a disposer and looked
  // successful, but the definition went into a dead context and the agent never
  // saw the tool ("unknown tool", while the guard — which is context-free —
  // registered fine). Do not reintroduce an await between here and register().
  ctx.effect(() => {
    let disposeTools = () => {}
    let disposeGuard = null
    diagnose('executor effect：开始同步读名册')
    const roster = readRosterSync()
    diagnose(`名册读取完成：${roster.length} 项 -> ${roster.map((e) => e.id + (e.launch ? '(launch)' : '')).join(', ')}`)
    // Prime the synchronous guard's roster cache before registering either.
    cacheRoster(roster)
    disposeTools = registerLaunchTools(ctx, roster)

    // Guard is registered alongside the tools so "only the chosen agent may
    // run" holds for borrowed tools (Claude Code / Codex) as well.
    // SIGNATURE: agentToolGuard(roster, lookupMode) -> (exec) => reason|undefined.
    // It must stay synchronous; see the warning on agentToolGuard.
    // The lookup is `modeForTurn`, not the raw cache: one message must run under
    // ONE executor even if the user switches while it is still thinking.
    if (typeof ctx.tools?.guard === 'function') {
      try {
        const predicate = agentToolGuard(roster, modeForTurn)
        if (typeof predicate !== 'function') {
          throw new Error('agentToolGuard did not return a function')
        }
        const result = ctx.tools.guard(predicate)
        disposeGuard = typeof result === 'function' ? result : null
        diagnose(`执行体闸门已注册；disposer=${typeof result}`)
      } catch (error) {
        // Never let the guard take the tool system down with it: a failed
        // registration only loses the extra hard gate, not tool calls.
        diagnose(`执行体闸门注册失败（不影响工具调用）：${error && error.message ? error.message : String(error)}`)
      }
    } else {
      diagnose('执行体闸门未注册：ctx.tools.guard 不是函数')
    }
    return () => {
      try { disposeTools() } catch { /* ignore */ }
      try { if (typeof disposeGuard === 'function') disposeGuard() } catch { /* ignore */ }
    }
  }, 'dsh-agent-picker: executor tools')

  // --- routes ---------------------------------------------------------------
  ctx.effect(() => {
    const json = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 65536) raw = raw.slice(0, 65536) })
      req.on('end', () => resolve(raw))
      req.on('error', () => resolve(''))
    })

    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh')
        const route = url.pathname.replace(/^\/dsh-agent-picker/, '')
        // The browser names its session explicitly. Everything below is scoped
        // to it, which is what keeps one conversation's choice from leaking into
        // another's.
        const session = url.searchParams.get('session')

        if (route === '/list') {
          const scan = await scanAgents(session)
          json(res, 200, { ok: true, ...scan })
          return
        }

        // 只读：把「模型实际收到了什么」交给 UI 显示。
        //
        // 关键点是**面板不复制任何文案**：`guidance` 来自 `modeGuidance()`，也就是
        // 提示段每次装配时调用的同一个函数。UI 里看到的字，就是模型收到的字；改了
        // 提示词，面板跟着变，不可能出现"面板说的和实际不一样"。
        //
        // 顺带把「内存」和「磁盘」两个值都报出去：正常情况下它们相同，一旦不同，
        // 面板会当场指出来——这类分歧以前只能靠人肉对比文件才能发现。
        if (route === '/inspect') {
          const key = sessionKeyOf(session)
          const disk = await readState()
          const onDisk = key !== null && disk.modes[key] ? disk.modes[key].id : null
          const live = key !== null ? cachedGuardMode(key) : null
          const entry = entryForCached(live)
          json(res, 200, {
            ok: true,
            session: key,
            mode: live,
            name: entry ? entry.name : null,
            kind: entry ? entry.kind : null,
            onDisk,
            guidance: modeGuidance(entry),
            gate: GATE_RULES,
            notes: GATE_NOTES,
            turnLocked: true,
          })
          return
        }

        if (route === '/mode' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : 'off'
          const target = parsed && typeof parsed.session === 'string' ? parsed.session : session
          if (sessionKeyOf(target) === null) {
            json(res, 400, { ok: false, error: 'missing session: refuse to write a session-less mode' })
            return
          }
          const stored = await writeMode(target, id)
          // 写盘失败时**不**更新缓存。
          // 更新了就会内存与磁盘分歧：本进程按新模式跑、重启后静默回退，用户看到的
          // 却是"切换成功"。宁可明确失败（内存保持磁盘的真相），也不要这种假成功。
          if (!stored.persisted) {
            json(res, 500, {
              ok: false,
              error: '模式没有保存到磁盘（' + dshHomePath() + ' 写不进去），本次切换已放弃',
            })
            return
          }
          // Keep the synchronous readers current before the next turn/tool call.
          syncGuardMode(target, stored.id)
          json(res, 200, { ok: true, id: stored.id, session: sessionKeyOf(target) })
          return
        }

        // Enable an agent (persist it into the roster's enabled set) without
        // necessarily switching to it. Used by the UI's "可安装" section.
        if (route === '/enable' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : null
          if (id === null) { json(res, 400, { ok: false, error: 'missing id' }); return }
          const result = await withStateLock(async () => {
            const state = await readState()
            const enabled = state.enabled.includes(id) ? state.enabled : [...state.enabled, id]
            // Clear any earlier "removed" mark, otherwise the explicit-enable
            // branch would be overruled by the disabled set on the next scan.
            const disabled = state.disabled.filter((x) => x !== id)
            const persisted = await writeState({ modes: state.modes, enabled, disabled })
            return { enabled, disabled, persisted }
          })
          if (!result.persisted) {
            json(res, 500, { ok: false, error: '启用没有保存到磁盘，本次改动已放弃' })
            return
          }
          json(res, 200, { ok: true, enabled: result.enabled, disabled: result.disabled })
          return
        }

        // Remove an agent from the picker: record it in `disabled` so the
        // auto-enable rule cannot resurrect it, drop it from `enabled`, and drop
        // it from every session that had chosen it (an agent that is gone from
        // the menu must not remain anyone's silent default executor).
        if (route === '/disable' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : null
          if (id === null) { json(res, 400, { ok: false, error: 'missing id' }); return }
          const result = await withStateLock(async () => {
            const state = await readState()
            const enabled = state.enabled.filter((x) => x !== id)
            const disabled = state.disabled.includes(id) ? state.disabled : [...state.disabled, id]
            const modes = {}
            for (const [k, v] of Object.entries(state.modes)) {
              if (v && v.id === id) continue
              modes[k] = v
            }
            const persisted = await writeState({ modes, enabled, disabled })
            return { enabled, disabled, modes, persisted }
          })
          if (!result.persisted) {
            json(res, 500, { ok: false, error: '移除没有保存到磁盘，本次改动已放弃' })
            return
          }
          // Refresh the synchronous views from what was actually persisted.
          cacheModes(result.modes)
          json(res, 200, { ok: true, enabled: result.enabled, disabled: result.disabled })
          return
        }

        json(res, 404, { ok: false, error: 'unknown route: ' + route })
      } catch (error) {
        try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* ignore */ }
      }
    }

    return ctx.webServer.register({ kind: 'prefix', path: '/dsh-agent-picker', handler })
  }, 'dsh-agent-picker: routes')
}
