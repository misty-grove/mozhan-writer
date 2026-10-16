<script setup lang="ts">
import { ref } from 'vue'
import fs from '@/platform'
import { aiState, adoptStyleNotes, adoptSummary, appendToChapter, clearCandidates, enabled, removeCandidate } from '@/stores/ai'
import { applyApi, editorState } from '@/stores/editor'
import { addChapterWithBody, currentChapter, state } from '@/stores/workspace'
import { askConfirm } from '@/stores/dialog'
import { download } from '@/core/exportDoc'
import { countWords } from '@/core/util'
import { parseOutlineMarkdown, toOutlineMarkdown } from '@/core/outline'
import { parseSettingSheet } from '@/core/worldbuild'
import { defaultBody } from '@/core/codex'
import { addEntry, codexState, refreshCodex } from '@/stores/codex'
import AiPromptDialog from './AiPromptDialog.vue'
import TranslateDialog from './TranslateDialog.vue'

const openId = ref('')
/** 从候选区直接下指令（生成 / 扩写都走同一个对话框） */
const showAi = ref(false)
/** 翻译入口也放一个：翻完回到候选区，作者正好在这里处理译文 */
const showTrans = ref(false)
/** 纠错候选的「改动说明」当前展开的是哪一张 */
const openNotesId = ref('')
/** 采纳失败的原因。桌面壳与部分 WebView 会禁掉原生 alert，反馈只能落在自己身上 */
const notice = ref('')

/**
 * 删一张候选。
 *
 * 已采纳的要多问一句：卡片上的「已采纳」是作者判断"这段要不要留在候选区"的唯一线索，
 * 误删之后没法撤销（候选只活在内存里，不落盘）。
 */
async function removeOne(c: any) {
  if (c.applied) {
    const okDel = await askConfirm({
      title: '删除这张候选',
      message: `「${c.title}」已经采纳过了。删掉只是把卡片从候选区移走，正文里已经写进去的内容一个字都不会动。`,
      okText: '删除',
      danger: true
    })
    if (!okDel) return
  }
  removeCandidate(c.id)
  if (openId.value === c.id) openId.value = ''
  if (openNotesId.value === c.id) openNotesId.value = ''
}

async function clearAll() {
  const n = aiState.candidates.length
  if (!n) return
  const unapplied = aiState.candidates.filter((c) => !c.applied).length
  const okDel = await askConfirm({
    title: `清空候选区（${n} 张）`,
    message: '候选区只是暂存处，删掉不会影响正文已经写进去的内容。',
    detail: [
      `共 ${n} 张候选卡`,
      unapplied ? `其中 ${unapplied} 张还没采纳 —— 删掉后就找不回来了` : '这些都已经采纳过了',
      '想留下内容的话，先「复制」或「存为 md」'
    ],
    okText: '清空',
    danger: true
  })
  if (!okDel) return
  clearCandidates()
  openId.value = ''
  openNotesId.value = ''
}

function applyLocal(c: any) {
  const api = applyApi.value
  if (!api) {
    notice.value = '编辑器还没准备好，稍等一下再试。'
    return
  }
  // replaceSelection 会在「正文里没选中任何文本」时返回 false。
  // 这时候**千万不能**标成已采纳 —— 作者看到标签变了、正文一个字没动，比报错还难查。
  if (!api.replaceSelection(c.text)) {
    notice.value = '正文里没有选中文本。想整段接到本章最后，请用「追加到本章末尾」。'
    return
  }
  notice.value = ''
  c.applied = true
}

/**
 * 整章替换：只用于「没选区就点了纠错」的那种候选（c.wholeChapter）。
 * 必须走 applyApi.setContent —— 那条路会同时改编辑器和镜像并落盘；
 * 直接改 state.content 就是「字数变了、屏幕没变」那个 bug 家族。
 */
function applyWholeChapter(c: any) {
  const api = applyApi.value
  if (!api) {
    notice.value = '编辑器还没准备好，稍等一下再试。'
    return
  }
  if (editorState.mode === 'source') {
    notice.value = '源码模式下替换不了整章，请切回所见即所得再采纳。'
    return
  }
  api.setContent(c.text)
  notice.value = ''
  c.applied = true
}

