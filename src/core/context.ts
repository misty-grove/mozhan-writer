/**
 * 上下文装配（开发文档 P0-5）
 * 「续写质量的上限由它决定」——装配什么、注入多少，作者必须看得见、改得了。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { countWords, estimateTokens } from './util'
import { DIRS, VOLUME_OUTLINE_FILE, listAssetDocs, loadSummaries, readChapterBody, readVolumeOutline } from './workspace'
import { cachedIndex, search, splitPassages } from './retrieve'
import { collectStyleSamples, readStyleNotes } from './styleLearn'
import type { AssetDoc, Chapter, ContextItem, Volume } from './types'

export interface BuildOptions {
  recentChapters: number
  tailChars: number
  includePrevFull: boolean
  styleSampleChars: number
  /** 语义召回几条相关前文（0 = 关闭）。走本地 TF-IDF，不联网 */
  recallTop: number
  /** 作者导入/粘贴的文风样本（记忆/文风样本/ 下的文件名），勾了才注入 */
  styleSampleFiles?: string[]
}

export const DEFAULT_BUILD: BuildOptions = {
  recentChapters: 3,
  tailChars: 1200,
  includePrevFull: false,
  styleSampleChars: 1500,
  recallTop: 4,
  styleSampleFiles: []
}

async function tryRead(ref: DirRef, path: string[]): Promise<string> {
  try {
    return await fs().readFile(ref, path)
  } catch {
    return ''
  }
}

async function findFirstDoc(ref: DirRef, root: string, keywords: string[]): Promise<{ id: string; text: string } | null> {
  const docs = await listAssetDocs(ref)
  const hit = docs.filter((d) => d.group === root).find((d) => keywords.some((k) => d.name.includes(k)))
  if (!hit) return null
  const text = await tryRead(ref, hit.id.split('/'))
  return { id: hit.id, text }
}

