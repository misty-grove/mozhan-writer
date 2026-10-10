/**
 * 设定库：把「设定/」下的 Markdown 文件解析成结构化条目
 *
 * 存储仍然是作者自己的 Markdown（见开发文档 4.3），kind 优先取 front matter 的 type，
 * 缺失时按目录名与正文特征推断 —— 这样即便是从旧目录直接打开，也能归类。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { parseDoc, serializeDoc } from './frontmatter'
import { countWords } from './util'
import type { SettingEntry, SettingKind } from './types'

export type { SettingEntry, SettingKind }

export const KIND_LABEL: Record<SettingKind, string> = {
  character: '人物',
  location: '地点',
  item: '道具',
  organization: '组织/势力',
  race: '种族/生物',
  lore: '世界观',
  term: '名词术语',
  timeline: '时间线',
  misc: '其他设定'
}

export const KIND_ORDER: SettingKind[] = [
  'character',
  'location',
  'organization',
  'item',
  'race',
  'lore',
  'term',
  'timeline',
  'misc'
]

/** 每类条目写入哪个目录（沿用作者现有规范，缺的自动建） */
const KIND_DIR: Record<SettingKind, string> = {
  character: '人物设定',
  location: '地点设定',
  item: '道具设定',
  organization: '组织设定',
  race: '种族设定',
  lore: '世界设定',
  term: '术语设定',
  timeline: '时间线',
  misc: '其他设定'
}

interface RawDoc {
  id: string
  file: string
  group: string
  meta: Record<string, any>
  body: string
}

const RESERVED = ['type', 'name', 'aliases', 'title']

function toStr(v: any): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.join('、')
  return String(v)
}

function guessKind(doc: RawDoc): SettingKind {
  const t = String(doc.meta.type || '').toLowerCase()
  if (t) {
    const map: Record<string, SettingKind> = {
      character: 'character',
      char: 'character',
      人物: 'character',
      location: 'location',
      地点: 'location',
      item: 'item',
      道具: 'item',
      organization: 'organization',
      faction: 'organization',
      组织: 'organization',
      势力: 'organization',
      race: 'race',
      species: 'race',
      种族: 'race',
      妖兽: 'race',
      lore: 'lore',
      world: 'lore',
      世界观: 'lore',
      设定: 'lore',
      term: 'term',
      术语: 'term',
      名词: 'term',
      timeline: 'timeline',
      时间线: 'timeline',
      misc: 'misc',
      其他: 'misc'
    }
    if (map[t]) return map[t]
  }
  const haystack = `${doc.file} ${doc.group} ${doc.body.slice(0, 400)}`
  if (/角色|人物|character/i.test(haystack) && /外貌|性格|称呼|关系|出身/.test(doc.body.slice(0, 600))) return 'character'
  if (/道具|武器|物品/.test(haystack)) return 'item'
  if (/组织|势力|门派|机构|联盟/.test(haystack)) return 'organization'
  if (/地点|地理|州|countr|区域/.test(haystack)) return 'location'
  if (/时间线|编年/.test(haystack)) return 'timeline'
  return 'lore'
}

function parseLinks(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) out.push(m[1].trim())
  return [...new Set(out)]
}

function toEntry(doc: RawDoc): SettingEntry {
  const meta = doc.meta || {}
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (RESERVED.includes(k)) continue
    const s = toStr(v)
    if (s) fields[k] = s
  }
  const aliases = Array.isArray(meta.aliases) ? meta.aliases.map(String) : meta.aliases ? String(meta.aliases).split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : []
  const name = String(meta.name || doc.file.replace(/^[^:：]*[:：]\s*/, '').replace(/\.md$/, ''))
  return {
    id: doc.id,
    kind: guessKind(doc),
    name,
    aliases,
    group: doc.group,
    file: doc.file,
    wordCount: countWords(doc.body),
    fields,
    body: doc.body,
    links: parseLinks(doc.body)
  }
}

async function readDir(ref: DirRef, dir: string[]): Promise<RawDoc[]> {
  const out: RawDoc[] = []
  let entries
  try {
    entries = await fs().listDir(ref, dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const id = [...dir, e.name].join('/')
    if (e.kind === 'dir') {
      out.push(...(await readDir(ref, [...dir, e.name])))
      continue
    }
    if (!e.name.endsWith('.md')) continue
    const raw = await fs().readFile(ref, [...dir, e.name])
    const { meta, body } = parseDoc(raw)
    out.push({
      id,
      file: e.name,
      group: dir.length > 1 ? dir[dir.length - 1] : '设定',
      meta,
      body
    })
  }
  return out
}

export async function listEntries(ref: DirRef): Promise<SettingEntry[]> {
  const docs = await readDir(ref, ['设定'])
  const list = docs.map(toEntry)
  return list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name, 'zh'))
}

/** 名称 → 条目（含别名），用于正文里的 [[链接]] 与 @提及 解析 */
export function buildNameMap(entries: SettingEntry[]): Map<string, SettingEntry> {
  const map = new Map<string, SettingEntry>()
  for (const e of entries) {
    map.set(e.name, e)
    for (const a of e.aliases) map.set(a, e)
  }
  return map
}

const ENTRY_ORDER = ['type', 'name', 'aliases']

