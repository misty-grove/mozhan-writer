/**
 * 大纲 / 卷纲 / 章纲导入
 *
 * 作者手上的大纲多半是一份 Word 或 md，里面写着「第一卷 … 第一章 …」。
 * 这个模块负责三件事：读懂层级 → 让作者看清要写进哪里 → 落盘。
 *
 * 落盘的位置完全跟着已有的数据模型走（**不发明任何新格式**）：
 *  - 全书大纲 → 大纲/剧情大纲.md（AI 装配上下文时找的就是它）
 *  - 卷纲     → 正文/第XX卷 卷名/卷纲.md（front matter 的 target/conflict/line/hook + 正文）
 *  - 章纲     → 章节文件 front matter 的 target（就是章节卡片里的「本章目标」）
 *
 * 一条铁律：**只追加，不覆盖**。作者已经写过的卷纲、章纲一个字都不动；
 * 目标文件已存在时默认追加在后面，要覆盖得他自己勾选。
 */
import fs from '@/platform'
import type { DirRef, PathSeg } from '@/platform'
import { DIRS, VOLUME_OUTLINE_FILE, createChapter, createVolume, readVolumeOutline, saveVolumeOutline } from './workspace'
import { updateMeta } from './frontmatter'
import { headingOrder } from './importDoc'
import { fmtTime } from './util'
import { cleanHeadingTitle, cleanOutlineNoise } from './textClean'
import type { Chapter, Volume } from './types'