export async function buildContextItems(
  ref: DirRef,
  chapter: Chapter,
  volume: Volume | null,
  orderedChapters: Chapter[],
  assets: AssetDoc[],
  opts: BuildOptions = DEFAULT_BUILD,
  /** 各章正文（给了才做语义召回，省掉重复 IO） */
  bodies?: Record<string, string>
): Promise<ContextItem[]> {
  const items: ContextItem[] = []
  const push = (i: Omit<ContextItem, 'enabled'> & { enabled?: boolean }) =>
    items.push({ enabled: i.enabled ?? true, ...i })

  /* 1. 全书大纲 */
  const bookOutline = await findFirstDoc(ref, '大纲', ['剧情大纲', '全书'])
  if (bookOutline) {
    push({
      id: 'book-outline',
      label: '全书剧情大纲',
      detail: bookOutline.id,
      group: '大纲',
      content: bookOutline.text,
      enabled: true,
      source: bookOutline.id
    })
  } else {
    const alt = await tryRead(ref, [DIRS.outline, '.mdAI文件', '剧情大纲.md'])
    if (alt) push({ id: 'book-outline', label: '全书剧情大纲', detail: DIRS.outline + '/.mdAI文件/剧情大纲.md', group: '大纲', content: alt, source: [DIRS.outline, '.mdAI文件', '剧情大纲.md'].join('/') })
  }

  /* 2. 本卷卷纲 */
  if (volume) {
    const { meta, body } = await readVolumeOutline(ref, volume.id)
    const text = [`# ${volume.name}`, meta.target ? `本卷目标：${meta.target}` : '', meta.conflict ? `核心冲突：${meta.conflict}` : '', meta.line ? `推进线：${meta.line}` : '', meta.hook ? `卷末钩子：${meta.hook}` : '', '', body]
      .filter((x) => x !== '')
      .join('\n')
    push({ id: 'volume-outline', label: `本卷卷纲 · ${volume.name}`, detail: `${volume.dir}/${VOLUME_OUTLINE_FILE}`, group: '大纲', content: text, source: `${volume.id}/${VOLUME_OUTLINE_FILE}` })
  }

  /* 3. 本章章纲 */
  const m = chapter.meta
  const chCard = [
    `章节：${chapter.title}（${chapter.status}）`,
    m.target ? `本章目标：${m.target}` : '',
    m.characters?.length ? `出场人物：${m.characters.join('、')}` : '',
    m.settings?.length ? `涉及设定：${m.settings.join('、')}` : '',
    m.emotion ? `情绪走向：${m.emotion}` : '',
    chapter.tags.length ? `标签：${chapter.tags.join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  push({ id: 'chapter-card', label: '本章章纲（目标 / 出场 / 涉及设定 / 情绪）', detail: chapter.file, group: '本章', content: chCard || '（本章尚未填写章纲字段）', enabled: true, source: chapter.id })

  /* 4. 设定：逐条可选 */
  for (const a of assets.filter((x) => x.group === '设定')) {
    const text = await tryRead(ref, a.id.split('/'))
    push({
      id: `asset:${a.id}`,
      label: `设定 · ${a.name.replace('.md', '')}`,
      detail: a.id,
      group: '设定',
      content: text,
      enabled: a.wordCount < 8000,
      source: a.id
    })
  }

  /* 5. 近 N 章摘要 */
  const { summaries } = await loadSummaries(ref)
  const idx = orderedChapters.findIndex((c) => c.id === chapter.id)
  const prev = idx > 0 ? orderedChapters.slice(Math.max(0, idx - opts.recentChapters), idx) : []
  if (prev.length) {
    const blocks = prev.map((c) => {
      const key = Object.keys(summaries).find((k) => k.includes(c.title) || c.file.includes(k)) || ''
      return `### ${c.title}\n${key ? summaries[key] : '（尚无摘要，建议先跑记忆整理）'}`
    })
    push({
      id: 'recent-summaries',
      label: `近 ${prev.length} 章摘要`,
      detail: prev.map((c) => c.title).join(' / '),
      group: '记忆',
      content: blocks.join('\n\n'),
      enabled: true,
      source: `${DIRS.memory}/逐章摘要.md`
    })
  }

  /* 6. 上一章结尾原文 */
  const prevChapter = idx > 0 ? orderedChapters[idx - 1] : null
  if (prevChapter) {
    const body = await readChapterBody(ref, prevChapter.id)
    const tail = body.slice(-opts.tailChars)
    push({
      id: 'prev-tail',
      label: `上一章结尾原文（${Math.min(opts.tailChars, countWords(body))} 字）`,
      detail: prevChapter.title,
      group: '前文',
      content: `（以下是《${prevChapter.title}》的结尾部分）\n\n${tail}`,
      enabled: true,
      source: prevChapter.id
    })
  }

  /* 7. 前文整章（可选，默认关） */
  if (opts.includePrevFull && prevChapter) {
    const body = await readChapterBody(ref, prevChapter.id)
    push({ id: 'prev-full', label: `上一章全文 · ${prevChapter.title}`, detail: prevChapter.title, group: '前文', content: body, enabled: false, source: prevChapter.id })
  }

  /* 8. 文风样本 */
  if (opts.styleSampleChars > 0) {
    const src = prevChapter || chapter
    const body = await readChapterBody(ref, src.id)
    if (body.trim()) {
      const sample = body.slice(0, opts.styleSampleChars)
      push({
        id: 'style-sample',
        label: `文风样本（${src.title} 前 ${Math.min(opts.styleSampleChars, countWords(body))} 字）`,
        detail: '用于锚定文风，禁止照抄内容',
        group: '文风',
        content: `（以下是文风参考样本，仅用于把握句式与用词节奏，不得复述其中的情节）\n\n${sample}`,
        enabled: true,
        source: src.id
      })
    }
  }

  /* 8.1 作者导入的文风样本（记忆/文风样本/）：他想学的味道在这里，
         不是从自己旧稿里抽的统计指标。目录不存在就是空，不算错。 */
  if (opts.styleSampleFiles?.length) {
    const text = await collectStyleSamples(ref, opts.styleSampleFiles, Math.max(1000, opts.styleSampleChars * 4))
    if (text.trim()) {
      push({
        id: 'style-imported',
        label: `导入的文风样本（${opts.styleSampleFiles.length} 份）`,
        detail: '作者自己提供的参考，只学味道，不得复述其中情节',
        group: '文风',
        content: `（以下是作者导入的文风样本，用来把握句式与用词节奏，不得复述其中的情节与设定）\n\n${text}`,
        enabled: true,
        source: '记忆/文风样本'
      })
    }
  }

  /* 8.2 文风要点（记忆/文风要点.md）：AI 学过样本之后归纳出的规则，作者可手改。
         有了它，续写才有「照这个味道写」的抓手，而不是靠模型临场发挥。 */
  const styleNotes = await readStyleNotes(ref)
  if (styleNotes) {
    push({
      id: 'style-notes',
      label: `文风要点（${countWords(styleNotes)} 字）`,
      detail: '记忆/文风要点.md —— AI 从样本里归纳的规则，作者可手改',
      group: '文风',
      content: `（以下是本作品的文风要点。写正文时必须遵守它，尤其是「禁忌」那一节）\n\n${styleNotes}`,
      enabled: true,
      source: '记忆/文风要点.md'
    })
  }

  /* 9. 语义召回：按「本章目标 + 已写内容」，从全书找最相关的段落。
        作者看不见的自动注入是可疑的，所以它作为一个可勾选、可取消的条目出现。 */
  if (opts.recallTop > 0 && bodies) {
    const passages = splitPassages(orderedChapters, bodies)
    if (passages.length) {
      const key = `${ref.id}:${passages.length}:${Object.values(bodies).join('').length}`
      const index = cachedIndex(key, passages)
      const query = [chapter.meta?.target, (bodies[chapter.id] || '').slice(-400)].filter((x) => x && x.trim()).join('\n')
      const recalled = search(index, query, opts.recallTop).filter((h) => h.score > 0.02)
      if (recalled.length) {
        const blocks = recalled.map(
          (h) => `（相关度 ${(h.score * 100).toFixed(0)}）《${h.passage.chapterTitle}》\n${h.passage.text}`
        )
        push({
          id: 'recall',
          label: `语义召回 · ${recalled.length} 段相关前文`,
          detail: recalled.map((h) => h.passage.chapterTitle).join(' / '),
          group: '前文',
          content: blocks.join('\n\n'),
          // 默认关：作者自己决定要不要让 AI 看到这些
          enabled: false,
          source: '本地 TF-IDF'
        })
      }
    }
  }

  return items
}

export function contextTotal(items: ContextItem[]): { chars: number; tokens: number } {
  const text = items.filter((i) => i.enabled).map((i) => i.content).join('\n')
  return { chars: text.length, tokens: estimateTokens(text) }
}

export function renderContext(items: ContextItem[], instructions: string): string {
  const enabled = items.filter((i) => i.enabled)
  let out = ''
  for (const g of ['大纲', '本章', '设定', '记忆', '前文', '文风'] as const) {
    const groupItems = enabled.filter((i) => i.group === g)
    if (!groupItems.length) continue
    out += `\n\n===== ${g} =====\n`
    for (const i of groupItems) out += `\n【${i.label}】\n${i.content}\n`
  }
  return `${instructions}\n${out}`
}
