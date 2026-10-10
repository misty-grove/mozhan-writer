/**
 * AI 接入：OpenAI 兼容协议（/v1/chat/completions），SSE 流式
 * 未配置 API 时本模块不应被调用——UI 层由 aiEnabled() 控制不渲染 AI 入口。
 *
 * HTTP 收发在 platform/aiBridge.ts（桌面端走 Rust 桥绕开 CORS，浏览器走 fetch），
 * 本模块只负责协议：拼请求体、解析 SSE 行、重试。两个宿主共用这一份解析。
 */
import type { AiConfig } from './settings'
import { sleep } from './util'
import { aiGet, aiChatStream } from '@/platform/aiBridge'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  cfg: AiConfig
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  onDelta?: (delta: string) => void
  signal?: AbortSignal
  stop?: string[]
}

export function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

function endpoint(cfg: AiConfig): string {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (/\/chat\/completions$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

export class AiError extends Error {}

export function classifyError(e: any): string {
  if (e?.name === 'AbortError') return '请求超时'
  const msg = String(e?.message || e)
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return '网络不可达（浏览器宿主下多为跨域限制，打包为桌面端后不受此影响）'
  }
  return msg
}

/** 非 200 的 HTTP 响应 → 一句可读的失败原因 */
function describeHttp(status: number, body: string): string {
  const brief = body.replace(/\s+/g, ' ').slice(0, 220)
  if (status === 401 || status === 403) return `密钥无效或无权限（${status}）${brief ? '：' + brief : ''}`
  if (status === 404) return `路径不存在（404），检查 Base URL 是否多了/少了 /v1${brief ? '：' + brief : ''}`
  if (status === 429) return `请求过于频繁或额度不足（429）${brief ? '：' + brief : ''}`
  return `HTTP ${status}${brief ? '：' + brief : ''}`
}

export async function testConnection(cfg: AiConfig): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const key = cfg.apiKey.trim()
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (!base || !key) return { ok: false, message: '请填写 Base URL 与 API Key' }
  const candidates = [`/v1/models`, `/models`]
  let last = ''
  for (const c of candidates) {
    try {
      const out = await aiGet(base + c, key)
      if (out.status === 200) {
        const j = safeJson(out.body)
        const models = Array.isArray(j?.data) ? j.data.map((x: any) => String(x.id)) : undefined
        return { ok: true, message: '连接成功', models }
      }
      last = describeHttp(out.status, out.body)
    } catch (e: any) {
      last = classifyError(e)
    }
  }
  return { ok: false, message: `连接失败：${last}` }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function chat(opt: ChatOptions): Promise<string> {
  const { cfg, messages, onDelta } = opt
  // 统一走流式：两个宿主共用同一套 SSE 解析，也顺带让长回复不至于一直黑箱
  const bodyStr = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: opt.temperature ?? cfg.temperature,
    max_tokens: opt.maxTokens ?? cfg.maxTokens,
    stream: true,
    stop: opt.stop
  })
  let attempt = 0
  let lastErr: any = null
  while (attempt < 3) {
    try {
      let full = ''
      const out = await aiChatStream(endpoint(cfg), cfg.apiKey, bodyStr, (line) => {
        if (line === '[DONE]') return
        const j = safeJson(line)
        if (!j) return /* 忽略心跳等非 JSON 行 */
        const d = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? ''
        if (d) {
          full += d
          onDelta?.(d)
        }
      })
      if (out.status !== 200) throw new AiError(describeHttp(out.status, out.body))
      if (!full) throw new AiError('服务端返回了空响应')
      return full
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message || '')
      if (/HTTP 4\d\d/.test(msg) && !/429/.test(msg)) throw e
      attempt++
      await sleep(500 * Math.pow(2, attempt))
    }
  }
  throw lastErr ?? new AiError('请求失败')
}

/** token 粗估（用于展示，不做计费） */
export function roughCost(chars: number): number {
  return chars / 700
}