const CJK = '零一二三四五六七八九十百千万两廿卅'
const VOL_LINE = new RegExp(`^第\\s*([0-9${CJK}]{1,10})\\s*[卷部篇]\\s*[、.．:：]?\\s*(.*)$`)
const CH_LINE = new RegExp(`^第\\s*([0-9${CJK}]{1,10})\\s*[章回节]\\s*[、.．:：]?\\s*(.*)$`)
/** 只用来「嗅探语义」：标题文本里含「第X卷」就是卷，含「第X章」就是章 */
const VOL_SMELL = new RegExp(`第\\s*[0-9${CJK}]{1,10}\\s*[卷部篇]`)
const CH_SMELL = new RegExp(`第\\s*[0-9${CJK}]{1,10}\\s*[章回节]`)
const MD_HEAD = /^(#{1,6})\s+(.+?)\s*#*$/
const ROW = /^\|(.+)\|\s*$/
const TARGET_LINE = /^(?:\*\*)?(?:本卷目标|卷目标|本章目标|章纲|目标)(?:\*\*)?\s*[：:]\s*(.+)$/

/* ------------------------------------------------------------------ 结构 */

export interface OutlineChapter {
  title: string
  /** 标题里自带的序号（第12章 → 12） */
  order: number | null
  /** 章纲：显式写的「本章目标」，没有则留空（导入时再决定是否用正文顶上） */
  target: string
  /** 标题下的正文 */
  text: string
  /** 表格里写的字数 */
  words: number
}

export interface OutlineVolume {
  /** 卷名；空串表示「不分卷」（章节直接进 正文/ 根目录） */
  name: string
  target: string
  text: string
  chapters: OutlineChapter[]
}

export interface OutlineTree {
  title: string
  /** 任何标题之前的引子（书名、总纲…） */
  text: string
  volumes: OutlineVolume[]
  /** 一个标题都没认出来 —— 作者给的就是一整篇纯文本 */
  plain: boolean
}

export const EMPTY_TREE: OutlineTree = { title: '', text: '', volumes: [], plain: true }

interface RawNode {
  /** 来自 Markdown 标题的层级（# 数）；「第X卷 / 第X章」行按语义记为 1 / 2 */
  level: number
  title: string
  lines: string[]
  rows: string[][]
  target: string
  /** 这个节点是卷、章、总纲（书名/全书设定）还是细节（并进上一级正文） */
  role: Role
}

/** 节点的角色。note = 书名 / 全书设定这类总纲级内容，sub = 并进上一级的细节 */
type Role = 'volume' | 'chapter' | 'note' | 'sub'

/* ------------------------------------------------------------------ 解析 */

/**
 * Markdown → 卷/章层级树。
 *
 * 层级怎么定（**语义优先**，这是 2026-10 重写的重点）：
 *
 * 作者手里的大纲，尤其是 AI 生成的那些，标题层级从来不按软件的心意来：
 *  - `# 书名` `## 第一卷 启程` `### 第一章 雪夜`（Word 导出最常见）
 *  - `# 全书设定` `## 第一卷 启程` + 一张章节表格
 *  - 老写法：`# 第一卷` `## 第一章`（自检用例 42.4 就是它）
 *
 * 老实现按「# = 卷、## = 章」硬套，于是 `## 第一卷` 被当成一章、
 * `# 书名` 被当成一卷，卷下的章节表格整张吞进「章」里 —— 导入完目录一团乱。
 * 现在改成：**标题文本先说自己是卷还是章**（「第X卷 / 第X章 / 第X部 / 第X回」），
 * Markdown 井号只在语义没说清时按相对深度兜底。
 */
export function parseOutlineText(md: string): OutlineTree {
  const src = cleanOutlineNoise(md || '')
  const lines = src.split('\n')

  const nodes: RawNode[] = []
  const preface: string[] = []
  let cur: RawNode | null = null
  // 开新节点必须就地赋值：TS 不做跨函数的控制流分析，
  // 写在闭包里的 `cur = n` 会让下面 `if (cur)` 被收窄成 never。
  const NEW = (level: number, title: string, role: Role): RawNode => ({ level, title, lines: [], rows: [], target: '', role })

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const mdH = MD_HEAD.exec(line)
    if (mdH) {
      cur = NEW(mdH[1].length, cleanHeadingTitle(mdH[2]), 'sub')
      nodes.push(cur)
      continue
    }
    const row = ROW.exec(line)
    if (row) {
      const cells = row[1]
        .split('|')
        .map((c) => c.trim())
        .filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c))
      const isSep = cells.every((c) => /^:?-{2,}:?$/.test(c))
      if (isSep) continue
      if (cur) cur.rows.push(cells)
      continue
    }
    const vol = VOL_LINE.exec(line)
    if (vol && line.length <= 60) {
      const order = vol[1]
      const rest = cleanHeadingTitle(vol[2])
      cur = NEW(1, rest ? `第${order}卷 ${rest}` : `第${order}卷`, 'volume')
      nodes.push(cur)
      continue
    }
    const ch = CH_LINE.exec(line)
    if (ch && line.length <= 60) {
      const order = ch[1]
      const rest = cleanHeadingTitle(ch[2])
      cur = NEW(2, rest ? `第${order}章 ${rest}` : `第${order}章`, 'chapter')
      nodes.push(cur)
      continue
    }
    const tg = TARGET_LINE.exec(line)
    if (tg && cur) {
      cur.target = cur.target ? `${cur.target} ${tg[1].trim()}` : tg[1].trim()
      continue
    }
    if (cur) cur.lines.push(line.replace(/\s+$/, ''))
    else preface.push(line)
  }

  if (!nodes.length) {
    return { title: '', text: src.trim(), volumes: [], plain: true }
  }

  assignRoles(nodes)

  /* 定完角色的节点 → 卷/章 */
  const tree: OutlineTree = { title: '', text: preface.join('\n').trim(), volumes: [], plain: false }
  // 书名：第一个总纲之前的那几行里，像书名（《…》或短得没有句号）的那一行
  if (!tree.title) tree.title = pickBookTitle(preface, nodes)

  let vol: OutlineVolume | null = null
  let chap: OutlineChapter | null = null

  const ensureVolume = (name: string): OutlineVolume => {
    const hit = name ? tree.volumes.find((v) => v.name === name) : null
    if (hit) return hit
    const v: OutlineVolume = { name, target: '', text: '', chapters: [] }
    tree.volumes.push(v)
    return v
  }
  const addChapter = (v: OutlineVolume, c: OutlineChapter) => {
    if (v.chapters.some((x) => x.title === c.title)) return
    v.chapters.push(c)
  }
  const joinText = (a: string, b: string) => (a ? (b ? `${a}\n${b}` : a) : b)
  /** 表格行写成 Markdown 表格（带分隔行，作者拿记事本打开也是张表） */
  const rowLines = (rows: string[][]) => {
    const out: string[] = []
    rows.forEach((cells, i) => {
      out.push(`| ${cells.join(' | ')} |`)
      if (i === 0) out.push(`| ${cells.map(() => '---').join(' | ')} |`)
    })
    return out.join('\n')
  }

  for (const n of nodes) {
    if (n.role === 'volume') {
      vol = ensureVolume(n.title)
      vol.target = vol.target || n.target
      vol.text = joinText(vol.text, n.lines.join('\n').trim())
      chap = null
      // 卷下面的表格 = 章节清单；认不出来的行原样留在卷纲里（**不丢内容**）
      const rest: string[][] = []
      for (const [i, cells] of n.rows.entries()) {
        if (i === 0 && looksLikeHead(cells)) continue
        const c = rowToChapter(cells)
        if (c) addChapter(vol, c)
        else rest.push(cells)
      }
      if (rest.length) vol.text = joinText(vol.text, rowLines(rest))
      continue
    }
    if (n.role === 'chapter') {
      if (!vol) vol = ensureVolume('')
      chap = {
        title: n.title,
        order: headingOrder(n.title),
        target: n.target,
        text: joinText(n.lines.join('\n').trim(), n.rows.length ? rowLines(n.rows) : ''),
        words: 0
      }
      addChapter(vol, chap)
      continue
    }
    // note（书名 / 全书设定）与 sub（更深一级的小细节）都不另起卷章：
    // note 进全书大纲正文，sub 并进所属章 / 所属卷。
    const block = [`${'#'.repeat(Math.min(6, n.level))} ${n.title}`, ...n.lines, ...(n.rows.length ? [rowLines(n.rows)] : [])].join('\n')
    if (n.role === 'note') {
      tree.text = tree.text ? `${tree.text}\n${block}` : block
      continue
    }
    if (chap) chap.text = chap.text ? `${chap.text}\n${block}` : block
    else if (vol) vol.text = vol.text ? `${vol.text}\n${block}` : block
    else tree.text = tree.text ? `${tree.text}\n${block}` : block
  }

  // 只有「第X章」没有卷名时，给一个无名卷（= 正文根目录），UI 上写「不分卷」
  if (!tree.volumes.length) tree.volumes.push({ name: '', target: '', text: '', chapters: [] })
  return tree
}

