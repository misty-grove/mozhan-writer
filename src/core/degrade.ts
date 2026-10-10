/**
 * 离线降级宿主（P3-F）
 *
 * 问题：Firefox / Safari 没有 File System Access API，拿不到本机目录句柄。
 * 之前的做法是首页一句「请用 Edge / Chrome」把人挡在外面 —— 这是把浏览器的账
 * 算在作者头上。这一阶段改成**降级可用**：
 *
 *   导入作品文件夹 → 在内存里正常写作（所有面板、双链、统计照旧）
 *   → 导出成 zip 覆盖回原文件夹
 *
 * 代价必须说清楚，不能装作和 FSA 一样：
 *   1. 磁盘不是实时同步的，只有「导出」那一刻才落盘；
 *   2. zip 只能表达「新增 / 修改」，表达不了「删除」——删掉的文件要作者自己删；
 *   3. 只搬文本文件（.md 等），插图之类的二进制素材留在原地不动。
 * 所以有「未导出 N 个」计数 + 关页面前的提醒 + 数据存 IndexedDB 防手滑刷新。
 *
 * 本文件只放**纯函数**（路径归一化、指纹、差异、文案），
 * 宿主实现见 platform/memAdapter.ts，状态在 stores/sandbox.ts。
 */
import { countWords } from './util'

/** 内存宿主的 DirRef.id 前缀 —— 用来把「沙盒作品」和「真目录作品」的最近记录分开 */
export const SANDBOX_REF_PREFIX = 'mem:'

export interface FlatFile {
  path: string
  text: string
}

export interface ImportedFile {
  path: string[]
  text: string
}

/* ------------------------------------------------------------------ 路径 */

/** 拿得到的文本类型。其余（图片 / 字体 / 二进制）不收：内存宿主只存字符串，硬塞只会把作品搞坏。 */
const TEXT_EXT = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.csv', '.tsv', '.html', '.htm', '.css', '.js', '.mjs']

export function textExtOk(name: string): boolean {
  const n = String(name || '').toLowerCase()
  const i = n.lastIndexOf('.')
  if (i <= 0) return false
  return TEXT_EXT.includes(n.slice(i))
}

/**
 * 相对路径归一化。返回 null = 这条路径不能用（空段 / 越界 / 盘符 / 控制字符）。
 * 和 backup.ts 的 isSafeEntryName 同一套标准：不信任任何外部来的路径。
 */
export function normalizeRelPath(raw: string): string[] | null {
  const n = String(raw || '').replace(/\\/g, '/')
  if (!n || n.startsWith('/') || n.startsWith('~')) return null
  if (/^[a-zA-Z]:/.test(n)) return null
  if (n.includes('\0')) return null
  const segs = n.split('/').filter((s) => s !== '')
  if (!segs.length) return null
  if (segs.some((s) => s === '..' || s === '.')) return null
  return segs
}

/**
 * 去掉共同的**首层**目录。
 * `<input webkitdirectory>` 给出的 webkitRelativePath 会把作者选中的那层文件夹名带上
 * （`我的书/正文/第001章.md`），而作品根就是那一层，所以要剥掉。
 */
export function stripTop(paths: string[][]): { paths: string[][]; top: string } {
  const tops = new Set(paths.map((p) => p[0]).filter(Boolean))
  const top = tops.size === 1 ? [...tops][0] : ''
  return { paths: paths.map((p) => (top && p[0] === top ? p.slice(1) : p)), top }
}

/* ------------------------------------------------------------------ 导入 */

export interface ImportPlan {
  files: ImportedFile[]
  /** 没收进来的文件名（非文本 / 路径不合法 / 读不出来），一律报出来，不静默丢 */
  skipped: string[]
  /** 从路径里剥出来的作品文件夹名，可作为沙盒名 */
  top: string
  bytes: number
}

