/**
 * 应用设置：全部存在本机 localStorage（离线）。
 * API Key 做本地混淆存储；打包成桌面端（Tauri）后应改走系统凭据库 —— see core/security.ts
 */
import { reactive, watch } from 'vue'
import type { RecentWork } from './types'

export interface AiConfig {
  configured: boolean
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  contextWindow: number
  /**
   * AI 引擎。
   *
   * - `api`（默认）：直连 OpenAI 兼容接口，需要 Key；
   * - `agent`：走本机 DSH，Key 由 DSH 自己管，Agent 会自己读作品文件、分多步做事；
   * - `both`：优先 Agent，跑不起来（没装 / 没登录 / 报错）时回落直连 API。
   *
   * 这三档的存在意义是**降级**：不认识 DSH 的作者用 api 档，行为与升级前完全一致。
   */
  engine: 'api' | 'agent' | 'both'
  /** dsh 可执行文件路径；留空则自动探测（PATH → 默认安装位置） */
  agentCli: string
  /** DSH profile，默认 headless */
  agentProfile: string
  /**
   * Agent 权限档位。
   *
   * `read_only` 是默认：本应用的铁律是「AI 产出进候选区，作者点采纳才落盘」，
   * 一个能自己写文件的 Agent 与这条冲突。
   * `write_in_cwd` 才放开写 —— 只值得给「记忆整理」这类重复劳动开。
   */
  agentPermission: 'read_only' | 'write_in_cwd'
  /** 单次 Agent 运行超时（秒）：长篇续写可能跑几分钟 */
  agentTimeoutSecs: number
  /**
   * 每个作品绑定的 DSH 会话 id（`作品目录的稳定标识 → sessionId`）。
   *
   * 存这里而不是作品文件里：`作品信息.md` 是作者要读的东西，
   * 塞一个 `session-5b9c…` 进去只会让人困惑；而会话本来就是「这台机器上的事」，
   * 换台电脑重开一个会话反而是对的。
   */
  agentSessions: Record<string, string>
}

export interface EditorConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
  indent: number
  /** 正文栏宽（px） */
  width: number
  theme: 'light' | 'sepia' | 'dark'
  typewriter: boolean
  focusParagraph: boolean
}

export interface GeneralConfig {
  autoSaveMs: number
  autoSnapshot: boolean
  dailyTarget: number
  recentSnapshots: number
  /** 同一章两次自动快照的最小间隔（分钟） */
  autoSnapshotIntervalMin: number
}

export interface StyleConfig {
  /** 作者自己的禁用词 / 禁用短语 */
  bannedWords: string[]
  /** 是否检查 AI 腔句式 */
  checkAiTone: boolean
  /** 参考基线来源 */
  baseline: 'others' | 'all'
}

export interface UiConfig {
  sidebarOpen: boolean
  dockOpen: boolean
  dockTab: string
  showRecent: boolean
  /** 界面整体缩放（无障碍：视力不佳时放大） */
  scale: number
  /** 高对比度：加深文字与边框，弱化背景层次 */
  highContrast: boolean
}

export interface AppSettings {
  ai: AiConfig
  editor: EditorConfig
  general: GeneralConfig
  style: StyleConfig
  ui: UiConfig
  recent: RecentWork[]
  skillLibrary: { id: string; name: string } | null
  disabledSkills: string[]
  /**
   * 作者在技能面板里手动指定的分类（技能名 → 分类 key）。
   * 优先级最高：覆盖 frontmatter 与关键词启发式（见 core/skillCats.ts）。
   * 按名字存而不是按文件存，这样全局库/内置技能也能挪分类。
   */
  skillCats: Record<string, string>
  /**
   * 被作者「删除」的全局/内置技能名单。
   *
   * 为什么不真删：全局技能库指向的是 DSH 自己的 `~/.dsh/skills`，
   * 那里面的技能 DSH 本体可能还要用 —— 应用没权利替作者删他自己的东西。
   * 作品内技能（`技能/` 目录）是真删文件，不走这份名单。
   */
  hiddenSkills: string[]
  /**
   * 技能名/说明的中文译名（技能名 → 译文）。
   *
   * 为什么只存在本机而不写进 SKILL.md：全局技能库指向的是 DSH 自己的
   * `~/.dsh/skills`，那里的文件不属于本应用；内置技能是打进包里的。
   * 译名只是**显示层**，一个字节都不该动别人的文件（见 core/skillI18n.ts）。
   */
  skillZh: Record<string, { zh?: string; desc?: string }>
}

