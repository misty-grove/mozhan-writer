/**
 * DSH Agent 事件流解析（NDJSON）。
 *
 * # 为什么单独一个文件
 *
 * 和 `core/ai.ts` 只管 OpenAI 协议一个道理：**协议知识集中在一处**。
 * Rust 侧 `commands/agent.rs` 只负责把行搬过来，认不认得由这里决定 ——
 * DSH 换字段名时只需要改这个文件，不用动 Rust、不用动 UI。
 *
 * # 事件形状是**实测**出来的，不是照文档写的
 *
 * 2026-10-10 用 `dsh --profile headless --json "…"` 跑了一次真实任务，
 * 逐行抄下来的类型如下（本机 dsh 0.2.0-rc.2）：
 *
 * ```jsonc
 * {"type":"session","sessionId":"session-…","cwd":"E:\\…"}
 * {"type":"status","phase":"turn_start","turn":1}
 * {"type":"status","phase":"step_start"|"step_end","turn":1,"step":1,"usage":{…}}
 * {"type":"thinking","text":"…"}
 * {"type":"tool_call","callId":"…","tool":"read","input":{…}}
 * {"type":"tool_result","callId":"…","status":"completed","result":"…"}
 * {"type":"text","text":"…"}                     // 正文增量
 * {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
 * {"type":"final","text":"…"}                    // 收尾全文
 * ```
 *
 * 所以 `switch` 里出现的每个 `type` 都有实测依据。**DBH 升级后如果这里认不出
 * 事件了，先重跑一次上面那条命令核对字段，再改这个文件** —— 别凭猜加 case。
 */

export type AgentEventKind =
  | 'session'
  | 'status'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'final'
  | 'error'
  | 'unknown'

export interface AgentToolCall {
  callId: string
  tool: string
  /** 读写的目标文件（从 input 里尽力提取；提不到就空串） */
  target: string
  /** 一句话描述，直接显示给作者 */
  label: string
}

export interface AgentEvent {
  kind: AgentEventKind
  /** 原始 JSON 行（认不出时也留着，方便排查与「展开看原文」） */
  raw: string
  /** text / thinking / final 的正文 */
  text?: string
  /** tool_call 的细节 */
  call?: AgentToolCall
  /** tool_result 的成败 */
  ok?: boolean
  /** 从 session 事件里取到的会话 id */
  sessionId?: string
  /** 人类可读的一行摘要，直接进「过程」列表 */
  label: string
}

function brief(s: string, n = 120): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 工具名 → 中文动词 + 从 input 里挑出最有信息量的那个字段当目标 */
const TOOL_LABEL: Record<string, { verb: string; keys: string[] }> = {
  read: { verb: '读取', keys: ['file_path', 'path', 'pattern'] },
  write: { verb: '写入', keys: ['file_path', 'path'] },
  edit: { verb: '修改', keys: ['file_path', 'path'] },
  multiedit: { verb: '修改', keys: ['file_path', 'path'] },
  glob: { verb: '查找', keys: ['pattern', 'path'] },
  grep: { verb: '检索', keys: ['pattern', 'path'] },
  search: { verb: '检索', keys: ['query', 'pattern'] },
  bash: { verb: '执行', keys: ['command'] },
  shell: { verb: '执行', keys: ['command'] },
  task: { verb: '子任务', keys: ['description', 'prompt'] },
  webfetch: { verb: '抓取网页', keys: ['url'] },
  websearch: { verb: '联网搜索', keys: ['query'] },
  notebookedit: { verb: '改笔记', keys: ['notebook_path'] }
}

function describeTool(tool: string, input: any): AgentToolCall {
  const t = String(tool || '').toLowerCase()
  const spec = TOOL_LABEL[t]
  const inputObj = input && typeof input === 'object' ? input : {}
  let target = ''
  if (spec) {
    for (const k of spec.keys) {
      const v = inputObj[k]
      if (typeof v === 'string' && v.trim()) {
        target = v.trim()
        break
      }
    }
  }
  if (!target) {
    // 没登记的工具有什么用什么，总之别显示成空白
    for (const v of Object.values(inputObj)) {
      if (typeof v === 'string' && v.trim()) {
        target = v.trim()
        break
      }
    }
  }
  const verb = spec?.verb || tool || '调用工具'
  // 路径太长会把「过程」列表挤爆，只留末两段
  let short = target
  if (/[\\/]/.test(target)) {
    const parts = target.split(/[\\/]+/).filter(Boolean)
    short = parts.slice(-2).join('/')
  }
  return {
    callId: String(inputObj.callId || ''),
    tool: t,
    target,
    label: short ? `${verb} ${brief(short, 60)}` : verb
  }
}

