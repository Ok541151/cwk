// dsh-agent-picker browser half.
//
// Self-contained by hand (no bundler, no build step, zero dependencies): the DSH
// client module system wraps this in a CJS factory via window.__ModuleLoader__,
// and the kernel adopts { apply, inject } off the returned module.exports as a
// client plugin. React comes from the factory's own `require`.
//
// A MODE selector, like the reasoning-effort dropdown — but built for a machine
// that will accumulate MANY agents, so the menu is a manageable LIST rather than
// a fixed pair of rows:
//
//   ┌ 不指定 Agent              ← plain DSH conversation
//   │ ✓ Claude Code         ×   ← enabled: selectable, removable
//   │   Codex               ×
//   ├ ▸ 可安装 (2)              ← collapsed; only installable-but-not-enabled
//   └ C:\AgentTools\...json     ← footer: where the roster lives / how to add
//
// Selecting an agent POSTs it to the host as the conversation's default
// executor; the routing itself lives entirely on the host side (its
// system-prompt section is re-read on every step), so nothing is added to the
// user's message and nothing is inserted into the draft.
//
// Every failure is logged, never thrown: a throw from apply fails the whole web
// shell boot.
window.__ModuleLoader__.load({
  id: 'dsh-agent-picker',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Required services: the slot registry. */
    exports.inject = ['slots']

    // Inline styles only — no stylesheet, no theme coupling, nothing global.
    const buttonStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', fontSize: 12, lineHeight: '18px',
      border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
      background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    }
    const buttonOnStyle = { borderColor: 'rgba(80,150,255,0.75)', background: 'rgba(80,150,255,0.14)' }
    const menuStyle = {
      position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
      minWidth: 320, maxWidth: 380, padding: 4,
      border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8,
      background: 'Canvas', color: 'CanvasText', boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
      zIndex: 2147483000, maxHeight: 420, overflowY: 'auto',
    }
    const rowStyle = {
      display: 'flex', alignItems: 'center', gap: 6, width: '100%',
      // 右边距从 8 收到 3：× 离菜单边缘原本是「菜单内边距 4 + 行内边距 8 = 12px」，
      // 贴得太紧。收窄后整排右侧图标（? 和 ×）一起内移，两者仍对齐。
      padding: '6px 3px 6px 8px', border: 'none', borderRadius: 6,
      background: 'transparent', color: 'inherit', fontSize: 12,
      textAlign: 'left', cursor: 'pointer',
    }
    const rowOnStyle = { background: 'rgba(80,150,255,0.16)' }
    const rowOffStyle = { opacity: 0.45, cursor: 'not-allowed' }
    const bodyStyle = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 }
    const nameStyle = { fontWeight: 600 }
    // Kind badge next to the agent name. "任务型" vs "对话型" changes what the
    // user should expect: a task agent's result gets summarised back, a chat
    // agent's reply is relayed verbatim. Worth one small pill.
    const nameRowStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
    const kindBadgeStyle = {
      flex: '0 0 auto', fontSize: 9, lineHeight: '15px', padding: '0 6px',
      borderRadius: 8, border: '1px solid rgba(127,127,127,0.4)',
      opacity: 0.75, whiteSpace: 'nowrap', fontWeight: 400,
    }
    const kindChatBadgeStyle = { borderColor: 'rgba(80,150,255,0.65)', opacity: 0.95 }
    // WRAPPING hint for agent rows. These strings are real information — tool
    // name + gateway address + endpoint + caveats — and they get long enough
    // that a single truncated line hid the tail completely (the OpenClaw row
    // lost "走 DeepSeek 端点 · 需网关在跑" behind an ellipsis with no way to
    // read it). Wrapping costs a little height; the menu scrolls.
    const hintWrapStyle = {
      fontSize: 10, opacity: 0.65, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '14px',
    }
    // Icon buttons (remove / add). A 22x22 square keeps the glyph big enough to
    // read and the hit target big enough to click; the hover background makes it
    // obvious the row has its own control separate from the select action.
    const ICON_SIZE = 22
    const iconBase = {
      flex: '0 0 auto',
      width: ICON_SIZE, height: ICON_SIZE, lineHeight: (ICON_SIZE - 2) + 'px',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid transparent', borderRadius: 6,
      background: 'transparent', color: 'inherit',
      fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: 0,
      transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
    }
    const removeIconStyle = Object.assign({}, iconBase, { opacity: 0.7 })
    const addIconStyle = Object.assign({}, iconBase, { opacity: 0.8 })
    const hoverIn = (event, danger) => {
      try {
        event.currentTarget.style.background = danger ? 'rgba(220,60,60,0.16)' : 'rgba(80,150,255,0.18)'
        event.currentTarget.style.borderColor = danger ? 'rgba(220,60,60,0.45)' : 'rgba(80,150,255,0.5)'
        event.currentTarget.style.opacity = '1'
      } catch (error) { /* hover polish must never break the menu */ }
    }
    const hoverOut = (event, base) => {
      try {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.borderColor = 'transparent'
        event.currentTarget.style.opacity = base
      } catch (error) { /* ignore */ }
    }
    const dotStyle = { flex: '0 0 auto', width: 6, height: 6, borderRadius: 3, background: 'rgb(80,150,255)' }
    const spacerStyle = { flex: '0 0 auto', width: 6 }
    // Capability text. The "good at" line is promoted above the technical hint
    // because it is what the user actually chooses on; the expanded blurb is
    // dimmer and wraps freely.
    const expertiseStyle = {
      fontSize: 12.5, opacity: 0.95, whiteSpace: 'normal', wordBreak: 'break-word',
      lineHeight: 1.5, letterSpacing: '0.01em',
    }
    // 展开后的详细能力。字号特意放大到 12、行高 1.75、透明度提到 0.86：
    // 这里是用户真正要读的内容，原来 10.5px + 0.72 太小太淡，看久了费眼。
    //
    // whiteSpace 必须是 pre-wrap（原来是 normal）：名册里的详细介绍用换行排成
    // 「1. 2. 3.」编号列表，而 normal 会把换行折叠成空格，整块挤成一坨。
    // pre-wrap 既保留我们写的换行，又照常自动折行。
    const descStyle = {
      fontSize: 12, opacity: 0.86, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.22)',
      lineHeight: 1.75, letterSpacing: '0.01em',
    }
    // 「怎么补启动配方」的引导块。刻意做得低对比、小字号：它是给第一次用的人
    // 看的一步步说明，不该在没点开时抢走注意力。
    const guideStyle = {
      marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(127,127,127,0.3)',
      fontSize: 12, lineHeight: 1.7, opacity: 0.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }
    const guideLineStyle = { display: 'block', marginBottom: 3 }
    const codeStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11.5, padding: '6px 8px', marginTop: 4, marginBottom: 4,
      whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all',
      background: 'rgba(127,127,127,0.12)', borderRadius: 4,
    }
    const miniBtnStyle = {
      fontSize: 11, padding: '1px 7px', marginLeft: 6, borderRadius: 4, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit',
      opacity: 0.85,
    }
    const infoIconStyle = Object.assign({}, iconBase, { opacity: 0.7, fontSize: 13 })
    const secStyle = {
      margin: '6px 0 3px', padding: '5px 8px 3px', fontSize: 11, opacity: 0.68,
      borderTop: '1px solid rgba(127,127,127,0.25)', display: 'flex', alignItems: 'center', gap: 4,
      cursor: 'pointer', userSelect: 'none', letterSpacing: '0.02em',
    }
    const footStyle = {
      marginTop: 6, padding: '5px 8px 3px', fontSize: 11, opacity: 0.55,
      borderTop: '1px solid rgba(127,127,127,0.25)', wordBreak: 'break-all', lineHeight: 1.6,
    }
    // 左下角那块「机制说明」。默认收起，只占一行；展开后在菜单里就地显示详情。
    const inspectBoxStyle = {
      borderTop: '1px solid rgba(127,127,127,0.25)',
      padding: '4px 8px 6px', fontSize: 11, textAlign: 'left',
    }
    const inspectToggleStyle = {
      display: 'block', width: '100%', textAlign: 'left',
      background: 'transparent', border: 'none', color: 'inherit',
      font: 'inherit', fontSize: 12.5, fontWeight: 600, padding: '4px 0',
      cursor: 'pointer', opacity: 0.92,
    }
    const inspectBodyStyle = {
      marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6,
    }
    const inspectHeadStyle = { fontWeight: 600 }
    const inspectLabelStyle = { opacity: 0.6, fontSize: 10 }
    const inspectWarnStyle = {
      color: 'crimson', background: 'rgba(255,0,0,0.08)',
      padding: '4px 6px', borderRadius: 4,
    }
    const inspectPreStyle = {
      margin: 0, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 10.5, lineHeight: 1.5,
      background: 'rgba(127,127,127,0.12)', borderRadius: 4,
      maxHeight: 220, overflow: 'auto',
    }
    const inspectUlStyle = { margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }
    const errStyle = { padding: '6px 8px', fontSize: 12, color: 'crimson' }
    const mutedStyle = { padding: '6px 8px', fontSize: 12, opacity: 0.65 }

    // Copy for the "no agent" row.
    //
    // It is deliberately NOT part of the roster data file: that file lists
    // external Agents, and this row is the absence of one. Wording changes go
    // right here. The row still gets the same treatment as an agent row (a
    // one-line summary plus an expandable explanation), because "不指定" is a
    // real, commonly-used choice and users could not tell what it does.
    const OFF_ROW_ID = '__off'
    const OFF_LABEL = '不指定 Agent'
    const OFF_EXPERTISE = '擅长：普通对话、临时点名某个 Agent、不接管你的消息'
    const OFF_DESC = '不把任何外部 Agent 设为默认执行体：每条消息都由 DSH 自己的模型回答。'
      + '注意 Agent 工具并没有被禁用——你仍然可以临时点名，例如「让 Codex 跑一下这个脚本」。'
      + '想让某个 Agent 长期接管你的消息，就选中上面那一行：之后你每说一句话都默认交给它执行，'
      + '不必再重复提它的名字。（再次点它即可取消。）'
      + '★ 这个选择是【按会话】的——只影响当前这个对话，其他会话各自独立。'

    async function api(path, options) {
      try {
        const res = await fetch('/dsh-agent-picker' + path, Object.assign({
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        }, options || {}))
        const json = await res.json()
        return json && json.ok === true ? json : null
      } catch (error) {
        console.warn('[dsh-agent-picker] api ' + path + ' failed:', error)
        return null
      }
    }

    // Every request names the session it belongs to.
    //
    // The slot `conversation.input.right` is session-scoped and DSH passes
    // `sessionId` among its standard props, so this component knows exactly
    // which conversation it is drawing controls for. Sending it is what keeps
    // the Agent choice per-conversation: without it the host has one global
    // value and every session follows whatever was clicked last.
    const fetchState = (sessionId) => api('/list' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''))
    const postMode = (sessionId, id) => api('/mode', { method: 'POST', body: JSON.stringify({ session: sessionId, id }) })
    const postEnable = (id) => api('/enable', { method: 'POST', body: JSON.stringify({ id }) })
    const postDisable = (id) => api('/disable', { method: 'POST', body: JSON.stringify({ id }) })

    /** The composer control: shows the active executor, opens the agent list. */
    function AgentModeButton(props) {
      // Injected by the session-scoped slot. Absent only outside a conversation,
      // where a per-session choice has no meaning anyway.
      const sessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)   // { agents, active, dir, rosterFile }
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [showInstallable, setShowInstallable] = React.useState(false)
      const [expandedId, setExpandedId] = React.useState(null)
      const boxRef = React.useRef(null)

      // Monotonic request id, so a response that is no longer about the session
      // on screen can be discarded.
      //
      // Arrival order is not a reliable signal: switching conversations while a
      // `/list` is still in flight let the OLD session's payload land last, so
      // the control showed the other conversation's Agent — the exact symptom
      // the per-session fix exists to remove, just with a short window. The
      // reset below narrows that window but cannot close it, because the stale
      // response still arrives afterwards and re-fills the state.
      const reqRef = React.useRef(0)
      // 左下角「机制说明」的状态。默认收起。
      const [showInspect, setShowInspect] = React.useState(false)
      const [inspect, setInspect] = React.useState(null)
      const [inspectErr, setInspectErr] = React.useState(null)

      // 哪一行的「怎么补启动配方」引导是展开的。默认全收起 —— 引导只在
      // 用户主动点开时才出现，平时不占地方（"看得懂且不烦"）。
      const [recipeHelpId, setRecipeHelpId] = React.useState(null)
      // 刚复制过的行 id，用来把按钮短暂改成"已复制"给出反馈。
      const [copiedId, setCopiedId] = React.useState(null)

      // 说明内容由宿主端算（/inspect），这里不复制任何文案：
      // 面板要显示的是「模型实际收到的那段指令」，它只有一个来源。
      const loadInspect = () => {
        if (sessionId === null) return
        api('/inspect?session=' + encodeURIComponent(sessionId)).then((next) => {
          if (next === null) { setInspectErr('读取不到机制说明'); setInspect(null); return }
          setInspectErr(null)
          setInspect(next)
        })
      }
      // The CURRENT session, readable from inside a stale callback. Comparing
      // the echoed `session` against the closure's own `sessionId` would be
      // useless — a request's closure always holds the session it was made for,
      // so that comparison can never fail. (It was written that way first, and a
      // mutation test showed it caught nothing.) A ref is what makes it a real
      // second check, independent of the sequence token.
      const currentSessionRef = React.useRef(sessionId)

      const reload = React.useCallback(() => {
        if (sessionId === null) { setError('这个控件只在会话内可用'); return }
        const seq = ++reqRef.current
        fetchState(sessionId).then((next) => {
          if (seq !== reqRef.current) return          // 已被更晚的请求取代，丢弃
          if (next !== null && next.session !== undefined && next.session !== currentSessionRef.current) return
          if (next === null) setError('无法读取 Agent 列表')
          else { setState(next); setError(null) }
        })
      }, [sessionId])

      // On a session change, drop the previous session's data BEFORE fetching.
      // The slot may reuse this component across sessions; without the reset the
      // label would briefly show the OTHER conversation's Agent, which is
      // exactly the symptom this per-session fix exists to remove.
      React.useEffect(() => {
        currentSessionRef.current = sessionId
        setState(null)
        setError(null)
        setOpen(false)
        setExpandedId(null)
        reload()
      }, [reload])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          try { if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false) }
          catch (err) { console.warn('[dsh-agent-picker] outside-click failed:', err) }
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // 连点保护用 ref，不用 state。
      // state 要等这次渲染完成后才更新，而按钮的 onClick 在更新前仍是**上一次
      // 渲染的闭包**（里面读到的 busy 还是 false）——那一瞬间连点照样穿过去。
      // ref 是同一个对象，任何闭包读到的都是当前值。
      const busyRef = React.useRef(false)

      const act = (makeRequest) => {
        // 上一次请求还在飞就忽略这次点击。
        // 参数必须是**函数**：调用点原来写的是 act(postMode(...))，参数在进入这里
        // 之前就求值了，等判断出 busy 时请求早已发出。传函数才能由这里决定要不要发。
        if (busyRef.current) return
        busyRef.current = true
        let promise
        try {
          setBusy(true)
          promise = makeRequest()
        } catch (err) {
          busyRef.current = false
          setBusy(false)
          console.warn('[dsh-agent-picker] action threw:', err)
          return
        }
        promise.then(() => { busyRef.current = false; setBusy(false); reload() })
          .catch((err) => {
            busyRef.current = false
            setBusy(false)
            console.warn('[dsh-agent-picker] action failed:', err)
          })
      }

      const choose = (id) => {
        if (state && state.active === id) { act(() => postMode(sessionId, 'off')); return }  // 再点一次 = 取消
        act(() => postMode(sessionId, id))
      }

      const list = state && Array.isArray(state.agents) ? state.agents : []
      const enabled = list.filter((a) => a && a.enabled === true)
      const installable = list.filter((a) => a && a.enabled !== true)
      const active = enabled.find((a) => a.id === (state && state.active)) || null
      const label = busy ? '切换中…' : (active ? active.name : '不指定 Agent')

      const rows = []

      // Always first: plain conversation. Structured like an agent row so the
      // choice is explained the same way, minus the remove button (there is
      // nothing to remove).
      const offExpanded = expandedId === OFF_ROW_ID
      rows.push(h('div', {
        key: '__off',
        style: Object.assign({}, rowStyle, active === null ? rowOnStyle : null, { cursor: 'default' }),
      },
        active === null ? h('span', { style: dotStyle }) : h('span', { style: spacerStyle }),
        h('button', {
          type: 'button',
          onClick: () => act(() => postMode(sessionId, 'off')),
          title: '不指定默认执行体：按普通对话处理，仍可临时点名某个 Agent（只影响本会话）',
          style: {
            flex: '1 1 auto', minWidth: 0, textAlign: 'left', border: 'none',
            background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0,
            display: 'flex', flexDirection: 'column', gap: 2,
          },
        },
          h('span', { style: nameStyle }, OFF_LABEL),
          h('span', { style: expertiseStyle }, OFF_EXPERTISE),
          h('span', { style: hintWrapStyle },
            active === null ? '当前状态 · 普通对话（DSH 自己的模型）' : '普通对话（DSH 自己的模型）'),
          offExpanded ? h('span', { style: descStyle }, OFF_DESC) : null,
        ),
        h('button', {
          type: 'button',
          onClick: () => setExpandedId(offExpanded ? null : OFF_ROW_ID),
          onMouseEnter: (event) => hoverIn(event, false),
          onMouseLeave: (event) => hoverOut(event, 0.7),
          title: offExpanded ? '收起说明' : '展开说明：不指定 Agent 是什么意思',
          'aria-label': (offExpanded ? '收起 ' : '展开 ') + OFF_LABEL + ' 的说明',
          style: Object.assign({}, infoIconStyle, offExpanded ? { opacity: 1 } : null),
        }, offExpanded ? '−' : '?'),
      ))

      if (state === null) {
        rows.push(h('div', { key: '__loading', style: mutedStyle }, error === null ? '读取中…' : error))
      } else if (enabled.length === 0) {
        // 空列表时的引导：两句话就够，别把新用户糊一脸。
        // 不硬编码安装命令 —— 各家安装方式变化很快，写死的话过几个月就是错的。
        rows.push(h('div', { key: '__none', style: mutedStyle }, '还没有发现任何 Agent CLI'))
        rows.push(h('div', { key: '__none2', style: hintWrapStyle },
          '这个插件只负责调度，不附带 Agent。先装一个（Claude Code、Codex、Cursor…），重启 DSH 后会自动出现。'))
      } else {
        for (const entry of enabled) {
          const on = active !== null && active.id === entry.id
          const expanded = expandedId === entry.id
          const hasDesc = typeof entry.desc === 'string' && entry.desc !== ''
          rows.push(h('div', {
            key: entry.id,
            style: Object.assign({}, rowStyle, on ? rowOnStyle : null, { cursor: 'default' }),
          },
            on ? h('span', { style: dotStyle }) : h('span', { style: spacerStyle }),
            h('button', {
              type: 'button',
              onClick: () => choose(entry.id),
              title: entry.installed
                ? '选为默认执行体（再点一次取消）'
                : ('未找到 ' + entry.path + ' —— 仍可选，但调用会失败'),
              style: {
                flex: '1 1 auto', minWidth: 0, textAlign: 'left', border: 'none',
                background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0,
                display: 'flex', flexDirection: 'column', gap: 2,
              },
            },
              h('span', { style: nameRowStyle },
                h('span', { style: nameStyle }, entry.name),
                entry.kind === 'chat'
                  ? h('span', {
                    style: Object.assign({}, kindBadgeStyle, kindChatBadgeStyle),
                    title: '对话型：你的消息会被原样转交给它，它的回答也会被原样转述',
                  }, '对话型')
                  : h('span', {
                    style: kindBadgeStyle,
                    title: '任务型：你的消息被当作任务派给它，结果会概括后返回',
                  }, '任务型'),
              ),
              // Capability summary first — what it is good at matters more to the
              // choice than which tool name backs it.
              entry.expertise
                ? h('span', { style: expertiseStyle }, entry.expertise)
                : null,
              h('span', {
                style: hintWrapStyle,
                // Full text on hover as well, in case the menu is narrow.
                title: (on ? '当前执行体' : (entry.installed ? entry.tool : '未找到 CLI'))
                  + (entry.note ? ' · ' + entry.note : ''),
              },
                (on ? '当前执行体' : (entry.installed ? entry.tool : '未找到 CLI'))
                + (entry.note ? ' · ' + entry.note : '')),
              expanded && hasDesc
                ? h('span', { style: descStyle }, entry.desc)
                : null,
            ),
            hasDesc
              ? h('button', {
                type: 'button',
                onClick: () => setExpandedId(expanded ? null : entry.id),
                onMouseEnter: (event) => hoverIn(event, false),
                onMouseLeave: (event) => hoverOut(event, 0.7),
                title: expanded ? '收起能力介绍' : '展开能力介绍',
                'aria-label': (expanded ? '收起 ' : '展开 ') + entry.name + ' 的能力介绍',
                style: Object.assign({}, infoIconStyle, expanded ? { opacity: 1 } : null),
              }, expanded ? '−' : '?')
              : null,
            h('button', {
              type: 'button',
              onClick: () => act(() => postDisable(entry.id)),
              onMouseEnter: (event) => hoverIn(event, true),
              onMouseLeave: (event) => hoverOut(event, 0.7),
              title: '从列表移除（不影响已安装的 CLI）',
              'aria-label': '移除 ' + entry.name,
              style: removeIconStyle,
            }, '×'),
          ))
        }
      }

      // Collapsed area for agents that are listed but not enabled yet, so a
      // machine with many future agents does not drown the selectable list.
      if (installable.length > 0) {
        rows.push(h('div', {
          key: '__sec', style: secStyle,
          onClick: () => setShowInstallable((v) => !v),
        }, (showInstallable ? '▾ ' : '▸ ') + '可安装 (' + installable.length + ')'))
        if (showInstallable) {
          for (const entry of installable) {
            const helpOpen = recipeHelpId === entry.id
            rows.push(h('div', { key: entry.id, style: Object.assign({}, rowStyle, { cursor: 'default' }) },
              h('span', { style: spacerStyle }),
              h('span', { style: bodyStyle },
                h('span', { style: nameStyle }, entry.name),
                entry.expertise ? h('span', { style: expertiseStyle }, entry.expertise) : null,
                h('span', { style: hintWrapStyle },
                  (entry.installed ? 'CLI 已就位' : 'CLI 未安装') + (entry.note ? ' · ' + entry.note : '')),
                // 这一区恰恰最需要介绍：里面装的都是"检测到了但还不能用"的成员，
                // 用户得先看懂它是干什么的，才愿意去补那条 launch 配方。
                // 之前只渲染 name/expertise/note，desc 存了却一个字都不显示。
                entry.desc ? h('span', { style: descStyle }, entry.desc) : null,
                // 识别到但没配方 —— 不要只丢下一句"需配置"就走人。
                // 这里给一个可点开的引导：路径和 exe 插件自己知道，直接填好给他，
                // 他只需要查一次 --help、改一行 argv、重启。
                entry.needsRecipe
                  ? h('button', {
                    type: 'button',
                    onClick: () => setRecipeHelpId(helpOpen ? null : entry.id),
                    style: miniBtnStyle,
                    title: helpOpen ? '收起' : '三步把它变成可用',
                  }, helpOpen ? '收起 ▲' : '怎么补？▼')
                  : null,
                entry.needsRecipe && helpOpen
                  ? (() => {
                    const sep = String((state && state.conventionDir) || '').includes('\\') ? '\\' : '/'
                    const dir = (state && state.conventionDir) || '.dsh/agent-picker.d'
                    const file = dir + sep + entry.id + '.agent.json'
                    const probe = '"' + entry.path + '" --help'
                    const tpl = JSON.stringify({
                      id: entry.id,
                      name: entry.name,
                      tool: entry.tool,
                      kind: 'task',
                      launch: { bin: entry.path, argv: ['-p', '{task}'] },
                    }, null, 2)
                    const copy = (text) => {
                      try {
                        if (typeof navigator !== 'undefined' && navigator.clipboard) {
                          navigator.clipboard.writeText(text)
                          setCopiedId(entry.id)
                        }
                      } catch { /* 没有剪贴板就让他自己选中复制 */ }
                    }
                    return h('div', { style: guideStyle },
                      h('span', { style: guideLineStyle }, '它还差一条启动配方 —— 三步补上：'),
                      h('span', { style: guideLineStyle }, '1. 看它有哪些参数：'),
                      h('div', { style: codeStyle }, probe,
                        h('button', { type: 'button', style: miniBtnStyle, onClick: () => copy(probe) },
                          copiedId === entry.id ? '已复制' : '复制')),
                      h('span', { style: guideLineStyle }, '2. 找“一次性执行”的标志：--prompt / -p / exec / run 之类'),
                      h('span', { style: guideLineStyle }, '3. 存成这个文件（id / 名字 / 路径我已经填好，你只改 argv）：'),
                      h('div', { style: codeStyle }, file + '\n' + tpl,
                        h('button', { type: 'button', style: miniBtnStyle, onClick: () => copy(tpl) },
                          copiedId === entry.id ? '已复制' : '复制模板')),
                      h('span', { style: guideLineStyle }, '存好后重启 DSH，它就会出现在上面的可选列表里。'),
                    )
                  })()
                  : null,
              ),
              h('button', {
                type: 'button',
                onClick: () => act(() => postEnable(entry.id)),
                onMouseEnter: (event) => hoverIn(event, false),
                onMouseLeave: (event) => hoverOut(event, 0.8),
                title: '加入到可选列表',
                'aria-label': '启用 ' + entry.name,
                style: addIconStyle,
              }, '＋'),
            ))
          }
        }
      }

      if (state && typeof state.rosterFile === 'string') {
        rows.push(h('div', { key: '__foot', style: footStyle },
          '目录：' + state.rosterFile + '　加 Agent 就编辑它'))
      }

      // 左下角的「机制说明」：默认收起成一行，点开就地展开。
      //
      // 展开的内容全部来自宿主的 /inspect，**这里一个字都不抄**。原因很实在：面板
      // 要回答的是"模型到底被要求做什么"，如果客户端另抄一份，迟早和真正的提示词
      // 对不上——而"同一件事有两份说法"正是这个插件历史上反复出问题的地方。
      rows.push(h('div', { key: '__inspect', style: inspectBoxStyle },
        h('button', {
          type: 'button',
          onClick: () => {
            const next = !showInspect
            setShowInspect(next)
            if (next) loadInspect()
          },
          title: '展开看：模型实际收到的指令原文、执行体闸门的判定规则',
          'aria-expanded': showInspect,
          style: inspectToggleStyle,
        }, (showInspect ? '▾ ' : '▸ ') + '机制说明：模型收到了什么'),

        showInspect ? h('div', { style: inspectBodyStyle },
          inspectErr ? h('div', { style: inspectWarnStyle }, inspectErr) : null,
          (inspect === null && inspectErr === null) ? h('div', { style: inspectLabelStyle }, '读取中…') : null,
          inspect !== null ? h('div', { style: inspectBodyStyle },
            h('div', { style: inspectHeadStyle },
              '本会话：' + (inspect.name
                ? inspect.name + '（' + (inspect.kind === 'chat' ? '对话型' : '任务型') + '）'
                : '未指定执行体')),
            // 内存与磁盘不一致时当场指出来。正常情况下两者相同；真出现分歧时，
            // 这一行比翻文件快得多。
            inspect.onDisk !== inspect.mode
              ? h('div', { style: inspectWarnStyle },
                '⚠ 内存与磁盘不一致：磁盘记的是 ' + JSON.stringify(inspect.onDisk)
                + '，下一个回合会用 ' + JSON.stringify(inspect.mode))
              : null,
            h('div', { style: inspectLabelStyle }, '模型每回合都会收到这段指令（原文）：'),
            h('pre', { style: inspectPreStyle }, String(inspect.guidance || '')),
            h('div', { style: inspectLabelStyle }, '执行体闸门（工具真正被调用时判定）：'),
            h('ul', { style: inspectUlStyle },
              (Array.isArray(inspect.gate) ? inspect.gate : []).map((rule, i) => h('li', { key: i }, rule))),
            h('div', { style: inspectLabelStyle }, '性质与边界：'),
            // 同样来自宿主。这里**故意不写兜底文案**：兜底就等于又留了一份副本，
            // 而"面板说的和实际不一样"正是这块面板要消灭的问题。
            (Array.isArray(inspect.notes) && inspect.notes.length > 0)
              ? h('ul', { style: inspectUlStyle },
                inspect.notes.map((note, i) => h('li', { key: i }, note)))
              : null,
          ) : null,
        ) : null,
      ))

      return h('div', { ref: boxRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          disabled: sessionId === null,
          onClick: () => { setOpen((v) => !v); if (!open) reload() },
          title: sessionId === null
            ? '这个控件只在会话内可用（拿不到会话 id）'
            : (active
              ? ('本会话的默认执行体：' + active.name + '（每条消息自动派给它）——只影响本会话；切换从下一条消息生效')
              : '选择本会话的默认执行体（外部 Agent）——只影响本会话；切换从下一条消息生效'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          style: Object.assign(
            {},
            buttonStyle,
            active ? buttonOnStyle : null,
            sessionId === null ? { opacity: 0.5, cursor: 'not-allowed' } : null,
          ),
        },
          active ? h('span', { style: Object.assign({}, dotStyle, { display: 'inline-block' }) }) : null,
          label,
          h('span', { style: { marginLeft: 2, fontSize: 10, opacity: 0.7 } }, '▾'),
        ),
        open ? h('div', { role: 'menu', style: menuStyle }, rows) : null,
      )
    }

    /** Mount the mode control into the composer's right tool row. */
    exports.apply = function apply(ctx) {
      try {
        ctx.effect(
          () => ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              { name: 'conversation.input.right', id: 'agent-picker', order: 90, label: 'Agent mode' },
              AgentModeButton,
            ),
          ),
          'dsh-agent-picker: composer mode control',
        )
      } catch (error) {
        console.warn('[dsh-agent-picker] mount failed:', error)
      }
    }

    return module.exports
  },
})
