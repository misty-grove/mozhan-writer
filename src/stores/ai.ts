import { computed, reactive, ref } from 'vue'
import fs from '@/platform'
import { buildContextItems, contextTotal, DEFAULT_BUILD, renderContext, type BuildOptions } from '@/core/context'
import * as layer from '@/core/ai'
import { AgentStream } from '@/core/agent'
import { planDelivery, rememberLayoutSkill, layoutGuide } from '@/core/agentSkills'
import { agentAvailable, agentCancel, agentRun, agentSyncSkills } from '@/platform/aiBridge'
import { aiEnabled, agentPreferred, apiReady, settings } from '@/core/settings'
import { countWords, fmtTime, uid } from '@/core/util'
import { CN_PUNCT_RULE, normalizeDialogQuotes } from '@/core/quotes'
import { parseStyleNotes, writeStyleNotes } from '@/core/styleLearn'
import { readChapterBody } from '@/core/workspace'
import { updateMemorySection } from '@/core/memory'
import { readMemoryFile, writeMemoryFile } from '@/core/memory'
import * as skillsApi from '@/core/skills'
import { onWorkReset } from '@/core/hooks'
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
  batch: { running: false, done: 0, total: 0, logs: [] as string[], cancel: false },
  /**
   * Agent 运行时的「过程」列表（读了哪些文件、调了哪些工具）。
   * 这是 L2 与直连 API 最大的体验差别：作者能看见 AI 到底翻了什么，
   * 而不是等半分钟拿到一段不知从哪来的文本。
   */
  agentSteps: [] as Array<{ kind: string; label: string }>,
  /** 本次跑的是哪条路（UI 上标一下，出问题时作者能说清是哪个引擎） */
  engineUsed: '' as 'api' | 'agent' | ''
})

export const enabled = computed(() => aiEnabled())

export const contextStat = computed(() => contextTotal(aiState.items))

let abort: AbortController | null = null
/** 当前 Agent 运行的取消令牌 */
let agentToken = ''

/* ------------------------------------------------------------------ 候选区增删 */

/**
 * 删掉一张候选。
 *
 * 作者反馈过一件事：续写之后候选卡片**没有删除入口**，窗口一直挂在那儿，
 * 换了作品还在（`aiState` 是模块级的，`openWork` / `closeWork` 都不碰它）。
 * 所以删除和「换作品清空」必须一起补 —— 只补按钮，跨作品残留照样在。
 */
export function removeCandidate(id: string): boolean {
  const i = aiState.candidates.findIndex((c) => c.id === id)
  if (i < 0) return false
  aiState.candidates.splice(i, 1)
  return true
}

export function clearCandidates(): number {
  const n = aiState.candidates.length
  aiState.candidates = []
  return n
}

/**
 * 换作品 / 关作品时把 AI 层的**作品相关**状态清掉。
 *
 * 不清的两样：
 * - `skills` 里内置的那部分与作品无关，重开作品时会重新 merge，清掉只会闪一下；
 * - `buildOpts` 是作者的使用习惯，跨作品保留才顺手。
 *
 * 每一样都对应一个真实的串号症状：候选卡带着上一部的正文、上下文条目指向
 * 上一部的章节、批量摘要进度条停在一半、流式缓冲里还留着上一部的半句话。
 */
export function resetForWork() {
  abort?.abort()
  abort = null
  aiState.candidates = []
  aiState.items = []
  aiState.streaming = ''
  aiState.error = ''
  aiState.generating = false
  aiState.batch = { running: false, done: 0, total: 0, logs: [], cancel: false }
}

// 登记到 core 的钩子里：workspace 换作品时回调这里。
// 反过来 import 就是 stores/ai ↔ stores/workspace 成环，见 core/hooks.ts 的说明。
onWorkReset(resetForWork)

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

/**
 * 不进候选区的裸对话：只给「技能整理」这类**结果由应用解析、再经人工确认**
 * 的功能用。正文类生成必须走 `generate()`（产出要能预览、能删、能采纳）。
 *
 * 只支持直连 API：Agent 档的 DSH 会在任务里翻作品文件，对「整理技能名单」
 * 这种纯文本任务纯属浪费步数；作者用 agent 档时提示他切 both/api。
 */