export async function createEntry(ref: DirRef, kind: SettingKind, name: string, fields: Record<string, string> = {}, body = ''): Promise<SettingEntry> {
  const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  const dir = ['设定', KIND_DIR[kind]]
  await fs().mkdir(ref, dir)
  const file = `${clean}.md`
  const id = [...dir, file].join('/')
  const meta: Record<string, any> = { type: kind, name: clean, ...fields }
  const text = serializeDoc(meta, body || `# ${clean}\n`, ENTRY_ORDER)
  await fs().writeFile(ref, id.split('/'), text)
  const { meta: m, body: b } = parseDoc(text)
  return toEntry({ id, file, group: KIND_DIR[kind], meta: m, body: b })
}

export async function updateEntry(ref: DirRef, id: string, patch: { name?: string; aliases?: string[]; fields?: Record<string, string>; body?: string }) {
  const raw = await fs().readFile(ref, id.split('/'))
  const { meta, body } = parseDoc(raw)
  const next: Record<string, any> = { ...meta }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.aliases !== undefined) next.aliases = patch.aliases
  if (patch.fields !== undefined) {
    for (const [k, v] of Object.entries(patch.fields)) next[k] = v || undefined
  }
  const keys = [...ENTRY_ORDER, ...Object.keys(next).filter((k) => !ENTRY_ORDER.includes(k))]
  const text = serializeDoc(next, patch.body ?? body, keys)
  let target = id
  const parts = id.split('/')
  const newFile = `${String(patch.name ?? meta.name ?? '').replace(/[\\/:*?"<>|]/g, '_')}.md`
  if (patch.name && newFile !== parts[parts.length - 1]) {
    const parent = parts.slice(0, -1)
    await fs().writeFile(ref, [...parent, newFile], text)
    await fs().remove(ref, parts)
    target = [...parent, newFile].join('/')
  } else {
    await fs().writeFile(ref, parts, text)
  }
  return target
}

export async function deleteEntry(ref: DirRef, id: string) {
  await fs().remove(ref, id.split('/'))
}

export function defaultBody(kind: SettingKind, name: string): string {
  const tpl: Record<SettingKind, string> = {
    character: `# ${name}\n\n## 外貌\n\n## 性格\n\n## 背景\n\n## 当前状态\n\n## 关联\n- 与 [[某人]]：关系\n`,
    location: `# ${name}\n\n## 地理位置\n\n## 特征\n\n## 关联\n- 上级地点：[[某处]]\n`,
    item: `# ${name}\n\n## 外观\n\n## 能力 / 作用\n\n## 当前持有者\n\n`,
    organization: `# ${name}\n\n## 立场\n\n## 成员\n\n## 关联\n`,
    race: `# ${name}\n\n## 外形特征\n\n## 能力 / 天赋\n\n## 分布\n\n## 寿命与繁衍\n\n## 与其他种族的关系\n- [[某族]]：\n`,
    lore: `# ${name}\n\n## 规则\n\n## 限制条件\n\n`,
    term: `# ${name}\n\n## 含义\n\n## 首次出现（章节）\n\n## 相关词条\n- [[某词]]：\n`,
    timeline: `# ${name}\n\n| 故事内时间 | 事件 | 在场角色 | 章节 |\n|---|---|---|---|\n`,
    misc: `# ${name}\n\n## 内容\n\n## 备注\n`
  }
  return tpl[kind]
}

/**
 * 整夹导入设定：把 picked 文件夹里的 md / txt 复制到 设定/<目录名>/ 下。
 *
 * 面向「我的设定本来就在别的文件夹里」的作者 —— 选一次目录，
 * 里头的世界观、人物、势力设定就进了设定库（collectDocs 递归扫 设定/，
 * 导进去立刻出现在右栏和上下文里，不用再逐个抄）。
 *
 * 规矩：
 *  - **只补充、不覆盖**：目标已有同名文件就跳过（作者改过的条目金贵）；
 *  - 点前缀的文件跳过（.DS_Store 之类），但 `.mdAI文件/` 目录照收 —— 它是内容目录；
 *  - 只收 md / markdown / txt，别的扩展名不动。
 */
export async function importSettingFolder(ref: DirRef, from: DirRef): Promise<{ copied: number; skipped: number }> {
  let copied = 0
  let skipped = 0
  const destName = (from.name || '导入').replace(/[\\/:*?"<>|]/g, '_') || '导入'

  // 先把整棵源树**快照**下来，再动手复制。不能边走边拷：
  // 目标（设定/）可能就在源目录里（作者手一抖选了作品根、或 设定/ 的上级），
  // 而 listDir 是活视图 —— 边走边写会走进自己刚拷出来的目录，无限递归到内存爆掉
  //（2026-10-10 自检抓到的真 bug：跑 10 分钟不停、node 吃到 2.6 GB）。
  const files: string[][] = []
  async function collect(dir: DirRef, segs: string[]): Promise<void> {
    for (const e of await fs().listDir(dir, segs)) {
      if (e.name.startsWith('.') && e.name !== '.mdAI文件') continue
      const next = [...segs, e.name]
      if (e.kind === 'dir') {
        await collect(dir, next)
        continue
      }
      if (/\.(md|markdown|txt)$/i.test(e.name)) files.push(next)
    }
  }
  await collect(from, [])

  for (const next of files) {
    const dest = ['设定', destName, ...next]
    try {
      await fs().readFile(ref, dest)
      skipped++ // 已存在同名：导入是补充，不是覆盖
      continue
    } catch {
      /* 目标没有这个文件，落下去 */
    }
    await fs().writeFile(ref, dest, await fs().readFile(from, next))
    copied++
  }
  return { copied, skipped }
}
