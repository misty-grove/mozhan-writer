/**
 * 全文翻译的执行层（分块调用 → 拼回 → 进候选区）
 *
 * 三条不能破的规矩：
 * 1. **产出先进候选区**。翻译也是 AI 产出，作者不点采纳就什么都没落盘
 *    （跟续写 / 设定生成同一条铁律）。
 * 2. **绝不覆盖作者原文**。译文的落点是「存为新章节」或「存为 md」，
 *    没有「替换本章」这个按钮 —— 翻译错了还能救，覆盖错了救不回来。
 * 3. **失败要说出来**。某一块翻挂了，就把它留在原文并如实报哪几块没翻，
 *    不能让作者拿到一份「看着完整、其实中间夹着原文」的译文。
 */
import { reactive } from 'vue'
import { chatOnce, aiState, enabled } from './ai'
import { settings } from '@/core/settings'
import { countWords, uid, fmtTime } from '@/core/util'
import {
  chunkUser,
  detectLang,
  joinTranslated,
  langLabel,
  splitForTranslate,
  translateSystem,
  translatedTitle,
  type LangCode,
  type TranslateOpts
} from '@/core/translate'
import type { Candidate } from '@/core/types'

export const translateState = reactive({
  busy: false,
  /** 已完成块数 / 总块数（界面上给进度，别让作者对着转圈猜） */
  done: 0,
  total: 0,
  /** 当前在翻第几章（全书模式） */
  chapter: '',
  chapterIndex: 0,
  chapterTotal: 0,
  error: '' as string,
  cancel: false,
  /** 跑完之后的结论（几章成了、几章没成），对话框关掉后还想看一眼就靠它 */
  summary: '' as string
})

let abort: AbortController | null = null

export function cancelTranslate() {
  translateState.cancel = true
  abort?.abort()
}

/** 一块的最大字数：留出输出空间，别让模型翻到一半被截断 */
const CHUNK = 1600

export interface TranslateJob {
  /** 目标语言 */
  to: LangCode
  /** 待翻的章节：id + 标题 + 正文 */
  chapters: Array<{ id: string; title: string; text: string }>
  opts?: TranslateOpts
}

export interface TranslateResult {
  ok: boolean
  /** 成功翻出来的章节 */
  done: Array<{ id: string; title: string; text: string; to: LangCode }>
  /** 没翻成的章节（含原因） */
  failed: Array<{ title: string; reason: string }>
}

/**
 * 翻一章。
 *
 * 返回的是「翻好的文本」而不是直接写盘 —— 落点交给作者在候选区决定。
 * 块与块之间串行：并行会把顺序打乱（模型返回快慢不一），
 * 而译文的顺序错了比慢一点严重得多。
 */
async function translateOne(text: string, to: LangCode, opts: TranslateOpts, onChunk: (d: number, t: number) => void): Promise<string> {
  const chunks = splitForTranslate(text, CHUNK)
  if (!chunks.length) return ''
  const system = translateSystem(to, opts)
  const out: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (translateState.cancel) throw new Error('已取消')
    onChunk(i, chunks.length)
    abort = new AbortController()
    try {
      const t = await chatOnce(system, chunkUser(chunks[i].text, i, chunks.length, to, opts), abort.signal)
      out.push(t || '')
    } finally {
      abort = null
    }
    onChunk(i + 1, chunks.length)
  }
  // sep 跟着块走：段与段之间空一行，段内换行保持换行 —— 作者的分段一个都不许改
  return joinTranslated(out, chunks)
}

/** 把译文塞进候选区（作者点了采纳才真正落盘） */
function pushTranslateCandidate(title: string, text: string, to: LangCode, chapterId: string): Candidate {
  const c: Candidate = {
    id: uid('cand'),
    title: `${title} · ${langLabel(to)}译文`,
    text,
    model: settings.ai.model,
    skill: '',
    createdAt: fmtTime(new Date()),
    mode: 'translate',
    targetChapterId: chapterId,
    tokens: Math.ceil(text.length / 2)
  }
  aiState.candidates.unshift(c)
  return c
}

/**
 * 跑一次翻译任务（支持多章）。
 *
 * 全书模式是串行逐章翻的：几十章并发既会打爆限速，也会让进度条失去意义。
 * 中途取消时，**已经翻完的章节照样进候选区** —— 作者取消是想停下，
 * 不是想让前面那几章白等。
 */
export async function runTranslate(job: TranslateJob): Promise<TranslateResult> {
  const res: TranslateResult = { ok: true, done: [], failed: [] }
  if (!enabled.value) {
    translateState.error = '尚未配置 API，翻译不可用'
    return { ok: false, done: [], failed: [] }
  }
  const list = job.chapters.filter((c) => c.text.trim())
  if (!list.length) {
    translateState.error = '要翻的章节是空的。'
    return { ok: false, done: [], failed: [] }
  }

  translateState.busy = true
  translateState.cancel = false
  translateState.error = ''
  translateState.done = 0
  translateState.total = 0
  translateState.chapterTotal = list.length
  translateState.chapterIndex = 0
  translateState.summary = ''

  try {
    for (const ch of list) {
      if (translateState.cancel) break
      translateState.chapterIndex++
      translateState.chapter = ch.title
      const from = job.opts?.from || detectLang(ch.text) || undefined
      const opts: TranslateOpts = { keepNames: true, ...(job.opts || {}), from }
      try {
        const text = await translateOne(ch.text, job.to, opts, (d, t) => {
          translateState.done = d
          translateState.total = t
        })
        if (!text.trim()) {
          res.failed.push({ title: ch.title, reason: 'AI 没有返回译文' })
          continue
        }
        pushTranslateCandidate(translatedTitle(ch.title, job.to), text, job.to, ch.id)
        res.done.push({ id: ch.id, title: ch.title, text, to: job.to })
      } catch (e: any) {
        if (translateState.cancel) break
        res.failed.push({ title: ch.title, reason: e?.message || '翻译失败' })
      }
    }
    const bits: string[] = []
    if (res.done.length) bits.push(`${res.done.length} 章译文已放进候选区（${countWords(res.done.map((d) => d.text).join(''))} 字）`)
    if (res.failed.length) bits.push(`${res.failed.length} 章没翻成：${res.failed.map((f) => f.title).slice(0, 3).join('、')}`)
    if (translateState.cancel) bits.push('已中途停止')
    translateState.error = res.failed.length && !res.done.length ? `翻译失败：${res.failed[0].reason}` : ''
    if (bits.length && !translateState.error) aiState.error = ''
    res.ok = res.done.length > 0
    translateState.summary = bits.join('；')
    return res
  } finally {
    translateState.busy = false
    translateState.chapter = ''
    translateState.done = 0
    translateState.total = 0
  }
}