export async function rawChat(system: string, user: string): Promise<string> {
  if (!apiReady()) {
    throw new Error('技能整理走直连 API —— 请在设置里配好 API，或把引擎切到 both。')
  }
  return await layer.chat({ cfg: cfg(), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
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
  /** 内部用：本次是谁产的（只影响候选标题上的标注） */
  engineTag?: 'api' | 'agent'
}

/* ------------------------------------------------------------------ Agent 引擎 */

/** 会话 id 按作品存：同一部书跨章复用，换作品换会话（不换会前后文互串） */
function sessionKey(): string {
  const ref = wsStore.state.ref
  return ref ? `${ref.name}::${ref.id}` : ''
}

export function agentSession(): string {
  const k = sessionKey()
  if (!k) return ''
  return settings.ai.agentSessions[k] || ''
}

function rememberSession(id: string) {
  const k = sessionKey()
  if (!k || !id) return
  settings.ai.agentSessions = { ...settings.ai.agentSessions, [k]: id }
}

export function agentConfigured(): boolean {
  return agentPreferred()
}

/**
 * 用 Agent 跑一次生成任务。
 *
 * 与 `generate()` 的关键差别：**上下文不在这里拼**。
 * Agent 自己会去读作品目录（大纲 / 设定 / 记忆），那正是它比「直连 API」强的地方 ——
 * 把上下文硬塞进提示词反而占了它的步数与窗口。所以这里只交任务书 + 技能 + 装配面板里
 * 作者**手动勾选**的那几项（作者勾了就是要它一定看到），其余留给 Agent 自己去找。
 *
 * 返回 null 表示「这条路走不通，该回落直连 API」（both 档才会用到）。
 */
export async function generateWithAgent(args: GenerateArgs): Promise<Candidate[] | null> {
  if (!agentPreferred()) return null
  const ref = wsStore.state.ref
  if (!ref) {
    aiState.error = '还没有打开作品 —— Agent 需要在作品目录里干活。'
    return []
  }
  if (!(await agentAvailable())) {
    if (settings.ai.engine === 'agent') {
      aiState.error = 'Agent 后端只在桌面端可用（浏览器与手机请改用直连 API）。'
      return []
    }
    return null // both：悄悄回落
  }

  await buildContext(args.chapterId)
  aiState.error = ''
  aiState.agentSteps = []
  aiState.streaming = ''
  aiState.engineUsed = 'agent'
  aiState.generating = true

  const instruction = buildInstruction(args)
  const context = renderContext(aiState.items, instruction)
  const task = [layoutGuide(), skillPrompt(args.skill || ''), instruction, context].filter(Boolean).join('\n\n---\n\n')

  const token = uid('agentrun')
  agentToken = token
  const stream = new AgentStream()
  const out: Candidate[] = []
  try {
    const id = await fsAdapterRoot()
    // 先把技能投递到 DSH 技能库 —— 否则它会拿自己那套 project-layout（认 spec/ stories/）
    // 去读作者的作品目录，把 大纲/ 正文/ 当成"不合规范"（本机实测）。
    await syncSkillsToAgent()
    const res = await agentRun(
      {
        task,
        cwd: id,
        sessionId: agentSession() || undefined,
        profile: settings.ai.agentProfile || 'headless',
        permission: settings.ai.agentPermission,
        cli: settings.ai.agentCli || undefined,
        timeoutSecs: settings.ai.agentTimeoutSecs
      },
      token,
      (line) => {
        const ev = stream.push(line)
        if (!ev) return
        if (ev.kind === 'text' && ev.text) aiState.streaming = stream.text
        if (ev.label) aiState.agentSteps = stream.steps.slice(-40)
      },
      (d) => {
        // stderr 一般是真错误（未登录 / profile 缺失）。留着给作者看，不弹窗打断。
        aiState.agentSteps = [...stream.steps.slice(-39), { kind: 'diag', label: `DSH：${d.slice(0, 160)}` }]
      }
    )
    if (res.sessionId) rememberSession(res.sessionId)
    const text = (res.finalText || stream.result()).trim()
    if (!text) {
      aiState.error = res.cancelled ? '已取消' : 'Agent 没有产出内容（看看「过程」里卡在哪一步）'
      return out
    }
      const c: Candidate = {
        id: uid('cand'),
        title: `${labelOf(args.mode)}${args.engineTag === 'agent' ? ' · Agent' : ''}`,
        // Agent 那一路同样会吐英文直引号（它底下还是同一个模型），兜底必须在两条路上都有
        text: normalizeDialogQuotes(text),
      model: `DSH ${settings.ai.agentProfile || 'headless'}`,
      skill: args.skill || '',
      createdAt: fmtTime(new Date()),
      mode: args.mode,
      targetChapterId: args.chapterId || wsStore.state.currentId,
      tokens: Math.ceil(text.length / 2)
    }
    aiState.candidates.unshift(c)
    out.push(c)
    return out
  } catch (e: any) {
    const msg = String(e?.message || e)
    // both 档：Agent 这条路失败就回落直连 API，别让作者两头空
    if (settings.ai.engine === 'both' && apiReady()) {
      aiState.engineUsed = ''
      aiState.generating = false
      return null
    }
    aiState.error = msg
    return out
  } finally {
    agentToken = ''
    aiState.streaming = ''
    aiState.generating = false
  }
}

/**
 * 把「本应用认识的技能」投递给 DSH。
 *
 * 不做这件事的后果是**实测过的**：DSH 会拿它自己的 `project-layout` 技能
 * （认 `spec/ stories/ memory/`）去理解作者的作品目录，把 `大纲/ 正文/` 标成
 * "不合规范"，还建议作者新建 `spec/` —— 而本应用的作品目录才是权威。
 *
 * 失败不阻断：技能没投递成功顶多是 Agent 少一点领域知识，任务照样能跑。
 * 所以这里吞掉异常，只把结果记进过程列表（作者能在「过程」里看见）。
 */
async function syncSkillsToAgent(): Promise<void> {
  try {
    // 技能目录可能还没加载（比如刚打开作品就直接续写）—— 先确保有一份
    if (!aiState.skills.length) await loadSkills()
    // 记住布局技能，好在任务提示词里点名（否则 DSH 要猜名字，白烧一轮往返）
    rememberLayoutSkill(aiState.skills)
    const plan = planDelivery(aiState.skills)
    if (!plan.files.size) return
    const files = [...plan.files.entries()].map(([name, content]) => ({ name, content }))
    await agentSyncSkills(files)
  } catch (e) {
    // 技能是加分项，不是必需项
    console.warn('[agent] 技能同步失败：', e)
  }
}

/** 作品目录的绝对路径（Agent 的 cwd） */
async function fsAdapterRoot(): Promise<string> {
  const ref = wsStore.state.ref!
  const anyFs = fs as any
  if (typeof anyFs.absPath === 'function') {
    const p = await anyFs.absPath(ref)
    if (p) return String(p)
  }
  // 拿到绝对路径是 Agent 模式的硬需求：没有它就没法给 cwd。
  // 桌面上 DirRef 里带的 id 本身就是路径（见 platform/tauriAdapter.ts）。
  const guess = String(ref.id || '')
  if (/^[A-Za-z]:[\\/]/.test(guess) || guess.startsWith('/')) return guess
  throw new Error('拿不到作品的绝对路径，Agent 无法启动（桌面端才支持 Agent）。')
}

export function cancelGenerate() {
  if (agentToken) {
    const t = agentToken
    agentToken = ''
    agentCancel(t).catch(() => {})
    aiState.generating = false
    return
  }
  abort?.abort()
  aiState.generating = false
}

export async function generate(args: GenerateArgs): Promise<Candidate[]> {
  if (!enabled.value) {
    aiState.error = '尚未配置 API，AI 层不可用'
    return []
  }
  // 引擎分叉：Agent 档直接走 DSH；both 档 Agent 失败会返回 null，这里接着往下走直连。
  if (agentPreferred()) {
    const viaAgent = await generateWithAgent(args)
    if (viaAgent !== null) return viaAgent
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
      let body = normalizeDialogQuotes(text.trim())
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
    fix: '纠错',
    setting: '设定生成',
    style: '文风要点'
  }[mode]
}

/** 产出正文（而不是表格/清单）的模式：这些要带中文标点规范 */
const PROSE_MODES = ['continue', 'generate', 'rewrite', 'expand', 'shrink', 'tone', 'fix']

function buildInstruction(args: GenerateArgs): string {
  const ch = wsStore.currentChapter.value
  // 「设定生成」不针对某一章：它是给整个作品补世界观的，硬套章节头会误导模型
  // （「当前章节：第3章」这种上下文会让它把设定写成剧情摘要）。
  if (args.mode === 'setting') {
    return `${args.instruction || ''}\n\n以下是本作品已有的上下文（只作参考，不要复述）：`
  }
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
  // 正文类任务都带上中文标点规范：模型写中文对话爱吐英文直引号，
  // 光靠「中文小说」这几个字压不住，得把规则写出来（结果侧还有一层兜底，见 normalizeDialogQuotes）。
  const rule = PROSE_MODES.includes(args.mode) ? `\n\n${CN_PUNCT_RULE}` : ''
  return `${head}\n\n${tail[args.mode] || ''}${args.instruction ? `\n\n补充要求：${args.instruction}` : ''}${rule}\n\n以下是上下文：`
}

/* ------------------------------------------------------------------ 采纳 */

/**
 * 文风学习的结果：不是正文，落点是 记忆/文风要点.md。
 * **仍然先进候选区** —— AI 产出一律先给作者看，作者点了采纳才落盘，这条没有例外。
 */
export function pushStyleNotesCandidate(text: string, model = ''): Candidate {
  const c: Candidate = {
    id: uid('cand'),
    title: '文风要点（AI 从样本里归纳）',
    text: normalizeDialogQuotes(text),
    model: model || settings.ai.model || 'AI',
    skill: '',
    createdAt: fmtTime(new Date()),
    mode: 'style',
    targetChapterId: wsStore.state.currentId,
    tokens: Math.ceil(text.length / 2)
  }
  aiState.candidates.unshift(c)
  return c
}

/** 采纳文风要点：写进 记忆/文风要点.md（之后每次装配上下文都会带上） */
export async function adoptStyleNotes(c: Candidate): Promise<boolean> {
  if (!wsStore.state.ref) return false
  const notes = parseStyleNotes(c.text)
  if (!notes) return false
  await writeStyleNotes(wsStore.state.ref, notes)
  c.applied = true
  return true
}

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