/**
 * 解析一行 NDJSON。认不出的一律归到 `unknown` —— **绝不丢**，
 * 因为丢掉的往往正好是出问题的那一行（DSH 报错时字段就和平时不一样）。
 */
export function parseAgentLine(line: string): AgentEvent | null {
  const raw = String(line || '').trim()
  if (!raw) return null
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    // 不是 JSON：可能是 cmd.exe / Electron 混进来的噪声。留着但不猜。
    return { kind: 'unknown', raw, label: brief(raw) }
  }
  const type = String(j?.type || '')

  switch (type) {
    case 'session':
      return {
        kind: 'session',
        raw,
        sessionId: j.sessionId ? String(j.sessionId) : undefined,
        label: '会话已建立'
      }

    case 'status': {
      const phase = String(j.phase || '')
      // 只把「有信息量」的 phase 显示出来。step_start/step_end 每次都来，
      // 全显示的话「过程」列表会被几十行噪声淹掉，读者反而看不到工具调用。
      if (phase === 'turn_start') return { kind: 'status', raw, label: '开始思考' }
      if (phase === 'turn_end') {
        const reason = j?.reason?.kind
        return { kind: 'status', raw, label: reason === 'completed' ? '完成' : `结束（${reason || '未知'}）` }
      }
      return { kind: 'status', raw, label: '' }
    }

    case 'thinking': {
      const t = String(j.text || '')
      return { kind: 'thinking', raw, text: t, label: t ? '思考中' : '' }
    }

    case 'tool_call': {
      const call = describeTool(j.tool, j.input)
      return { kind: 'tool_call', raw, call, label: call.label }
    }

    case 'tool_result': {
      const st = String(j.status || '')
      const ok = st === 'completed' || st === 'success' || st === ''
      return {
        kind: 'tool_result',
        raw,
        ok,
        label: ok ? '' : `工具失败（${st}）`
      }
    }

    case 'text':
      return { kind: 'text', raw, text: String(j.text || ''), label: '' }

    case 'final':
      return { kind: 'final', raw, text: String(j.text || ''), label: '产出完成' }

    case 'error':
      return { kind: 'error', raw, text: String(j.message || j.text || raw), label: '出错了' }

    default:
      return { kind: 'unknown', raw, label: '' }
  }
}

/* ------------------------------------------------------------------ 增量累积 */

/**
 * 事件流的累积器。
 *
 * 为什么要有它：DSH 的 `type:"text"` 事件**每次都是一整段**（实测如此），
 * 但为了不依赖这个细节，这里按「新段落是否以已累积内容开头」来判定是追加还是替换 ——
 * 两种行为都能得到正确结果。写死了「一定追加」或「一定替换」，
 * DSH 换个输出策略就会看到重复两遍或只剩最后一段。
 */
export class AgentStream {
  private parts: string[] = []
  private joined = ''
  finalText = ''
  sessionId = ''
  /** 「过程」列表：工具调用 + 关键状态，供 UI 折叠显示 */
  steps: Array<{ kind: AgentEventKind; label: string }> = []
  errors: string[] = []
  toolCount = 0

  push(line: string): AgentEvent | null {
    const ev = parseAgentLine(line)
    if (!ev) return null
    if (ev.sessionId) this.sessionId = ev.sessionId
    if (ev.kind === 'final' && ev.text) this.finalText = ev.text
    if (ev.kind === 'tool_call') this.toolCount++
    if (ev.kind === 'error' && ev.text) this.errors.push(ev.text)
    if (ev.label) this.steps.push({ kind: ev.kind, label: ev.label })
    if (ev.kind === 'text' && ev.text) this.appendText(ev.text)
    return ev
  }

  private appendText(t: string) {
    const cur = this.parts.join('')
    if (!cur) {
      this.parts = [t]
    } else if (t.startsWith(cur)) {
      // 新段把旧段整个包含进去了 → 它是累计值，直接替换
      this.parts = [t]
    } else if (cur.endsWith(t)) {
      // 已经有的尾巴 → 重复输出，忽略
    } else {
      this.parts.push(t)
    }
    this.joined = this.parts.join('')
  }

  /** 目前攒到的正文（流式显示用；最终以 finalText 为准，没有才退化到这里） */
  get text(): string {
    return this.joined
  }

  /** 收尾：优先用 final 事件，它才是权威全文 */
  result(): string {
    return (this.finalText || this.joined).trim()
  }
}