/**
 * 大纲候选的落点不是正文，是 大纲/剧情大纲.md（跟「导入大纲」同一个家）。
 * AI 输出必须能被解析成「## 卷 + | 章节 | 目标 |」表格才写 ——
 * 解析不了就如实说，并把原文留给作者复制，绝不把半成品盖掉人家的大纲文件。
 */
async function adoptOutline(c: any) {
  if (!state.ref) {
    notice.value = '当前没有打开的作品。'
    return
  }
  const s = parseOutlineMarkdown(c.text)
  if (!s.volumes.length) {
    notice.value = 'AI 输出的不是可解析的大纲表格（要有「## 某卷」和「| 章节 | 目标 |」表）。原文保留在候选里，可复制后手工整理。'
    return
  }
  try {
    await fs().writeFile(state.ref, ['大纲', '剧情大纲.md'], toOutlineMarkdown(s, state.info.brief))
  } catch (e: any) {
    notice.value = `写入大纲失败：${e?.message || e}`
    return
  }
  notice.value = ''
  c.applied = true
}

/** 采纳按钮的文案跟着模式走：作者不该猜「这个按钮会把字写到哪去」 */
function adoptLabel(c: any): string {
  if (c.mode === 'continue' || c.mode === 'generate') return '追加到本章末尾'
  if (c.mode === 'fix' && c.wholeChapter) return '替换整章正文'
  return '替换选中文本'
}

/**
 * 采纳「设定生成」：把 AI 给的设定表拆成一条条设定条目落盘。
 *
 * 三件必须做对的事：
 *  - **解析失败不落盘**：宁可让作者复制原文，也不能把半成品写成文件；
 *  - **重名不覆盖**：已经存在的设定条目跳过（作者手写的条目金贵）；
 *  - **如实报数**：写了几个、跳过几个，都告诉作者。
 */
async function adoptSetting(c: any) {
  if (!state.ref) {
    notice.value = '当前没有打开的作品。'
    return
  }
  const items = parseSettingSheet(c.text)
  if (!items.length) {
    notice.value = 'AI 输出的不是可解析的设定表格（要有「## 人物」这类小标题和 | 名称 | 描述 | 表）。原文保留在候选里，可复制后手工整理。'
    return
  }
  const existing = new Set(codexState.entries.map((e) => e.name))
  let written = 0
  let skipped = 0
  const failed: string[] = []
  for (const it of items) {
    if (existing.has(it.name)) {
      skipped++
      continue
    }
    try {
      await addEntry(it.kind, it.name, { body: settingBody(it) })
      existing.add(it.name)
      written++
    } catch (e: any) {
      failed.push(it.name)
    }
  }
  await refreshCodex()
  c.applied = true
  const bits = [`写入 ${written} 条设定`]
  if (skipped) bits.push(`跳过 ${skipped} 条同名（不覆盖已有）`)
  if (failed.length) bits.push(`${failed.length} 条失败：${failed.slice(0, 3).join('、')}`)
  notice.value = bits.join('；')
}

/** 把 AI 的描述放进条目正文（套用该类型的模板骨架，作者好继续补） */
function settingBody(it: { kind: any; name: string; desc: string }): string {
  const base = defaultBody(it.kind, it.name)
  // 模板是「# 名称\n\n## 小节…」，把描述插在标题下面，保留后面作者要填的小节
  const lines = base.split('\n')
  const head = lines.shift() || `# ${it.name}`
  return [head, '', it.desc, '', ...lines].join('\n')
}

async function adopt(c: any) {
  notice.value = ''
  if (c.mode === 'summary') {
    await adoptSummary(c, currentChapter.value?.title || '')
    return
  }
  if (editorState.mode === 'source') {
    notice.value = '源码模式下定位不到选区，请切回所见即所得再采纳。'
    return
  }
  if (c.mode === 'continue' || c.mode === 'generate') {
    if (!(await appendToChapter(c))) notice.value = '当前没有打开的章节，先选一章再采纳。'
    return
  }
  if (c.mode === 'fix' && c.wholeChapter) {
    applyWholeChapter(c)
    return
  }
  applyLocal(c)
}

