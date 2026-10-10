/**
 * 作品工作区：把「作者已有的目录规范」当作原生格式来读写
 *
 * 作品名/
 * ├─ 作品信息.md
 * ├─ 大纲/ .mdAI文件 / 人物大纲 / 分卷大纲 / 剧情大纲
 * ├─ 设定/ .mdAI文件 / 世界设定 / 人物设定
 * ├─ 正文/ [第X卷 卷名/卷纲.md + 章节.md] | 第001章 标题.md
 * ├─ 记忆/ 逐章摘要.md ...
 * └─ 技能/ 技能名/SKILL.md
 *
 * 原则：Markdown 才是数据源；这里只是这套目录的 GUI。
 */
import fs from '@/platform'
import type { DirRef, PathSeg } from '@/platform'
import { parseDoc, serializeDoc, updateMeta } from './frontmatter'
import { cnNumber, countWords, fmtTime, todayKey } from './util'
import type { AssetDoc, Chapter, ChapterMeta, ChapterStatus, Volume, WorkInfo } from './types'
import { STATUS_LIST } from './types'

export const DIRS = {
  outline: '大纲',
  setting: '设定',
  body: '正文',
  memory: '记忆',
  skill: '技能',
  snapshot: '.snapshots',
  info: '作品信息.md'
}

export const VOLUME_OUTLINE_FILE = '卷纲.md'

const SCAFFOLD: PathSeg[] = [
  [DIRS.outline, '.mdAI文件'],
  [DIRS.outline, '人物大纲'],
  [DIRS.outline, '分卷大纲'],
  [DIRS.outline, '剧情大纲'],
  [DIRS.setting, '.mdAI文件'],
  [DIRS.setting, '世界设定'],
  [DIRS.setting, '人物设定'],
  [DIRS.body],
  [DIRS.memory],
  [DIRS.skill]
]

const INFO_ORDER = ['title', 'author', 'brief', 'targetWords', 'created', 'updated']

export const DEFAULT_BOOK_OUTLINE = `# 剧情大纲（全书）

> 在这里写全书主线。AI 续写时会把它作为最高层 context，建议保持简洁、可分段。

## 一句话梗概

## 主线推进

## 关键转折

## 结局走向
`

export const DEFAULT_MEMORY_FILES: Record<string, string> = {
  '逐章摘要.md': '# 逐章摘要\n\n> 由「记忆整理」写入；AI 续写时作为长期记忆注入。\n',
  '状态表.md': '# 状态表\n\n> 人物状态变化记录（受伤 / 获得 / 失去 / 关系变动）。\n',
  '伏笔台账.md': '# 伏笔台账\n\n> | 伏笔 | 埋设章节 | 状态 | 计划回收 | 优先级 |\n> |---|---|---|---|---|\n',
  '时间线.md': '# 时间线\n\n> 故事内时间 → 事件 → 对应章节。\n'
}

/* ------------------------------------------------------------------ 基本信息 */

export function defaultWorkInfo(name: string): WorkInfo {
  return {
    title: name,
    author: '',
    brief: '',
    targetWords: 0,
    created: fmtTime(new Date())
  }
}

export async function readWorkInfo(ref: DirRef): Promise<WorkInfo> {
  try {
    const txt = await fs().readFile(ref, [DIRS.info])
    const { meta } = parseDoc(txt)
    return {
      title: String(meta.title || ref.name),
      author: String(meta.author || ''),
      brief: String(meta.brief || ''),
      targetWords: Number(meta.targetWords || 0),
      created: String(meta.created || '')
    }
  } catch {
    return defaultWorkInfo(ref.name)
  }
}

export async function writeWorkInfo(ref: DirRef, info: WorkInfo) {
  const body = `# ${info.title || '未命名作品'}\n\n${info.brief ? info.brief + '\n\n' : ''}> 本文件是作品的基本信息，可直接编辑。\n`
  const text = serializeDoc({ ...info, title: info.title || ref.name }, body, INFO_ORDER)
  await fs().writeFile(ref, [DIRS.info], text)
}

/* ------------------------------------------------------------------ 创建 / 初始化 */

