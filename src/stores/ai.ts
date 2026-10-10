import { computed, reactive, ref } from 'vue'
import { buildContextItems, contextTotal, DEFAULT_BUILD, renderContext, type BuildOptions } from '@/core/context'
import * as layer from '@/core/ai'
import { aiEnabled, settings } from '@/core/settings'
import { countWords, fmtTime, uid } from '@/core/util'
import { readChapterBody } from '@/core/workspace'
import { updateMemorySection } from '@/core/memory'
import { readMemoryFile, writeMemoryFile } from '@/core/memory'
import * as skillsApi from '@/core/skills'
import type { Candidate, ContextItem, Skill } from '@/core/types'
import * as wsStore from './workspace'
import { applyApi } from './editor'

/** AI 层状态：只有在设置了 API 之后才会被使用（未配置时 UI 层不渲染任何 AI 入口） */
export const aiState = reactive({
  skills: [] as Skill[],
  selectedSkill: '' as string,
  items: [] as ContextItem[],
  buildOpts: { ...DEFAULT_BUILD } as BuildOptions,
  candidates: [] as Candidate[],
  generating: false,
  streaming: '' as string,
  error: '' as string,
  batch: { running: false, done: 0, total: 0, logs: [] as string[], cancel: false }
})

export const enabled = computed(() => aiEnabled())

export const contextStat = computed(() => contextTotal(aiState.items))

let abort: AbortController | null = null

export async function loadSkills() {
  aiState.skills = await skillsApi.mergeSkills(wsStore.state.ref)
}

export function findSkill(name: string): Skill | undefined {
  return aiState.skills.find((s) => s.name === name)
}

export function skillPrompt(skillName: string): string {
  if (!skillName) return ''
  const s = findSkill(skillName)
  if (!s) return ''
  return `# 正在使用的技能：${s.name}\n\n${s.content}`
}

/* ------------------------------------------------------------------ 上下文装配 */

export async function buildContext(chapterId?: string) {
  const id = chapterId || wsStore.state.currentId
  const st = wsStore.state
  if (!st.ref || !id) return
  const chapter = wsStore.orderedChapters.value.find((c) => c.id === id)
  if (!chapter) return
  const vol = st.volumes.find((v) => v.id === chapter.volumeId) || null
  // 语义召回需要全文；当前章用编辑器里的实时内容
  const bodies = aiState.buildOpts.recallTop > 0 ? await wsStore.ensureBodies() : undefined
  if (bodies && st.currentId) bodies[st.currentId] = st.content
  aiState.items = await buildContextItems(
    st.ref,
    chapter,
    vol,
    wsStore.orderedChapters.value,
    st.assets,
    aiState.buildOpts,
    bodies
  )
}

export function toggleItem(id: string, on: boolean) {
  const it = aiState.items.find((x) => x.id === id)
  if (it) it.enabled = on
}

function cfg() {
  return { ...settings.ai, apiKey: settings.ai.apiKey }
}

const BASE_RULES = `你是一个中文网文写作台（墨栈）里的写作助手，服务于一位**有判断力的作者**。

铁律：
1. 你的产出是「候选文本」，不会被自动写入正文。作者不采纳，等于没写。
2. 只在被要求的范围内写。没有要求就不要发挥、不要解释、不要总结、不要夸奖。
3. 禁止输出任何客套话、说明、思考过程。只输出正文或指定格式的内容。
4. 上文「上下文」里的内容是事实来源。上下文没有的东西不要编造。
5. 中文写作。除非原文是别种语言，否则一律中文。`

export async function testConnect() {
  return await layer.testConnection(cfg())
}

export interface GenerateArgs {
  mode: Candidate['mode']
  skill?: string
  instruction?: string
  chapterId?: string
  selection?: string
  n?: number
  extra?: string
  /** 纠错用：没有选区时对整章做，采纳方式随之不同（见 Candidate.wholeChapter） */
  wholeChapter?: boolean
}

