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