const K = 'writer.settings.v1'

const defaults: AppSettings = {
  ai: {
    configured: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 4096,
    contextWindow: 32000,
    engine: 'api',
    agentCli: '',
    agentProfile: 'headless',
    agentPermission: 'read_only',
    agentTimeoutSecs: 600,
    agentSessions: {}
  },
  editor: {
    fontFamily: '"Source Han Serif SC","Noto Serif CJK SC",SimSun,"Songti SC",Georgia,serif',
    fontSize: 19,
    lineHeight: 1.8,
    indent: 2,
    width: 760,
    theme: 'light',
    typewriter: false,
    focusParagraph: false
  },
  general: {
    autoSaveMs: 1500,
    autoSnapshot: true,
    dailyTarget: 4000,
    recentSnapshots: 20,
    autoSnapshotIntervalMin: 10
  },
  style: {
    bannedWords: [],
    checkAiTone: true,
    baseline: 'others'
  },
  ui: { sidebarOpen: false, dockOpen: false, dockTab: 'context', showRecent: true, scale: 1, highContrast: false },
  recent: [],
  skillLibrary: null,
  disabledSkills: [],
  skillCats: {},
  hiddenSkills: [],
  skillZh: {}
}

/* ------------------------------ Key 混淆（非加密，仅防止明文肉眼可见） ------------------------------ */

const KK = 'writer.k'

/**
 * 本机存储的安全包装。
 *
 * localStorage 并不是「有浏览器就一定在」：隐私模式 / 禁用 Cookie / 配额写满时，
 * 连 getItem 都可能抛异常。设置项属于「丢了也不该让应用起不来」的那一类，
 * 所以统一降级成内存态而不是把异常抛给调用方 —— 尤其是这条链上有 setTimeout 里的写入，
 * 抛出去只会变成每 300ms 一条没人看见的控制台报错。
 */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, val: string) {
  try {
    localStorage.setItem(key, val)
  } catch {
    /* 隐私模式 / 配额满：内存里保留即可 */
  }
}
function lsRemove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* noop */
  }
}

/** localStorage 不可用时退回进程内随机键，至少保证同一会话内加解密自洽 */
let memKey = ''

function installKey(): string {
  let k = lsGet(KK)
  if (!k) {
    k = memKey || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    memKey = k
    lsSet(KK, k)
  }
  return k
}

export function obfuscate(text: string): string {
  if (!text) return ''
  const k = installKey()
  let out = ''
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(text.charCodeAt(i) ^ k.charCodeAt(i % k.length))
  return btoa(unescape(encodeURIComponent(out)))
}

export function deobfuscate(code: string): string {
  if (!code) return ''
  try {
    const s = decodeURIComponent(escape(atob(code)))
    const k = installKey()
    let out = ''
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ k.charCodeAt(i % k.length))
    return out
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ store */

export const settings = reactive<AppSettings>(load())

function load(): AppSettings {
  try {
    const raw = lsGet(K)
    if (!raw) return JSON.parse(JSON.stringify(defaults))
    const parsed = JSON.parse(raw)
    return deepMerge(JSON.parse(JSON.stringify(defaults)), parsed)
  } catch {
    return JSON.parse(JSON.stringify(defaults))
  }
}

function deepMerge(base: any, patch: any): any {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      base[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      base[k] = v
    }
  }
  return base
}

let timer: any = null
watch(
  settings,
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const copy = JSON.parse(JSON.stringify(settings))
      copy.ai.apiKey = obfuscate(copy.ai.apiKey)
      lsSet(K, JSON.stringify(copy))
    }, 300)
  },
  { deep: true }
)