export async function createWork(parent: DirRef, name: string, info: Partial<WorkInfo> = {}): Promise<DirRef> {
  const clean = sanitizeName(name)
  for (const d of SCAFFOLD) await fs().mkdir(parent, [clean, ...d])
  await fs().writeFile(parent, [clean, DIRS.outline, '.mdAI文件', '剧情大纲.md'], DEFAULT_BOOK_OUTLINE)
  await fs().writeFile(parent, [clean, DIRS.outline, '.mdAI文件', '分卷大纲.md'], '# 分卷大纲\n')
  await fs().writeFile(parent, [clean, DIRS.outline, '.mdAI文件', '人物大纲.md'], '# 人物大纲\n')
  for (const [file, content] of Object.entries(DEFAULT_MEMORY_FILES)) {
    await fs().writeFile(parent, [clean, DIRS.memory, file], content)
  }
  const finalInfo = { ...defaultWorkInfo(clean), ...info, title: info.title || clean }
  await fs().writeFile(parent, [clean, DIRS.info], serializeDoc(finalInfo, `# ${finalInfo.title}\n`, INFO_ORDER))
  return fs().joinRef(parent, clean)
}

/**
 * 在已选目录上补齐标准结构（用于「打开已有作品」时发现缺目录的情况）
 */
export async function ensureStructure(ref: DirRef) {
  for (const d of SCAFFOLD) {
    // mkdir 幂等（create:true）
    await fs().mkdir(ref, d)
  }
  const missing: string[] = []
  for (const [file, content] of Object.entries(DEFAULT_MEMORY_FILES)) {
    if (!(await fs().exists(ref, [DIRS.memory, file]))) {
      await fs().writeFile(ref, [DIRS.memory, file], content)
      missing.push(file)
    }
  }
  if (!(await fs().exists(ref, [DIRS.info]))) await writeWorkInfo(ref, defaultWorkInfo(ref.name))
  return missing
}

export async function looksLikeWork(ref: DirRef): Promise<boolean> {
  try {
    const entries = await fs().listDir(ref, [])
    return entries.some((e) => e.kind === 'dir' && [DIRS.outline, DIRS.setting, DIRS.body].includes(e.name))
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ 扫描 */

/**
 * 从文件名里认章号 / 卷号（`第007章 启程.md` → 7，`第三卷 归途` → 3）；认不出算最大。
 *
 * 中文序号必须认：只认阿拉伯数字时，「第一卷」和「第二卷」的序号都取不到，
 * 排序就退化成按拼音 —— 于是「第二卷（èr）」排在「第一卷（yī）」前面，
 * 作者看到的目录是乱的。
 */
export function parseOrder(file: string): number {
  const m = /第\s*(\d+)\s*[章卷]/.exec(file)
  if (m) return Number(m[1])
  const cn = /第\s*([零一二三四五六七八九十百千万两]{1,8})\s*[章卷]/.exec(file)
  if (cn) {
    const n = cnNumber(cn[1])
    if (n !== null) return n
  }
  return Number.MAX_SAFE_INTEGER
}

/** 文件名里带了序号（阿拉伯或中文） */
const ORDER_RE = /第\s*[0-9零一二三四五六七八九十百千万两]{1,8}\s*章/

/**
 * 把用户输入变成一个能当目录名/文件名用的字符串。
 *
 * 除了替换非法字符，还要处理两件真实会出事的情况：
 * - `..`（以及单独的 `.`）不是目录名，而是"上一层"：留着它会拼出一条走到作品目录之外的路径。
 *   浏览器宿主下会直接抛 InvalidModificationError，桌面端则会**悄悄写到外面去**。
 * - 结尾的点或空格：Windows 会在创建时静默吃掉，于是刚建好的卷立刻"找不到"了。
 */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符会把目录列表、日志、导出的压缩包一起搞坏
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return '未命名'
  return cleaned
}

export interface ScanResult {
  volumes: Volume[]
  rootChapters: Chapter[]
  totalWords: number
  chapterCount: number
}

export async function scanWork(ref: DirRef, onProgress?: (done: number, total: number) => void): Promise<ScanResult> {
  const bodyEntries = await safeList(ref, [DIRS.body])
  const volumes: Volume[] = []
  const rootChapters: Chapter[] = []

  const volumeDirs = bodyEntries.filter((e) => e.kind === 'dir')
  const rootFiles = bodyEntries.filter((e) => e.kind === 'file' && e.name.endsWith('.md'))

  const files = rootFiles.map((e) => e.name).sort((a, b) => parseOrder(a) - parseOrder(b) || a.localeCompare(b, 'zh'))
  const estimatedTotal = files.length + volumeDirs.length * 6
  let done = 0

  for (const name of files) {
    if (name === VOLUME_OUTLINE_FILE) continue
    rootChapters.push(await loadChapter(ref, [DIRS.body, name], null))
    onProgress?.(++done, estimatedTotal)
  }

  for (const [i, dir] of volumeDirs.entries()) {
    const vPath: PathSeg = [DIRS.body, dir.name]
    const entries = await safeList(ref, vPath)
    const meta = await loadVolumeMeta(ref, vPath)
    const chs: Chapter[] = []
    for (const f of entries.filter((e) => e.kind === 'file' && e.name.endsWith('.md') && e.name !== VOLUME_OUTLINE_FILE)) {
      chs.push(await loadChapter(ref, [...vPath, f.name], `${vPath.join('/')}`))
      onProgress?.(++done, estimatedTotal)
    }
    chs.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file, 'zh'))
    volumes.push({
      id: vPath.join('/'),
      name: dir.name,
      dir: dir.name,
      order: parseOrder(dir.name) || i + 1,
      chapters: chs,
      wordCount: chs.reduce((s, c) => s + c.wordCount, 0),
      meta
    })
  }
  volumes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'))
  const totalWords = volumes.reduce((s, v) => s + v.wordCount, 0) + rootChapters.reduce((s, c) => s + c.wordCount, 0)
  return { volumes, rootChapters, totalWords, chapterCount: rootChapters.length + volumes.reduce((s, v) => s + v.chapters.length, 0) }
}