export async function generate(args: GenerateArgs): Promise<Candidate[]> {
  if (!enabled.value) {
    aiState.error = '尚未配置 API，AI 层不可用'
    return []
  }
  await buildContext(args.chapterId)
  aiState.error = ''
  aiState.generating = true
  const n = Math.max(1, Math.min(4, args.n || 1))
  const instruction = buildInstruction(args)
  const context = renderContext(aiState.items, instruction)
  const system = [BASE_RULES, skillPrompt(args.skill || '')].filter(Boolean).join('\n\n')
  abort = new AbortController()
  const out: Candidate[] = []
  try {
    for (let i = 0; i < n; i++) {
      aiState.streaming = ''
      const text = await layer.chat({
        cfg: cfg(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: n > 1 ? `${context}\n\n（这是第 ${i + 1} 个候选，请给出与前几个不同的处理）` : context }
        ],
        onDelta: (d) => {
          aiState.streaming += d
        },
        signal: abort.signal
      })
      // 纠错模式约定模型在正文后面追加「=== 改动说明 ===」清单。
      // 必须在这里拆开：c.text 只留正文，说明进 c.notes ——
      // 不然「采纳」会把说明文字一起写进正文，作者还得手动删。
      let body = text.trim()
      let notes = ''
      if (args.mode === 'fix') {
        const MARK = '=== 改动说明 ==='
        const at = body.indexOf(MARK)
        if (at >= 0) {
          notes = body.slice(at + MARK.length).trim()
          body = body.slice(0, at).trim()
        }
      }
      const c: Candidate = {
        id: uid('cand'),
        title: `${labelOf(args.mode)}${n > 1 ? ` · 候选${i + 1}` : ''}`,
        text: body,
        model: settings.ai.model,
        skill: args.skill || '',
        createdAt: fmtTime(new Date()),
        mode: args.mode,
        targetChapterId: args.chapterId || wsStore.state.currentId,
        tokens: Math.ceil(context.length / 2),
        notes: notes || undefined,
        wholeChapter: args.wholeChapter || undefined
      }
      aiState.candidates.unshift(c)
      out.push(c)
    }
    return out
  } catch (e: any) {
    aiState.error = layer.classifyError(e)
    return out
  } finally {
    aiState.streaming = ''
    aiState.generating = false
  }
}

export function cancelGenerate() {
  abort?.abort()
  aiState.generating = false
}

function labelOf(mode: Candidate['mode']): string {
  return {
    continue: '续写',
    rewrite: '局部重写',
    expand: '扩写',
    shrink: '缩写',
    tone: '改语气',
    summary: '章节摘要',
    outline: '大纲生成',
    generate: '生成',
    fix: '纠错'
  }[mode]
}

function buildInstruction(args: GenerateArgs): string {
  const ch = wsStore.currentChapter.value
  const head = `你要为一个Markdown文本文件写内容。
当前章节：${ch?.title || ''}（状态：${ch?.status || ''}）
${ch?.meta.target ? `本章目标：${ch.meta.target}` : ''}
${ch?.meta.emotion ? `情绪走向：${ch.meta.emotion}` : ''}`
  const tail: Record<string, string> = {
    continue: `任务：为《${ch?.title || ''}》继续写正文的一段或几段，从上一章结尾的状态自然接续。
要求：800–1500 字；不要重复上下文里已经写过的内容；不要写章节标题；按 Markdown 段落输出。`,
    rewrite: `任务：重写下面这段文字，保持原意与信息，换一种更好的写法。
待重写原文：\n"""\n${args.selection || ''}\n"""`,
    expand: `任务：扩写下面这段文字，补充合理的动作、细节与对话，不要改变原有信息。
待扩写原文：\n"""\n${args.selection || ''}\n"""`,
    shrink: `任务：缩写下面这段文字，保留关键信息，砍掉冗余描写。
待缩写原文：\n"""\n${args.selection || ''}\n"""`,
    tone: `任务：改写下面这段文字的语气与节奏，使其更贴近作者文风，信息不变。
待改写原文：\n"""\n${args.selection || ''}\n"""`,
    generate: `任务：根据「补充要求」与上下文里的设定，从零写一段新的正文（一个场景、一段情节或一个开头）。
这不是续写：不要接着本章现有结尾往下写，也不要复述上下文里已有的情节。
按 Markdown 段落输出，不要写章节标题。`,
    fix: `任务：校对下面这段文字。只修错别字、用词不当、标点错误和明显的语病；
不改文风、不增删情节、不改人名与设定。
输出格式（严格遵守）：
1. 先输出修改后的全文；
2. 然后单独一行输出 === 改动说明 ===
3. 之后每行一条，格式：原文 → 改为（一句话理由）。
一处都没改就只输出原文，不要输出改动说明。
待校对原文：\n"""\n${args.selection || ''}\n"""`,
    summary: `任务：为当前章节生成 100–200 字的摘要（事实优先，含谁在场、发生了什么、结尾留了什么悬念）。不要抒情，不要评价。`,
    outline: `任务：根据上下文与题目要求，产出分章大纲（章标题 + 每章功能 + 本章目标 + 出场人物 + 涉及设定 + 情绪走向 + 钩子）。`
  }
  return `${head}\n\n${tail[args.mode] || ''}${args.instruction ? `\n\n补充要求：${args.instruction}` : ''}\n\n以下是上下文：`
}

