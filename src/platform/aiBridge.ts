/**
 * AI 网络层适配：桌面端走 Rust 命令，浏览器宿主走原生 fetch。
 *
 * 为什么需要这一层：
 * - 桌面端的页面源是 `tauri://localhost`，向第三方 API 发 fetch 属于跨域请求，
 *   服务商不回 CORS 头就是 `Failed to fetch` —— 配了 Key 也用不了；
 *   所以桌面端的 HTTP 收进 Rust（`src-tauri/src/commands/ai.rs`，全应用唯一出网点）。
 * - 浏览器宿主只能 fetch；服务商不支持 CORS 时无解（设置页有说明）。
 * - **移动端也走 fetch**：`ai_chat` / `ai_models` 那两条命令属于 `net` feature，
 *   而移动端不带它（native-tls 会把 OpenSSL 拖进交叉编译，见 Cargo.toml 的注释）。
 *   所以在手机上"有 Tauri"不等于"有 Rust 网络桥" —— 判断要问宿主。
 *
 * 两边对外暴露同一套原语：**发请求、按行收 SSE 数据**。
 * `core/ai.ts` 只管 OpenAI 兼容协议，不感知宿主差异。
 */
import { hasTauri, hostInfo } from './tauriAdapter'

export interface RawHttpOut {
  /** HTTP 状态码；0 = 请求根本没发出去（网络层失败），原因看异常或 body */
  status: number
  body: string
}

/** 收到一行 SSE 数据（已去掉 `data:` 前缀；`[DONE]` 也原样给） */
export type SseLineHandler = (dataLine: string) => void

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

/**
 * 是否该走 Rust 网络桥。
 *
 * 别写成 `hasTauri()`：安卓也住在 Tauri 壳里，但那里的 `ai_*` 命令根本不存在，
 * 照旧 invoke 只会得到一句没头没尾的 "command not found"。
 */
async function useNativeHttp(): Promise<boolean> {
  if (!hasTauri()) return false
  return !(await hostInfo()).isMobile
}

/** GET（模型列表用）。网络层失败直接抛（消息是中文），HTTP 层失败返回状态码。 */
export async function aiGet(url: string, apiKey: string): Promise<RawHttpOut> {
  if (await useNativeHttp()) {
    return tauriInvoke<RawHttpOut>('ai_models', { url, apiKey })
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal
    })
    return { status: res.status, body: await res.text().catch(() => '') }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST + SSE 流式。`onLine` 收到的是去掉 `data:` 前缀后的原始数据行。
 * 非 200 时不抛异常，返回 `{ status, body }` 让调用方决定怎么报错（与桌面桥一致）。
 */
export async function aiChatStream(
  url: string,
  apiKey: string,
  body: string,
  onLine: SseLineHandler
): Promise<RawHttpOut> {
  if (await useNativeHttp()) {
    const { Channel } = await import('@tauri-apps/api/core')
    const ch = new Channel<{ t: 'delta' | 'status'; d?: string; status?: number }>()
    ch.onmessage = (m) => {
      if (m?.t === 'delta' && typeof m.d === 'string') onLine(m.d)
      // status 事件只用于提前感知失败；最终以返回的 HttpOut 为准
    }
    return tauriInvoke<RawHttpOut>('ai_chat', { url, apiKey, body, onEvent: ch })
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal
    })
    if (res.status !== 200) {
      return { status: res.status, body: await res.text().catch(() => '') }
    }
    const reader = res.body?.getReader()
    if (!reader) throw new Error('响应没有可读流')
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (payload) onLine(payload)
      }
    }
    if (buf.trim().startsWith('data:')) onLine(buf.trim().slice(5).trim())
    return { status: 200, body: '' }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ DSH Agent 后端 */

export interface AgentRunArgs {
  task: string
  cwd: string
  sessionId?: string
  profile?: string
  /** 'read_only'（默认）| 'write_in_cwd' */
  permission?: string
  /** dsh 可执行文件路径；空则 Rust 侧自动探测 */
  cli?: string
  timeoutSecs?: number
}
export interface AgentRunResult {
  code: number
  finalText: string
  sessionId?: string
  cancelled: boolean
}

export interface AgentProbeResult {
  found: boolean
  cli?: string
  version?: string
  profiles: string[]
  hint?: string
  probeError?: string
}

