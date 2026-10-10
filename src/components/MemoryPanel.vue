<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { aiState, batchSummarize, enabled, summarizeChapter } from '@/stores/ai'
import { currentChapter, orderedChapters, saveNow, state } from '@/stores/workspace'
import { readMemoryFile, writeMemoryFile, writeGeneratedBlock, buildRollingSummary, buildStatusTable, buildTimeline } from '@/core/memory'
import { setDockTab } from '@/stores/editor'
import { loadSummaries } from '@/core/workspace'
import { askConfirm } from '@/stores/dialog'

const file = ref('逐章摘要.md')
const FILES = ['逐章摘要.md', '滚动总述.md', '状态表.md', '伏笔台账.md', '时间线.md']
const content = ref('')
const dirty = ref(false)
const selection = ref<string[]>([])

async function loadFile() {
  if (!state.ref) return
  content.value = await readMemoryFile(state.ref, file.value)
  dirty.value = false
}

watch([file, () => state.ref], loadFile, { immediate: true })

async function saveFile() {
  if (!state.ref) return
  await writeMemoryFile(state.ref, file.value, content.value)
  dirty.value = false
}

async function summaryCurrent() {
  if (!currentChapter.value) return
  await saveNow()
  await summarizeChapter(currentChapter.value.id)
  await loadFile()
  setDockTab('candidate')
}

async function runBatch() {
  const ids = selection.value.length ? selection.value : orderedChapters.value.map((c) => c.id)
  await batchSummarize(ids)
  await loadFile()
}

function toggleSel(id: string) {
  const i = selection.value.indexOf(id)
  if (i >= 0) selection.value.splice(i, 1)
  else selection.value.push(id)
}

const hasSummary = computed(() => !!currentChapter.value)

/* ------------------------------------------------ 离线自动整理（不花 token） */

async function writeBlock(fileName: string, tag: string, text: string) {
  const raw = await readMemoryFile(state.ref!, fileName)
  await writeMemoryFile(state.ref!, fileName, writeGeneratedBlock(raw, tag, text))
}

async function generate(status: 'rolling' | 'status' | 'timeline') {
  if (!state.ref) return
  if (
    dirty.value &&
    !(await askConfirm({
      title: '有未保存的改动',
      message: '重新生成会覆盖这个文件里当前的编辑内容。',
      detail: ['把你手写的部分先保存或复制出去，再继续'],
      okText: '覆盖重写',
      danger: true
    }))
  )
    return
  await saveNow()
  const { summaries } = await loadSummaries(state.ref)
  const chapters = orderedChapters.value
  if (status === 'rolling') {
    await writeBlock('滚动总述.md', 'rolling', buildRollingSummary(chapters, summaries))
    file.value = '滚动总述.md'
  } else if (status === 'status') {
    await writeBlock('状态表.md', 'status', buildStatusTable(chapters))
    file.value = '状态表.md'
  } else {
    await writeBlock('时间线.md', 'timeline', buildTimeline(chapters, summaries))
    file.value = '时间线.md'
  }
  await loadFile()
}
</script>

<template>
  <div class="mem">
    <div class="spread">
      <b class="tt">记忆库</b>
      <select v-model="file" style="width: 140px">
        <option v-for="f in FILES" :key="f" :value="f">{{ f.replace('.md', '') }}</option>
      </select>
    </div>

    <details>
      <summary class="small dim">离线自动整理（不花 token，写进「生成块」，不动手写内容）</summary>
      <div class="row" style="padding-top: 6px">
        <button class="text small" @click="generate('rolling')">滚动总述</button>
        <button class="text small" @click="generate('status')">同步状态表</button>
        <button class="text small" @click="generate('timeline')">抽取时间线</button>
      </div>
    </details>

    <div v-if="enabled" class="row">
      <button :disabled="!hasSummary || aiState.generating" @click="summaryCurrent">生成本章摘要</button>
      <button :disabled="aiState.batch.running" @click="runBatch">批量整理</button>
      <button v-if="aiState.batch.running" @click="aiState.batch.cancel = true">中断</button>
    </div>
    <p v-else class="small dim">记忆整理属于 AI 层：配置 API 后可用。记忆文件本身可直接手工编辑。</p>

    <details v-if="enabled">
      <summary class="small dim">选择要整理的章节（默认全部）</summary>
      <div class="pick">
        <label v-for="c in orderedChapters" :key="c.id" class="small">
          <input type="checkbox" style="width: auto" :checked="selection.includes(c.id)" @change="toggleSel(c.id)" />
          {{ c.title }}
        </label>
      </div>
    </details>

    <div v-if="aiState.batch.running || aiState.batch.logs.length" class="batch small">
      <div class="spread">
        <span>进度 {{ aiState.batch.done }}/{{ aiState.batch.total }}</span>
        <span class="progress-outer"><span class="progress-inner" :style="{ width: (aiState.batch.total ? (aiState.batch.done / aiState.batch.total) * 100 : 0) + '%' }"></span></span>
      </div>
      <div class="logs">
        <div v-for="(l, i) in aiState.batch.logs.slice(0, 40)" :key="i" class="dim">{{ l }}</div>
      </div>
    </div>

    <textarea v-model="content" class="doc small" spellcheck="false" @input="dirty = true"></textarea>
    <div class="row">
      <button class="primary" :disabled="!dirty" @click="saveFile">保存到 记忆/{{ file }}</button>
      <span class="small dim">纯 Markdown，随时可用记事本改</span>
    </div>
  </div>
</template>

<style scoped>
.mem {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.pick {
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
}
.pick label {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--text-soft);
}
.batch {
  border: 1px solid var(--line);
  padding: 6px 8px;
  border-radius: 4px;
}
.progress-outer {
  flex: 1;
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
  display: inline-block;
}
.progress-inner {
  display: block;
  height: 100%;
  background: var(--accent);
}
.logs {
  max-height: 120px;
  overflow: auto;
  margin-top: 6px;
  font-size: 11px;
}
.doc {
  min-height: 240px;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
}
</style>