async function safeList(ref: DirRef, path: PathSeg) {
  try {
    return await fs().listDir(ref, path)
  } catch {
    return []
  }
}

async function loadVolumeMeta(ref: DirRef, vPath: PathSeg) {
  try {
    const txt = await fs().readFile(ref, [...vPath, VOLUME_OUTLINE_FILE])
    const { meta } = parseDoc(txt)
    return {
      target: String(meta.target || ''),
      conflict: String(meta.conflict || ''),
      line: String(meta.line || ''),
      hook: String(meta.hook || ''),
      notes: String(meta.notes || '')
    }
  } catch {
    return {}
  }
}

async function loadChapter(ref: DirRef, path: PathSeg, volumeId: string | null): Promise<Chapter> {
  let raw = ''
  try {
    raw = await fs().readFile(ref, path)
  } catch {
    raw = ''
  }
  const { meta, body } = parseDoc(raw)
  const file = path[path.length - 1]
  const status = STATUS_LIST.includes(meta.status) ? (meta.status as ChapterStatus) : body.trim() ? '草稿' : '待写'
  const title = String(meta.title || file.replace(/^第\s*\d+\s*章\s*/, '').replace(/\.md$/, ''))
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v ? String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [])
  return {
    id: path.join('/'),
    volumeId,
    file,
    title,
    status,
    tags: arr(meta.tags),
    order: parseOrder(file),
    wordCount: countWords(body),
    updated: String(meta.updated || ''),
    meta: {
      target: String(meta.target || ''),
      characters: arr(meta.characters),
      settings: arr(meta.settings),
      emotion: String(meta.emotion || ''),
      notes: String(meta.notes || '')
    }
  }
}

export async function readChapterText(ref: DirRef, chapterId: string): Promise<string> {
  return await fs().readFile(ref, chapterId.split('/'))
}

export async function readChapterBody(ref: DirRef, chapterId: string): Promise<string> {
  const raw = await readChapterText(ref, chapterId)
  return parseDoc(raw).body
}

const CH_ORDER = ['title', 'status', 'tags', 'target', 'characters', 'settings', 'emotion', 'updated', 'notes']

export async function saveChapter(
  ref: DirRef,
  chapterId: string,
  body: string,
  patch: Partial<Pick<Chapter, 'title' | 'status' | 'tags'>> & Partial<ChapterMeta> = {}
) {
  let base = ''
  try {
    base = await readChapterText(ref, chapterId)
  } catch {
    base = ''
  }
  const prevMeta = base ? parseDoc(base).meta : {}
  const nextMeta: Record<string, any> = { ...prevMeta, updated: fmtTime(new Date()) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    nextMeta[k] = Array.isArray(v) ? (v.length ? v : undefined) : v === '' ? undefined : v
  }
  if (!nextMeta.title) nextMeta.title = String(prevMeta.title || '未命名章节')
  const text = serializeDoc(nextMeta, body, CH_ORDER)
  await fs().writeFile(ref, chapterId.split('/'), text)
}

/** 章节文件名：`第NNN章 标题.md` */
export function chapterFileName(order: number, title: string) {
  const n = String(order).padStart(3, '0')
  const t = sanitizeName(title || '')
  return `第${n}章${t ? ' ' + t : ''}.md`
}