/**
 * 给每个节点定角色。
 *
 * 顺序：
 *  1. 文本语义最优先 —— 写着「第X卷 / 部 / 篇」的就是卷，「第X章 / 回 / 节」的就是章，
 *     跟它是几个 # 无关（`## 第一卷` 是卷，`# 第一章` 也是章）。
 *  2. 剩下的 Markdown 标题按「层级投票」定：同一层级的标题们，语义多的赢；
 *     都是普通文字的，按它在文档里的深浅排 —— 最浅的是总纲（有卷存在时）
 *     或第一卷（没有卷标题时），深一级是章，再深是细节。
 */
function assignRoles(nodes: RawNode[]) {
  const hasVolNode = nodes.some((n) => VOL_SMELL.test(n.title))
  // 语义角色先钉死（vol/ch 行在建节点时已给，这里补 md 标题的）
  for (const n of nodes) {
    if (n.role === 'volume' || n.role === 'chapter') continue
    if (VOL_SMELL.test(n.title)) n.role = 'volume'
    else if (CH_SMELL.test(n.title)) n.role = 'chapter'
  }
  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => a - b)
  const roleByLevel = new Map<number, Role>()
  let prevRole: Role = hasVolNode ? 'note' : 'volume'
  for (const lv of levels) {
    const group = nodes.filter((n) => n.level === lv)
    const volN = group.filter((n) => n.role === 'volume').length
    const chN = group.filter((n) => n.role === 'chapter').length
    let role: Role
    if (volN > chN && volN > 0) role = 'volume'
    else if (chN > 0) role = 'chapter'
    // 全是普通文字的层级：按它在文档里的深浅排
    else if (roleByLevel.size === 0) role = hasVolNode ? 'note' : 'volume'
    else if (prevRole === 'note') role = 'volume'
    else if (prevRole === 'volume') role = 'chapter'
    else role = 'sub'
    roleByLevel.set(lv, role)
    prevRole = role
  }
  for (const n of nodes) {
    if (n.role === 'volume' || n.role === 'chapter') continue
    n.role = roleByLevel.get(n.level) || 'sub'
  }
}

