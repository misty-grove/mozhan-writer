<script setup lang="ts">
/**
 * 看板视图（P2-25）：按状态分列，拖拽改状态 / 排序
 * 状态写在章节 front matter 里，拖一下就是改 md，作者用记事本也能改
 *
 * 手机上多一条路：**触摸设备根本不触发 HTML5 拖拽那套事件**（dragstart/dragover/drop），
 * 所以手机版不是「难看」，是改不了状态。改用卡片上的「移到…」展开一组状态按钮
 * （只在手机出现，见 global.css 里的 `html.ua-mobile .board .moves`）。
 */
import { computed, ref } from 'vue'
import { STATUS_LIST, type Chapter, type ChapterStatus } from '@/core/types'
import { orderedChapters, selectChapter, setStatus, state } from '@/stores/workspace'
import { setView } from '@/stores/editor'
import { mobileEnv } from '@/platform'

const dragging = ref<string | null>(null)
const overCol = ref<ChapterStatus | null>(null)
const notice = ref('')
/** 手机上展开了「移到…」的那张卡 */
const moving = ref<string | null>(null)

const columns = computed(() =>
  STATUS_LIST.map((s) => ({
    status: s,
    chapters: orderedChapters.value.filter((c) => c.status === s),
    words: orderedChapters.value.filter((c) => c.status === s).reduce((n, c) => n + c.wordCount, 0)
  }))
)

function volumeName(c: Chapter): string {
  if (!c.volumeId) return '未分卷'
  return state.volumes.find((v) => v.id === c.volumeId)?.name || '未分卷'
}

async function moveTo(c: Chapter, s: ChapterStatus) {
  moving.value = null
  if (c.status === s) return
  notice.value = ''
  try {
    await setStatus(c.id, s)
    notice.value = `《${c.title}》→ ${s}`
  } catch (err: any) {
    notice.value = `改状态失败：${err?.message || err}`
  }
}

function onDragStart(c: Chapter, e: DragEvent) {
  dragging.value = c.id
  e.dataTransfer?.setData('text/plain', c.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(status: ChapterStatus, e: DragEvent) {
  e.preventDefault()
  overCol.value = status
}

async function onDrop(status: ChapterStatus, e: DragEvent) {
  e.preventDefault()
  const id = e.dataTransfer?.getData('text/plain') || dragging.value
  dragging.value = null
  overCol.value = null
  if (!id) return
  const ch = orderedChapters.value.find((c) => c.id === id)
  if (!ch || ch.status === status) return
  notice.value = ''
  try {
    await setStatus(id, status)
    notice.value = `《${ch.title}》→ ${status}`
  } catch (err: any) {
    notice.value = `改状态失败：${err?.message || err}`
  }
}

function open(c: Chapter) {
  selectChapter(c.id)
  setView('write')
}
</script>

<template>
  <div class="board">
    <div class="head">
      <b>看板</b>
      <!-- 手机上 HTML5 拖放根本不触发，写「拖动卡片」等于给了个用不了的操作说明 -->
      <span class="dim small">{{
        mobileEnv
          ? '点卡片上的「移到…」改状态；状态写在章节 front matter 里，改的是 md 本身'
          : '拖动卡片改状态；状态写在章节 front matter 里，改的是 md 本身'
      }}</span>
      <span v-if="notice" class="small ok">{{ notice }}</span>
    </div>

    <div class="cols">
      <div
        v-for="col in columns"
        :key="col.status"
        class="col"
        :class="{ over: overCol === col.status }"
        @dragover="onDragOver(col.status, $event)"
        @dragleave="overCol = null"
        @drop="onDrop(col.status, $event)"
      >
        <div class="col-head">
          <b>{{ col.status }}</b>
          <span class="dim small">{{ col.chapters.length }} 章 · {{ col.words.toLocaleString() }} 字</span>
        </div>

        <div class="cards">
          <div
            v-for="c in col.chapters"
            :key="c.id"
            class="card"
            :class="{ sel: c.id === state.currentId, ghost: dragging === c.id }"
            :draggable="!mobileEnv"
            @dragstart="onDragStart(c, $event)"
            @dragend="dragging = null"
            @click="open(c)"
          >
            <div class="spread">
              <b class="t">{{ c.title }}</b>
              <span class="dim small">{{ c.wordCount.toLocaleString() }} 字</span>
            </div>
            <div class="dim small">{{ volumeName(c) }} · 第 {{ c.order + 1 }} 章</div>
            <div v-if="c.meta.target" class="small target">{{ c.meta.target }}</div>
            <div v-if="c.meta.characters?.length" class="small dim">出场：{{ c.meta.characters.join('、') }}</div>

            <!-- 手机上：拖拽用不了，改成点开一组状态按钮。桌面上这两个都不显示
                 （move-btn 带 data-mobile="only"，moves 只在手机样式里有布局）。 -->
            <div v-if="moving === c.id" class="moves">
              <button
                v-for="s in STATUS_LIST"
                :key="s"
                :disabled="s === c.status"
                @click.stop="moveTo(c, s)"
              >
                {{ s }}
              </button>
              <button class="text small" @click.stop="moving = null">取消</button>
            </div>
            <button v-else class="text move-btn" data-mobile="only" @click.stop="moving = c.id">移到…</button>
          </div>

          <div v-if="!col.chapters.length" class="empty small dim">拖到这里</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  /* 窗口窄了让说明文字和按钮各占一行，而不是把右边的按钮挤出可视区 */
  flex-wrap: wrap;
  row-gap: 4px;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  font-size: 13px;
}
.ok {
  color: var(--ok);
}
.cols {
  flex: 1;
  display: flex;
  gap: 10px;
  padding: 12px;
  overflow: auto;
}
.col {
  flex: 1 1 0;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.col.over {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.col-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.cards {
  flex: 1;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg);
  cursor: pointer;
  font-size: 12px;
}
.card:hover {
  border-color: var(--accent);
}
.card.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.04);
}
.card.ghost {
  opacity: 0.4;
}
.t {
  font-size: 13px;
}
.target {
  color: var(--text-soft);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty {
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 14px;
  text-align: center;
}
</style>