/**
 * Agent 后端只在桌面端有 —— 它要 spawn 一个本机进程，浏览器做不到，
 * 移动端也没带上那条 Rust 命令（见 commands/mod.rs 的 net 门控）。
 */
export async function agentAvailable(): Promise<boolean> {
  if (!hasTauri()) return false
  return !(await hostInfo()).isMobile
}

export async function agentProbe(cli?: string): Promise<AgentProbeResult> {
  if (!(await agentAvailable())) {
    return { found: false, profiles: [], hint: 'Agent 后端需要桌面端（浏览器与手机不支持）。' }
  }
  return tauriInvoke<AgentProbeResult>('agent_probe', { cli: cli || null })
}

/**
 * 跑一次 Agent。
 *
 * `onLine` 收到的每一行都是**原始 NDJSON**（`{"type":"tool_call",...}`），
 * 解析规则集中在 `core/agent.ts` —— 和 SSE 那条路一个思路：
 * Rust 侧只负责"把行搬过来"，认不认得由 JS 决定，DSH 加字段时只改一处。
 *
 * `cancelToken` 由**调用方**生成并保管：`agent_run` 要跑很久才返回，
 * 那时候再去取消已经没有意义了。所以令牌必须先给出去，随时能用它调 `agentCancel`。
 */
export async function agentRun(
  args: AgentRunArgs,
  cancelToken: string,
  onLine: SseLineHandler,
  onDiag?: (d: string) => void,
  onStarted?: (pid: number) => void
): Promise<AgentRunResult> {
  if (!(await agentAvailable())) {
    throw new Error('Agent 后端需要桌面端（浏览器与手机不支持）')
  }
  const { Channel } = await import('@tauri-apps/api/core')
  const ch = new Channel<{ t: 'line' | 'started' | 'diag'; d?: string; pid?: number }>()
  ch.onmessage = (m) => {
    if (m?.t === 'line' && typeof m.d === 'string') onLine(m.d)
    else if (m?.t === 'diag' && typeof m.d === 'string') onDiag?.(m.d)
    else if (m?.t === 'started' && typeof m.pid === 'number') onStarted?.(m.pid)
  }
  return tauriInvoke<AgentRunResult>('agent_run', {
    req: { ...args, cancelToken },
    onEvent: ch
  })
}

export async function agentCancel(cancelToken: string): Promise<void> {
  if (!(await agentAvailable())) return
  return tauriInvoke<void>('agent_cancel', { cancelToken })
}

/** 投递技能的结果。 */
export interface SkillSyncResult {
  written: string[]
  skipped: string[]
  removed: string[]
  dir?: string
  error?: string
}

/**
 * 把技能同步进 DSH 技能库（`~/.dsh/skills/mozhan-<slug>/SKILL.md`）。
 *
 * 为什么非得写文件：DSH 只从 `~/.dsh/skills/<slug>/SKILL.md` 登记技能 ——
 * `customSkillDirs` 配置在 `--dump-config` 里看着生效，但运行时不被扫描（实测）。
 * 而且它的技能名必须是 ASCII slug，中文名直接报 `invalid skill name`。
 * 所以前端先把技能渲染成 ASCII 名的 SKILL.md（`core/agentSkills.ts`），
 * 由 Rust 侧落盘，且只写 `mozhan-` 前缀的命名空间。
 */
export async function agentSyncSkills(files: { name: string; content: string }[]): Promise<SkillSyncResult> {
  if (!(await agentAvailable())) {
    return { written: [], skipped: [], removed: [], error: '技能同步需要桌面端。' }
  }
  return tauriInvoke<SkillSyncResult>('agent_sync_skills', { files })
}

/** 本机 DSH 技能库的位置与技能数。 */
export interface DshSkillsDirResult {
  found: boolean
  path?: string
  count: number
}

/**
 * 找本机 DSH 技能库（`~/.dsh/skills`）。
 *
 * 用途：一键把它设成应用的「全局技能库」—— DSH 那边装了几十个小说写作技能
 * （`continuation`、`long-memory`、`style-imitation`…），作者本来得手动去选目录，
 * 给个按钮一步到位。技能本身是纯文本提示词，读进来不联网也不花钱。
 */
export async function agentSkillsDir(): Promise<DshSkillsDirResult> {
  if (!(await agentAvailable())) return { found: false, count: 0 }
  return tauriInvoke<DshSkillsDirResult>('agent_skills_dir', {})
}