/** 书名：第一个标题之前那段里，最像书名的一行（《…》优先，其次短得没有句号的） */
function pickBookTitle(preface: string[], nodes: RawNode[]): string {
  for (const line of preface) {
    const t = line.trim()
    if (!t) continue
    const m = /^《(.+?)》/.exec(t)
    if (m) return m[1].trim()
    if (t.length <= 30 && !/[。！？，,;；]/.test(t)) return t
  }
  // 书名不在开头：第一个总纲级标题也当书名用（「# 全书设定」之类就算了，
  // 那是内容不是书名 —— 所以只取 note 角色里不带「设定/大纲/简介」字样的）
  const note = nodes.find((n) => n.role === 'note')
  if (note && !/设定|大纲|简介|概览|总纲|说明/.test(note.title)) return note.title
  return ''
}

/** 表格首行是不是表头（章节 / 目标 / 字数 …） */
function looksLikeHead(cells: string[]): boolean {
  const joined = cells.join('')
  return /章节|章名|标题|序号|目标|梗概|字数|内容/.test(joined) && !CH_LINE.test(cells[0] || '')
}

/** 表格一行 → 一章；第一列不像章节名就返回 null（别把普通表格也变成章） */
function rowToChapter(cells: string[]): OutlineChapter | null {
  const name = (cells[0] || '').trim()
  if (!name) return null
  const isChapter = CH_LINE.test(name) || /章/.test(name) || (name.length <= 40 && /^[\d.、]+$/.test(name))
  if (!isChapter) return null
  let target = ''
  let words = 0
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i].trim()
    if (!c) continue
    // 纯数字一律当字数（「3200」不该混进章纲里）
    if (/^\d[\d,]*$/.test(c)) {
      words = Number(c.replace(/,/g, '')) || words
      continue
    }
    target = target ? `${target}；${c}` : c
  }
  return { title: cleanHeadingTitle(name), order: headingOrder(name), target, text: '', words }
}

/** 卷纲正文：卷自己的文字 + 章清单（作者拿记事本打开也看得懂） */
export function volumeOutlineBody(v: OutlineVolume): string {
  const parts: string[] = []
  if (v.text.trim()) parts.push(v.text.trim())
  if (v.chapters.length) {
    parts.push('## 章节安排', '')
    for (const c of v.chapters) parts.push(`- ${c.title}${c.target ? `：${c.target}` : ''}${c.words ? `（约 ${c.words} 字）` : ''}`)
  }
  return parts.join('\n\n').trim()
}

/**
 * 新建章节坑位时的标题：作者写的「第010章 出发」不重复进文件名。
 * 卷内会重新编号（第001章…），文件名里出现两个章号既难看也容易误导。
 */
export function cleanChapterTitle(t: string): string {
  const s = t.trim()
  const m = /^第\s*\d+\s*章\s*(.+)$/.exec(s)
  return (m ? m[1] : s).trim() || s
}