export async function createChapter(
  ref: DirRef,
  volumeId: string | null,
  title: string,
  opts: { order?: number } = {}
): Promise<Chapter> {
  const parent: PathSeg = volumeId ? volumeId.split('/') : [DIRS.body]
  const existing = await safeList(ref, parent)
  const maxOrder = existing
    .filter((e) => e.kind === 'file' && ORDER_RE.test(e.name))
    .reduce((m, e) => Math.max(m, parseOrder(e.name)), 0)
  const order = opts.order ?? maxOrder + 1
  const file = chapterFileName(order, title)
  const path = [...parent, file]
  const meta = {
    title: title || `第${order}章`,
    status: '待写' as ChapterStatus,
    updated: fmtTime(new Date())
  }
  await fs().writeFile(ref, path, serializeDoc(meta, '', CH_ORDER))
  return await loadChapter(ref, path, volumeId)
}

export async function createVolume(ref: DirRef, name: string, order?: number): Promise<Volume> {
  const existingVolumes = (await safeList(ref, [DIRS.body])).filter((e) => e.kind === 'dir')
  const n = order ?? existingVolumes.length + 1
  // 「第一卷 启程」这类中文序号也算已经编号（不然会生成「第01卷 第一卷 启程」）
  const hasOrder = /^第\s*[0-9零一二三四五六七八九十百千万两]{1,8}\s*卷/.test(name)
  const cleanName = hasOrder ? name : `第${String(n).padStart(2, '0')}卷 ${name}`
  const dirName = sanitizeName(cleanName)
  const vPath: PathSeg = [DIRS.body, dirName]
  await fs().mkdir(ref, vPath)
  await fs().writeFile(
    ref,
    [...vPath, VOLUME_OUTLINE_FILE],
    serializeDoc({ title: name, target: '', conflict: '', line: '', hook: '' }, `# ${name}\n\n## 本卷目标\n\n## 核心冲突\n\n## 推进线\n\n## 卷末钩子\n`)
  )
  return { id: vPath.join('/'), name: dirName, dir: dirName, order: n, chapters: [], wordCount: 0, meta: {} }
}

export async function renameVolume(ref: DirRef, volumeId: string, newName: string): Promise<string> {
  const oldPath = volumeId.split('/')
  const parent = oldPath.slice(0, -1)
  // 复制整树到新目录再删除旧的（FSA 无 rename dir）
  const cleanName = sanitizeName(newName)
  if (cleanName === oldPath[oldPath.length - 1]) return volumeId
  await fs().copyDir(ref, oldPath, ref, parent, cleanName)
  await fs().remove(ref, oldPath)
  return [...parent, cleanName].join('/')
}

export async function deleteChapter(ref: DirRef, chapterId: string) {
  await fs().remove(ref, chapterId.split('/'))
}

export async function duplicateChapter(ref: DirRef, chapterId: string): Promise<Chapter> {
  const parts = chapterId.split('/')
  const parent = parts.slice(0, -1)
  const raw = await readChapterText(ref, chapterId)
  const { meta } = parseDoc(raw)
  const order = parseOrder(parts[parts.length - 1]) + 1
  const newFile = chapterFileName(order, `${meta.title || ''} 副本`)
  const target = [...parent, newFile]
  await fs().writeFile(ref, target, updateMeta(raw, { title: `${meta.title || ''} 副本`, status: '待修' }))
  return await loadChapter(ref, target, parent.length > 1 ? parent.join('/') : null)
}

/**
 * 重排序：把 chapters 按给定顺序重写文件名（数字前缀 +1 递增）
 * 保持文件内容不变，只改文件名与 updated 时间戳。
 */
export async function reorderChapters(ref: DirRef, volumeId: string | null, orderedIds: string[]) {
  const parent: PathSeg = volumeId ? volumeId.split('/') : [DIRS.body]
  // 先按原名读入
  const buffers = await Promise.all(orderedIds.map((id) => readChapterText(ref, id)))
  const filenames = orderedIds.map((id) => id.split('/').pop() as string)
  // 临时改名避免覆盖冲突
  const tmpNames = filenames.map((_, i) => `.tmp_reorder_${i}.md`)
  for (let i = 0; i < orderedIds.length; i++) {
    await fs().writeFile(ref, [...parent, tmpNames[i]], buffers[i])
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await fs().remove(ref, [...parent, filenames[i]])
  }
  const results: Chapter[] = []
  for (let i = 0; i < orderedIds.length; i++) {
    const { meta } = parseDoc(buffers[i])
    const newFile = chapterFileName(i + 1, String(meta.title || ''))
    await fs().writeFile(ref, [...parent, newFile], buffers[i])
    await fs().remove(ref, [...parent, tmpNames[i]])
    results.push(await loadChapter(ref, [...parent, newFile], volumeId))
  }
  return results
}