/** 纯函数：已读好文本的条目 → 可导入文件表 */
export function planImport(entries: Array<{ relPath: string; text: string }>): ImportPlan {
  const kept: Array<{ path: string[]; text: string }> = []
  const skipped: string[] = []
  let bytes = 0

  for (const e of entries) {
    const segs = normalizeRelPath(e.relPath)
    if (!segs) {
      skipped.push(e.relPath)
      continue
    }
    const name = segs[segs.length - 1]
    if (!textExtOk(name)) {
      skipped.push(e.relPath)
      continue
    }
    kept.push({ path: segs, text: e.text })
    bytes += e.text.length
  }

  const { paths, top } = stripTop(kept.map((k) => k.path))
  const files = kept.map((k, i) => ({ path: paths[i], text: k.text })).filter((f) => f.path.length > 0)
  return { files, skipped, top, bytes }
}

/** 浏览器 FileList → 条目表（读文本这一步是异步的，所以单独一步） */
export async function readImportEntries(
  list: ArrayLike<{ name?: string; webkitRelativePath?: string; text(): Promise<string> }>
): Promise<{ entries: Array<{ relPath: string; text: string }>; unreadable: string[] }> {
  const entries: Array<{ relPath: string; text: string }> = []
  const unreadable: string[] = []
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    const relPath = (f as any).webkitRelativePath || f.name || ''
    if (!relPath) continue
    if (!textExtOk(relPath)) {
      unreadable.push(relPath)
      continue
    }
    try {
      entries.push({ relPath, text: await f.text() })
    } catch {
      unreadable.push(relPath)
    }
  }
  return { entries, unreadable }
}

export interface ImportSummary {
  files: number
  words: number
  skipped: number
}

/** 只统计正文目录的字数 —— 大纲/记忆的字数没有意义，混进来只会让人误解工作量 */
export function summarizeImport(files: ImportedFile[]): ImportSummary {
  let words = 0
  for (const f of files) {
    const p = f.path.join('/')
    if (!/^正文\/.*\.md$/.test(p)) continue
    words += countWords(f.text)
  }
  return { files: files.length, words, skipped: 0 }
}

/** 「已导入 128 个文件 · 约 42.6 万字；3 个非文本文件未导入」 */
export function importSummaryText(plan: ImportPlan): string {
  const s = summarizeImport(plan.files)
  const w = s.words >= 10000 ? `${(s.words / 10000).toFixed(1)} 万字` : `${s.words} 字`
  let out = `已导入 ${s.files} 个文件 · 约 ${w}`
  if (plan.skipped.length) out += ` · ${plan.skipped.length} 个文件未导入（非文本或路径不合法）`
  return out
}

/* ------------------------------------------------------------------ 指纹与差异 */

/** FNV-1a 32 位，8 位十六进制。只用来判断「文件变没变」，不承担任何安全职责。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 长度 + 哈希：哈希偶尔撞了还有长度兜着；长度相同再撞的概率可以忽略 */
export function fingerprint(text: string): string {
  return `${text.length}:${fnv1a(text)}`
}

export function fingerprints(files: FlatFile[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) out[f.path] = fingerprint(f.text)
  return out
}

export interface SandboxDiff {
  /** 沙盒里有、基线里没有 */
  added: string[]
  /** 两边都有但内容不一样 */
  changed: string[]
  /** 基线里有、沙盒里没了 */
  removed: string[]
  /** added + changed：这两类 zip 能表达 */
  dirty: string[]
  /** added + changed + removed */
  count: number
  /** 沙盒里的可见文件总数 */
  total: number
}

export function diffAgainstBaseline(baseline: Record<string, string>, current: FlatFile[]): SandboxDiff {
  const added: string[] = []
  const changed: string[] = []
  const seen = new Set<string>()
  for (const f of current) {
    seen.add(f.path)
    const b = baseline[f.path]
    if (b === undefined) added.push(f.path)
    else if (b !== fingerprint(f.text)) changed.push(f.path)
  }
  const removed = Object.keys(baseline).filter((p) => !seen.has(p))
  const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y, 'zh'))
  return {
    added: sort(added),
    changed: sort(changed),
    removed: sort(removed),
    dirty: sort([...added, ...changed]),
    count: added.length + changed.length + removed.length,
    total: current.length
  }
}