export function treeStats(tree: OutlineTree) {
  const chapters = tree.volumes.reduce((n, v) => n + v.chapters.length, 0)
  return { volumes: tree.volumes.length, chapters }
}

/* ------------------------------------------------------------------ 匹配 */

function norm(s: string): string {
  return s.replace(/[\s　]/g, '').replace(/[（(].*?[)）]/g, '').toLowerCase()
}

/** 找已有卷：先按卷号，再按卷名 */
export function findVolume(volumes: Volume[], name: string): Volume | null {
  const n = norm(name)
  if (!n) return null
  for (const v of volumes) {
    if (norm(v.name) === n) return v
  }
  for (const v of volumes) {
    const a = /第\s*(\d+)\s*卷/.exec(v.name)
    const b = /第\s*(\d+)\s*卷/.exec(name)
    if (a && b && a[1] === b[1]) return v
  }
  // 「第一卷 启程」 vs 「启程」
  for (const v of volumes) {
    const stripped = norm(v.name.replace(/^第\s*\d+\s*卷/, ''))
    if (stripped && stripped === n) return v
  }
  return null
}

/** 找已有章：先按章号，再按标题 */
export function findChapter(chapters: Chapter[], c: OutlineChapter): Chapter | null {
  if (c.order !== null) {
    const hit = chapters.find((x) => x.order === c.order)
    if (hit) return hit
  }
  const t = norm(c.title)
  if (!t) return null
  const exact = chapters.find((x) => norm(x.title) === t)
  if (exact) return exact
  const bare = t.replace(/^第\d+章/, '')
  if (bare) {
    const hit = chapters.find((x) => {
      const xb = norm(x.title).replace(/^第\d+章/, '')
      return xb === bare
    })
    if (hit) return hit
  }
  return null
}

/**
 * 全书大纲落在哪：**只看作者看得见的 大纲/ 根目录**（剧情大纲 / 全书…），
 * 没有就新建 大纲/剧情大纲.md。
 *
 * 为什么不递归进 `.mdAI文件/`：那是新建作品时预置的模板目录。早先这里递归找，
 * 结果导入的大纲落在根下、而目录树/上下文读到的还是 `.mdAI文件/` 里那份空模板 ——
 * 作者看着「导进去了」，翻开却是空的。模板只配当兜底，不配当事实来源。
 */
export async function findBookOutlinePath(ref: DirRef): Promise<PathSeg> {
  let entries: { name: string; kind: 'file' | 'dir' }[] = []
  try {
    entries = await fs().listDir(ref, [DIRS.outline])
  } catch {
    return [DIRS.outline, '剧情大纲.md']
  }
  const hit = entries.find((e) => e.kind === 'file' && e.name.endsWith('.md') && /剧情大纲|全书/.test(e.name))
  return hit ? [DIRS.outline, hit.name] : [DIRS.outline, '剧情大纲.md']
}