/** 文风要点：落点是 记忆/文风要点.md，不是正文 —— 写进去之后每次生成都会带上 */
async function adoptStyle(c: any) {
  const ok = await adoptStyleNotes(c)
  notice.value = ok ? '' : '这份要点是空的，没能写入。'
}

/**
 * 译文落成新的一章。
 *
 * 刻意不给「替换本章」：翻译错了还能改，覆盖错了就找不回来了（正文只有一份，
 * 快照虽然能救但作者不一定记得去翻）。所以译文一律**另起一章**，
 * 章名带语言标记，原章原样留着。
 */
async function saveAsChapter(c: any) {
  if (!state.ref) {
    notice.value = '当前没有打开的作品。'
    return
  }
  if (!c.text?.trim()) {
    notice.value = '这份译文是空的。'
    return
  }
  const base = (c.title || '').replace(/ · .*译文$/, '').trim() || '译文'
  try {
    await addChapterWithBody(null, base, c.text)
    c.applied = true
    notice.value = ''
  } catch (e: any) {
    notice.value = `存为新章节失败：${e?.message || e}`
  }
}

function copyText(c: any) {
  navigator.clipboard?.writeText(c.text)
}

function saveFile(c: any) {
  download(new Blob([c.text], { type: 'text/plain;charset=utf-8' }), `${c.title}.md`)
}
</script>

<template>
  <div class="cand">
    <div class="spread">
      <b class="tt">候选区{{ aiState.candidates.length ? `（${aiState.candidates.length}）` : '' }}</b>
      <button
        v-if="aiState.candidates.length"
        class="text small"
        title="删除全部候选卡（不动正文）"
        @click="clearAll"
      >
        清空
      </button>
      <span v-else class="small dim">不点采纳，绝不写入正文</span>
    </div>

    <div v-if="!enabled" class="small dim">未配置 API，候选区为空。</div>

    <div v-else class="row">
      <button class="text small" title="打开大指令框：让 AI 生成或扩写某一段" @click="showAi = true">
        ＋ 让 AI 写 / 扩写…
      </button>
      <span class="small dim">会先说清「动哪一段」，再让你写要求</span>
    </div>
    <div class="row">
      <button class="text small" title="把正文翻译成 中文 / English / 日本語" @click="showTrans = true">
        翻译正文…
      </button>
      <span class="small dim">译文也进候选区，不动原文</span>
    </div>

    <!-- Agent 的「过程」：读了哪些文件、调到哪一步。这是 Agent 档与直连 API 最大的体验差别 —— 
         不显示的话，作者等两分钟只看到一段文本，完全不知道 AI 到底翻了什么。 -->
    <details v-if="aiState.agentSteps.length" class="steps" :open="aiState.generating">
      <summary class="small">
        <b>{{ aiState.generating ? 'Agent 运行中…' : 'Agent 过程' }}</b>
        <span class="dim">（{{ aiState.agentSteps.length }} 步）</span>
      </summary>
      <ol class="step-list small">
        <li v-for="(s, i) in aiState.agentSteps" :key="i" :class="'k-' + s.kind">{{ s.label }}</li>
      </ol>
    </details>
    <div v-if="aiState.generating && aiState.streaming" class="stream small">{{ aiState.streaming.slice(-500) }}</div>

    <div v-else-if="!aiState.candidates.length" class="small dim empty">
      还没有候选。去「上下文」面板生成，或在「记忆」面板做逐章摘要。
    </div>

    <!-- 采纳没成功要说出来，不能静默 -->
    <div v-if="notice" class="small warn-text notice">
      {{ notice }}
      <button class="btn-icon small" title="知道了" @click="notice = ''">×</button>
    </div>

    <div v-for="c in aiState.candidates" :key="c.id" class="card">
      <div class="spread">
        <div class="row">
          <b class="ct">{{ c.title }}</b>
          <span v-if="c.applied" class="tag ok small">已采纳</span>
        </div>
        <div class="row small dim">
          <span>{{ countWords(c.text) }} 字</span>
          <button class="btn-icon" title="复制" @click="copyText(c)">⧉</button>
          <button class="btn-icon" title="存为 md" @click="saveFile(c)">↓</button>
          <button class="btn-icon danger" title="删除这张候选（不动正文）" @click="removeOne(c)">✕</button>
        </div>
      </div>
      <div class="small dim meta">{{ c.model }} · {{ c.skill || '无技能' }} · {{ c.createdAt }}</div>
      <div class="preview small" :class="{ clipped: openId !== c.id }" @click="openId = c.id">
        {{ c.text }}
      </div>
      <!-- 纠错候选：改了什么单独放，不混进正文（采纳时写的只是上面的 c.text） -->
      <div v-if="c.notes" class="notes">
        <button class="text small" @click="openNotesId = openNotesId === c.id ? '' : c.id">
          {{ openNotesId === c.id ? '收起改动说明' : `改动说明（${c.notes.split('\n').length} 条）` }}
        </button>
        <pre v-if="openNotesId === c.id" class="notes-body small">{{ c.notes }}</pre>
      </div>
      <div class="row">
        <button v-if="c.mode === 'summary'" class="primary" @click="adopt(c)">写入记忆库</button>
        <button v-else-if="c.mode === 'outline'" class="primary" @click="adoptOutline(c)">写入大纲文件</button>
        <button v-else-if="c.mode === 'setting'" class="primary" @click="adoptSetting(c)">写入设定库</button>
        <button v-else-if="c.mode === 'style'" class="primary" @click="adoptStyle(c)">写入 记忆/文风要点.md</button>
        <button v-else-if="c.mode === 'translate'" class="primary" @click="saveAsChapter(c)">存为新章节</button>
        <template v-else>
          <button class="primary" @click="adopt(c)">{{ adoptLabel(c) }}</button>
          <button @click="copyText(c)">复制</button>
        </template>
        <button class="text small" @click="openId = openId === c.id ? '' : c.id">{{ openId === c.id ? '收起' : '展开全文' }}</button>
        <button class="text small danger-text" @click="removeOne(c)">删除</button>
      </div>
    </div>

    <AiPromptDialog v-if="showAi" @close="showAi = false" />
    <TranslateDialog v-if="showTrans" @close="showTrans = false" />
  </div>