/* ------------------------------------------------------------------ 采纳 */

export async function adoptSummary(c: Candidate, key: string) {
  if (!wsStore.state.ref) return
  const raw = await readMemoryFile(wsStore.state.ref, '逐章摘要.md')
  await writeMemoryFile(wsStore.state.ref, '逐章摘要.md', updateMemorySection(raw, key, c.text))
  c.applied = true
}

/**
 * 把候选追加到当前章末尾。
 *
 * **必须走编辑器的 applyApi，不能直接改 store。**
 * 正文真正显示的是编辑器里的那份文档（ProseMirror），`state.content` 只是它的镜像；
 * 直接 `markDirty` 只会改镜像 —— 症状就是「字数涨了、正文一个字没变」，
 * 而且因为字数、今日字数都读 store，看起来还像「写成功了」，最难查。
 *
 * 编辑器没挂载（人在看板 / 关系图，右侧面板还开着）时才退回改 store：
 * 那种情况下切回写作视图，编辑器会按 `state.content` 重新初始化，正好读到这段。
 */
export async function appendToChapter(c: Candidate): Promise<boolean> {
  const st = wsStore.state
  if (!st.currentId) return false
  const text = c.text.trim()
  if (!text) return false
  const api = applyApi.value
  if (api) {
    api.append(text)
  } else {
    const next = st.content.replace(/\s*$/, '') + '\n\n' + text + '\n'
    wsStore.markDirty(next)
    await wsStore.saveNow()
  }
  c.applied = true
  return true
}

/* ------------------------------------------------------------------ 记忆整理（批量） */

export async function summarizeChapter(chapterId: string, skillName?: string): Promise<Candidate | null> {
  if (!enabled.value || !wsStore.state.ref) return null
  const st = wsStore.state
  const ch = wsStore.orderedChapters.value.find((x) => x.id === chapterId)
  if (!ch) return null
  const body = await readChapterBody(st.ref!, chapterId)
  if (!body.trim()) return null
  const system = [BASE_RULES, skillPrompt(skillName || '记忆整理')].filter(Boolean).join('\n\n')
  const user = `请为下面这一章做记忆整理，输出顺序严格遵守技能里的「输出顺序」。
章节：${ch.title}

"""\n${body.slice(0, 20000)}\n"""`
  aiState.generating = true
  aiState.error = ''
  try {
    const text = await layer.chat({ cfg: cfg(), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    const c: Candidate = {
      id: uid('memo'),
      title: `摘要 · ${ch.title}`,
      text: text.trim(),
      model: settings.ai.model,
      skill: skillName || '记忆整理',
      createdAt: fmtTime(new Date()),
      mode: 'summary',
      targetChapterId: chapterId,
      tokens: Math.ceil(body.length / 2)
    }
    aiState.candidates.unshift(c)
    return c
  } catch (e: any) {
    aiState.error = layer.classifyError(e)
    return null
  } finally {
    aiState.generating = false
  }
}

export async function batchSummarize(ids: string[], skillName?: string) {
  aiState.batch.running = true
  aiState.batch.cancel = false
  aiState.batch.done = 0
  aiState.batch.total = ids.length
  aiState.batch.logs = []
  let memoryRaw = await readMemoryFile(wsStore.state.ref!, '逐章摘要.md')
  for (const id of ids) {
    if (aiState.batch.cancel) break
    const c = await summarizeChapter(id, skillName)
    if (c) {
      const ch = wsStore.orderedChapters.value.find((x) => x.id === id)
      memoryRaw = updateMemorySection(memoryRaw, ch?.title || id, c.text)
      await writeMemoryFile(wsStore.state.ref!, '逐章摘要.md', memoryRaw)
      aiState.batch.logs.unshift(`${fmtTime(new Date())} 已写入：${ch?.title || id}`)
    } else {
      aiState.batch.logs.unshift(`${fmtTime(new Date())} 跳过（无正文或出错）：${id}`)
    }
    aiState.batch.done++
  }
  aiState.batch.running = false
}