export async function saveVolumeOutline(ref: DirRef, volumeId: string, meta: any, body: string) {
  const path = [...volumeId.split('/'), VOLUME_OUTLINE_FILE]
  await fs().writeFile(ref, path, serializeDoc(meta, body, ['title', 'target', 'conflict', 'line', 'hook', 'notes']))
}

export async function readVolumeOutline(ref: DirRef, volumeId: string): Promise<{ meta: any; body: string }> {
  try {
    return parseDoc(await fs().readFile(ref, [...volumeId.split('/'), VOLUME_OUTLINE_FILE]))
  } catch {
    return { meta: {}, body: '' }
  }
}

/* ------------------------------------------------------------------ 资料（大纲 / 设定 / 记忆） */

async function collectDocs(ref: DirRef, dir: PathSeg, group: string, out: AssetDoc[]) {
  const entries = await safeList(ref, dir)
  for (const e of entries) {
    if (e.kind === 'dir') await collectDocs(ref, [...dir, e.name], group, out)
    else if (e.name.endsWith('.md')) {
      const id = [...dir, e.name].join('/')
      out.push(await loadAsset(ref, id, e.name, group))
    }
  }
}

async function loadAsset(ref: DirRef, id: string, name: string, group: string): Promise<AssetDoc> {
  let wc = 0
  try {
    wc = countWords(parseDoc(await fs().readFile(ref, id.split('/'))).body)
  } catch {
    wc = 0
  }
  return { id, name, group, wordCount: wc }
}

export async function listAssetDocs(ref: DirRef): Promise<AssetDoc[]> {
  const out: AssetDoc[] = []
  await collectDocs(ref, [DIRS.outline], '大纲', out)
  await collectDocs(ref, [DIRS.setting], '设定', out)
  await collectDocs(ref, [DIRS.memory], '记忆', out)
  return out
}

export async function readAsset(ref: DirRef, id: string): Promise<string> {
  return await fs().readFile(ref, id.split('/'))
}

export async function writeAsset(ref: DirRef, id: string, content: string) {
  await fs().writeFile(ref, id.split('/'), content)
}

/* ------------------------------------------------------------------ 记忆库 */

export interface MemoryIndex {
  summaries: Record<string, string>
  raw: string
}

export async function loadSummaries(ref: DirRef): Promise<MemoryIndex> {
  const file = [DIRS.memory, '逐章摘要.md']
  let raw = DEFAULT_MEMORY_FILES['逐章摘要.md']
  try {
    raw = await fs().readFile(ref, file)
  } catch {
    /* noop */
  }
  const summaries: Record<string, string> = {}
  const re = /^##\s+(.+?)\s*$/gm
  const matches = [...raw.matchAll(re)]
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = matches[i + 1]?.index ?? raw.length
    summaries[matches[i][1].trim()] = raw.slice(start, end).trim()
  }
  return { summaries, raw }
}

/* ------------------------------------------------------------------ 另存为 / 备份 */

export async function copyWorkTo(ref: DirRef, dstParent: DirRef, dirName: string) {
  await fs().copyDir(ref, [], dstParent, [], sanitizeName(dirName))
}

/* ------------------------------------------------------------------ 今日字数 */

const K_STATS = 'writer.stats'

export interface DailyStat {
  words: Record<string, number>
}

export function loadStats(): DailyStat {
  try {
    return JSON.parse(localStorage.getItem(K_STATS) || '{"words":{}}')
  } catch {
    return { words: {} }
  }
}

export function addTodayWords(n: number) {
  const s = loadStats()
  const k = todayKey()
  s.words[k] = (s.words[k] || 0) + Math.max(0, n)
  try {
    // 没有 localStorage（离线自检的 Node 环境）或写入被拒（隐私模式 / 配额满）时静默降级：
    // 每日字数只是看板上的锦上添花，绝不能让它把保存流程整个抛断。
    localStorage.setItem(K_STATS, JSON.stringify(s))
  } catch {
    /* noop */
  }
}

export function todayWords(): number {
  return loadStats().words[todayKey()] || 0
}