async function tryRead(ref: DirRef, path: PathSeg): Promise<string> {
  try {
    return await fs().readFile(ref, path)
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ 落盘 */

export type OutlineMode = 'book' | 'volume' | 'chapter'

export interface ApplyOptions {
  mode: OutlineMode
  /** 当前已有哪些卷/章（用来匹配，不重新扫描） */
  volumes: Volume[]
  rootChapters: Chapter[]
  /** 章纲模式下没有对应章节时，是否新建章节坑位 */
  createChapters?: boolean
  /** 已存在的卷纲 / 全书大纲：覆盖而不是追加（默认 false —— 绝不替作者决定覆盖） */
  overwrite?: boolean
  /** 勾选的卷（索引）；不给视为全选 */
  picked?: boolean[]
  onProgress?: (done: number, total: number, label: string) => void
}

export interface ApplyResult {
  written: { path: string; kind: string }[]
  volumesCreated: number
  chaptersCreated: number
  chaptersUpdated: number
  skipped: string[]
}

const SEP = '\n\n---\n\n'

export async function applyOutline(
  ref: DirRef,
  md: string,
  tree: OutlineTree,
  opts: ApplyOptions
): Promise<ApplyResult> {
  const res: ApplyResult = { written: [], volumesCreated: 0, chaptersCreated: 0, chaptersUpdated: 0, skipped: [] }
  const picked = opts.picked && opts.picked.length === tree.volumes.length ? opts.picked : tree.volumes.map(() => true)
  const volumes = tree.volumes.filter((_, i) => picked[i])

  if (opts.mode === 'book') {
    const path = await findBookOutlinePath(ref)
    const prev = await tryRead(ref, path)
    const text = opts.overwrite || !prev.trim() ? md.trim() : `${prev.replace(/\s+$/, '')}${SEP}${md.trim()}`
    await fs().writeFile(ref, path, `${text}\n`)
    res.written.push({ path: path.join('/'), kind: '全书大纲' })
    return res
  }

  const workVolumes = [...opts.volumes]
  const total = Math.max(1, volumes.reduce((n, v) => n + 1 + (opts.createChapters ? v.chapters.length : 0), 0))
  let done = 0
  const tick = (label: string) => opts.onProgress?.(++done, total, label)

  for (const v of volumes) {
    if (opts.mode === 'volume') tick(`写入卷纲：${v.name || '不分卷'}`)

    /* 定位卷：已有的直接用，没有才建 */
    let vol: Volume | null = v.name ? findVolume(workVolumes, v.name) : null
    if (!vol && v.name) {
      vol = await createVolume(ref, v.name)
      workVolumes.push(vol)
      res.volumesCreated++
    }
    const volumeId = vol ? vol.id : null

    if (opts.mode === 'volume' && vol) {
      const { meta, body } = await readVolumeOutline(ref, vol.id)
      const nextTarget = v.target || String(meta.target || '')
      const add = volumeOutlineBody(v)
      const nextBody = opts.overwrite || !body.trim() ? add : `${body.replace(/\s+$/, '')}${SEP}${add}`
      await saveVolumeOutline(ref, vol.id, { ...meta, title: vol.name, target: nextTarget }, nextBody)
      res.written.push({ path: `${vol.id}/${VOLUME_OUTLINE_FILE}`, kind: '卷纲' })
    }

    if (!opts.createChapters) continue

    // 拷贝一份：这次导入新建的章只用来做去重，不该直接改到界面正在用的数组上
    const pool = volumeId ? [...(workVolumes.find((x) => x.id === volumeId)?.chapters ?? [])] : [...opts.rootChapters]

    for (const c of v.chapters) {
      if (opts.mode === 'chapter') tick(`写入章纲：${c.title}`)
      const hit = findChapter(pool, c)
      // 章纲：显式目标优先，其次用标题下的正文（作者写的那段描述就是章纲）
      const target = (c.target || c.text || '').trim().replace(/\s+/g, ' ').slice(0, 500)
      if (hit) {
        if (!target) {
          res.skipped.push(`${c.title}（没有读到章纲内容，跳过）`)
          continue
        }
        const raw = await fs().readFile(ref, hit.id.split('/'))
        await fs().writeFile(ref, hit.id.split('/'), updateMeta(raw, { target, updated: fmtTime(new Date()) }))
        res.chaptersUpdated++
        res.written.push({ path: hit.id, kind: '章纲' })
      } else {
        const name = cleanChapterTitle(c.title)
        // 一次写完：createChapter 已带 patch，不必建完空章再 saveChapter 覆写一遍
        // （手机上每章省一次落盘，几百章的大纲就是几百次）
        const ch = await createChapter(ref, volumeId, name, { patch: { target: target || undefined, status: '待写' } })
        pool.push({ ...ch, meta: { ...ch.meta, target } })
        res.chaptersCreated++
        res.written.push({ path: ch.id, kind: '章纲（新建章节）' })
      }
    }
  }
  return res
}