try {
  const saved = JSON.parse(lsGet(K) || 'null')
  if (saved?.ai?.apiKey) settings.ai.apiKey = deobfuscate(saved.ai.apiKey)
} catch {
  /* noop */
}

export function resetSettings() {
  Object.assign(settings, JSON.parse(JSON.stringify(defaults)))
  lsRemove(K)
}

export function touchRecent(w: RecentWork) {
  const list = settings.recent.filter((x) => x.refId !== w.refId)
  list.unshift(w)
  settings.recent = list.slice(0, 12)
}

export function removeRecent(refId: string) {
  settings.recent = settings.recent.filter((x) => x.refId !== refId)
}

/* ------------------------------------------------------------------ 主题 */

export const THEMES: Array<{ k: EditorConfig['theme']; label: string; hint: string }> = [
  { k: 'light', label: '白底', hint: '白天、有外光时' },
  { k: 'sepia', label: '护眼', hint: '米色纸感，暖光环境' },
  { k: 'dark', label: '夜间', hint: '深夜写稿，最低亮度' }
]

const THEME_CLASS = (t: EditorConfig['theme']) => (t === 'light' ? '' : `theme-${t}`)

/**
 * 主题类挂在 `<html>` 上，而不是应用根节点上。
 * 原因：body 背景、滚动条、原生下拉/日期控件、以及任何挂到 body 的浮层都不在根节点里，
 * 只给 .app-root 加类的话，夜间模式下这些地方会突然闪白。
 */
export function applyTheme() {
  const root = document.documentElement
  for (const t of THEMES) {
    const cls = THEME_CLASS(t.k)
    if (cls) root.classList.toggle(cls, settings.editor.theme === t.k)
  }
  // 让浏览器把滚动条、表单控件、以及 prefers-color-scheme 相关样式一起切过去
  root.style.colorScheme = settings.editor.theme === 'dark' ? 'dark' : 'light'
  root.dataset.theme = settings.editor.theme
}

export function cycleTheme(): EditorConfig['theme'] {
  const i = THEMES.findIndex((t) => t.k === settings.editor.theme)
  const next = THEMES[(i + 1) % THEMES.length]
  settings.editor.theme = next.k
  applyTheme()
  return next.k
}

/* ------------------------------------------------------------------ 无障碍 */

export const SCALE_MIN = 0.8
export const SCALE_MAX = 1.6

/** 整体缩放：直接改根元素 zoom，一处生效，组件里不用到处写 calc */
export function setScale(v: number) {
  const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100))
  settings.ui.scale = next
  return next
}

export function zoomBy(step: number) {
  return setScale((settings.ui.scale || 1) + step)
}

export function applyA11y() {
  const root = document.documentElement
  root.style.zoom = String(settings.ui.scale || 1)
  root.classList.toggle('a11y-contrast', !!settings.ui.highContrast)
}

/** 一次性把「外观」相关的设置落到 DOM 上（缩放 / 高对比 / 主题） */
export function applyAppearance() {
  applyA11y()
  applyTheme()
}

/** AI 是否可用：只有配置了 baseUrl + key + model 才解锁整个 AI 层 */
export function aiEnabled(): boolean {
  const a = settings.ai
  // Agent 档不需要 Key（DSH 自己管），但仍要求"作者确实开了 AI 层"——
  // 否则一装 DSH 就凭空冒出 AI 入口，纯离线写作的作者会觉得被冒犯。
  if (a.engine === 'agent' && a.configured) return true
  return a.configured && !!a.baseUrl.trim() && !!a.apiKey.trim() && !!a.model.trim()
}

/** 当前是否该走 Agent（真跑之前还要再问一次 agentAvailable） */
export function agentPreferred(): boolean {
  const e = settings.ai.engine
  return (e === 'agent' || e === 'both') && settings.ai.configured
}

/** 直连 API 这条路还通不通（Key / URL / 模型齐不齐） */
export function apiReady(): boolean {
  const a = settings.ai
  return !!a.baseUrl.trim() && !!a.apiKey.trim() && !!a.model.trim()
}