</template>

<style scoped>
.cand {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tt {
  font-size: 13px;
}
.empty {
  line-height: 1.7;
}
.notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  border-radius: 6px;
  padding: 7px 9px;
  background: var(--tag-warn-bg);
  line-height: 1.6;
  animation: ui-pop-in 0.18s ease both;
}
.notice .btn-icon {
  flex: 0 0 auto;
}
/* Agent 过程：默认收起（作者多数时候只关心结果），跑的时候自动摊开 */
.steps {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-panel);
  padding: 7px 10px;
}
.steps summary {
  cursor: pointer;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.step-list {
  margin: 7px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 200px;
  overflow: auto;
  line-height: 1.6;
}
.step-list li {
  color: var(--text-dim);
}
/* 工具调用是「它真的动手了」的证据，给一点对比度；诊断信息用警示色 */
.step-list li.k-tool_call {
  color: var(--text);
}
.step-list li.k-error,
.step-list li.k-diag {
  color: var(--warn);
}
.stream {
  max-height: 150px;
  overflow: auto;
  white-space: pre-wrap;
  line-height: 1.7;
  color: var(--text-dim);
  border-left: 2px solid var(--line);
  padding-left: 8px;
}
/* 卡片皮肤（边框/圆角/阴影）吃 global 的 .card，这里只管排布和悬停反馈 */
.cand .card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
}
.card {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ct {
  font-size: 13px;
}
.meta {
  font-size: 11px;
}
.preview {
  white-space: pre-wrap;
  line-height: 1.7;
  font-family: var(--write-font, inherit);
  cursor: pointer;
  max-height: 340px;
  overflow: auto;
}
.preview.clipped {
  max-height: 132px;
  overflow: hidden;
  mask-image: linear-gradient(#000 60%, transparent);
}
.notes {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.notes-body {
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  background: var(--bg-panel);
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  line-height: 1.7;
}
/* 删除入口：图标态用警示色，文字态只染字，免得整排按钮都在抢注意力 */
.btn-icon.danger:hover {
  color: var(--err);
  border-color: var(--err);
}
.danger-text:hover {
  color: var(--err);
}
</style>