export const EMPTY_DIFF: SandboxDiff = { added: [], changed: [], removed: [], dirty: [], count: 0, total: 0 }

/** 「未导出 3 个文件（新增 1 · 修改 2 · 删除 0）」 */
export function diffSummary(d: SandboxDiff): string {
  if (!d.count) return `已与磁盘对齐（${d.total} 个文件）`
  return `未导出 ${d.count} 个文件（新增 ${d.added.length} · 修改 ${d.changed.length} · 删除 ${d.removed.length}）`
}

/** 顶栏那一小条的文案，短到不挤坏布局 */
export function chipText(d: SandboxDiff): string {
  return d.count ? `沙盒 · 未导出 ${d.count}` : '沙盒 · 已同步'
}

/* ------------------------------------------------------------------ 导出 */

/** 沙盒导出包里的说明文件：解开 zip 的人得知道这是什么、该怎么用 */
export const SANDBOX_README = '沙盒导出说明.md'

export interface SandboxManifest {
  app: 'writer-app-sandbox'
  version: number
  exportedAt: string
  worksName: string
  scope: 'all' | 'changed'
  fileCount: number
  /** 只导出改动时，这些是本次带上的文件；全量导出时为空 */
  changed: string[]
  /** 表达不了的那部分：沙盒里删掉、zip 写不出来的删除 */
  removed: string[]
}

export function sandboxManifest(
  args: { name: string; scope: 'all' | 'changed'; files: FlatFile[]; changed?: string[]; removed?: string[]; at?: Date }
): SandboxManifest {
  return {
    app: 'writer-app-sandbox',
    version: 1,
    exportedAt: (args.at || new Date()).toISOString(),
    worksName: args.name,
    scope: args.scope,
    fileCount: args.files.length,
    changed: args.changed || [],
    removed: args.removed || []
  }
}

const stamp = (at: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
}

/** 导出文件名：作品名-沙盒导出-20261008-0918.zip */
export function sandboxFileName(title: string, at = new Date(), scope: 'all' | 'changed' = 'all'): string {
  const safe = (title || '作品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const tag = scope === 'changed' ? '改动' : '全量'
  return `${safe}-沙盒导出-${tag}-${stamp(at)}.zip`
}

/* ------------------------------------------------------------------ 模式判定 */

export function isSandboxRefId(refId: string): boolean {
  return String(refId || '').startsWith(SANDBOX_REF_PREFIX)
}

/**
 * 首页「最近的作品」列表：两种宿主的记录互不通用，混在一起点必然报错。
 * 降级模式只看得到沙盒作品；正常模式看不到沙盒作品（它需要显式恢复）。
 */
export function visibleRecents<T extends { refId: string }>(recents: T[], degraded: boolean): T[] {
  return (recents || []).filter((r) => isSandboxRefId(r.refId) === degraded)
}

/** 首页在降级模式下的说明文案（一份数据，UI 与测试读同一份） */
export const DEGRADE_NOTICE = {
  title: '这个浏览器不能直接读写本机文件夹',
  why: 'File System Access API 只有 Chrome / Edge 系支持。Firefox / Safari 上改用「沙盒模式」照常写作：',
  steps: [
    '把作品文件夹整个导入进来（子目录、正文、大纲、记忆都会读进来）',
    '像平时一样写：自动保存、双链、统计、快照都在',
    '写完点顶栏的「导出」把改动打包成 zip，解压覆盖回原文件夹'
  ],
  limits: [
    '磁盘不是实时同步的：不加导出，改动只在本机浏览器里',
    '导出包表达不了「删除」：沙盒里删掉的文件，要你自己去磁盘上删',
    '只搬 .md / .txt 这类文本，插图等素材留在原地不动'
  ]
} as const

/** 「需要 Chrome / Edge」这类提示，单独一份，免得各页面各写一句 */
export function fsaRequiredHint(): string {
  return '该作品是用 Chrome / Edge 打开的（直接读写本机文件夹），当前浏览器打不开。'
}
