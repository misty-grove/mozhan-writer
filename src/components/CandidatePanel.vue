<script setup lang="ts">
import { ref } from 'vue'
import fs from '@/platform'
import { aiState, adoptSummary, appendToChapter, enabled } from '@/stores/ai'
import { applyApi, editorState } from '@/stores/editor'
import { currentChapter, state } from '@/stores/workspace'
import { download } from '@/core/exportDoc'
import { countWords } from '@/core/util'
import { parseOutlineMarkdown, toOutlineMarkdown } from '@/core/outline'

const openId = ref('')
/** 纠错候选的「改动说明」当前展开的是哪一张 */
const openNotesId = ref('')
/** 采纳失败的原因。桌面壳与部分 WebView 会禁掉原生 alert，反馈只能落在自己身上 */
const notice = ref('')

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
 * 大纲候选的落点不是正文，是 大纲/大纲.md。
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
    await fs().writeFile(state.ref, ['大纲', '大纲.md'], toOutlineMarkdown(s, state.info.brief))
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
      <b class="tt">候选区（{{ aiState.candidates.length }}）</b>
      <span class="small dim">不点采纳，绝不写入正文</span>
    </div>

    <div v-if="!enabled" class="small dim">未配置 API，候选区为空。</div>
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
        <template v-else>
          <button class="primary" @click="adopt(c)">{{ adoptLabel(c) }}</button>
          <button @click="copyText(c)">复制</button>
        </template>
        <button class="text small" @click="openId = openId === c.id ? '' : c.id">{{ openId === c.id ? '收起' : '展开全文' }}</button>
      </div>
    </div>
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
</style>
