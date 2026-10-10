<script setup lang="ts">
/**
 * 时间线视图（P2-22）
 * 左：事件流（可跳章）；右：时序矛盾。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { buildTimeline, findConflicts, sortEvents, type TimelineEvent } from '@/core/timeline'
import { ensureCodex, codexState } from '@/stores/codex'
import { ensureBodies, orderedChapters, selectChapter, state } from '@/stores/workspace'
import { setView } from '@/stores/editor'

const loading = ref(false)
const bodies = ref<Record<string, string>>({})
const scope = ref<'all' | '设定' | '正文'>('all')
const actorFilter = ref('')

const raw = computed(() => buildTimeline(codexState.entries, orderedChapters.value, bodies.value))

const allActors = computed(() => [...new Set(raw.value.flatMap((e) => e.actors))].filter(Boolean).sort())

const events = computed(() => {
  let list = raw.value
  if (scope.value !== 'all') list = list.filter((e) => e.source === scope.value)
  if (actorFilter.value) list = list.filter((e) => e.actors.includes(actorFilter.value))
  return sortEvents(list)
})

const conflicts = computed(() => findConflicts(raw.value))

const unsorted = computed(() => events.value.filter((e) => e.rank === null).length)

async function reload() {
  if (!state.ref) return
  loading.value = true
  try {
    await ensureCodex()
    bodies.value = await ensureBodies()
  } finally {
    loading.value = false
  }
}

onMounted(reload)
watch(() => state.ref, reload)

function jump(e: TimelineEvent) {
  if (!e.chapterId) return
  selectChapter(e.chapterId)
  setView('write')
}

function label(e: TimelineEvent): string {
  return e.chapterNo ? `第 ${e.chapterNo} 章 · ${e.chapterTitle}` : e.chapterTitle
}
</script>

<template>
  <div class="tl">
    <div class="head">
      <b>时间线</b>
      <span class="dim small">事件来自 设定/时间线 与正文里的时间短语；认不出的时间排在最后，不瞎排</span>
      <span class="grow"></span>
      <button class="text small" @click="reload">刷新</button>
    </div>

    <div class="bar">
      <select v-model="scope">
        <option value="all">全部来源</option>
        <option value="设定">只看设定</option>
        <option value="正文">只看正文</option>
      </select>
      <select v-model="actorFilter">
        <option value="">全部实体</option>
        <option v-for="a in allActors" :key="a" :value="a">{{ a }}</option>
      </select>
      <span class="dim small">{{ events.length }} 个事件</span>
      <span v-if="unsorted" class="dim small">· {{ unsorted }} 个时间无法定位</span>
      <span v-if="conflicts.length" class="warn-text small">· {{ conflicts.length }} 处时序矛盾</span>
    </div>

    <div class="body">
      <div class="flow">
        <div v-if="loading" class="empty dim">正在读取…</div>
        <div v-else-if="!events.length" class="empty dim">
          还没抽出事件。可以在「设定」面板建一条「时间线」条目，按 `- 时间：事件` 写；正文里写「三年后」「第二天」这类短语也会被抓出来。
        </div>

        <div v-for="e in events" :key="e.id" class="ev" @click="jump(e)">
          <div class="dot" :class="{ dim: e.rank === null }"></div>
          <div class="card">
            <div class="spread">
              <b class="when">{{ e.when }}</b>
              <span class="tag" :class="e.source === '设定' ? 'info' : ''">{{ e.source }}</span>
            </div>
            <div class="small txt">{{ e.text }}</div>
            <div class="small dim">{{ label(e) }}<span v-if="e.actors.length"> · {{ e.actors.join('、') }}</span></div>
          </div>
        </div>
      </div>

      <aside class="side">
        <b class="small">时序矛盾（{{ conflicts.length }}）</b>
        <div v-if="!conflicts.length" class="small dim">没发现前后打架的时间。注意：只检查能认出时间标记的部分。</div>
        <div v-for="(c, i) in conflicts" :key="i" class="cf">
          <div class="small warn-text">{{ c.message }}</div>
          <div class="small dim">涉及：{{ c.actor }}</div>
          <button class="text small" @click="jump(c.b)">跳到第 {{ c.b.chapterNo }} 章</button>
        </div>

        <b class="small">时间线条目</b>
        <div class="small dim">
          设定库里「时间线」分类共 {{ codexState.entries.filter((e) => e.kind === 'timeline').length }} 条，
          它们写的「- 时间：事件」会直接进入这条时间线。
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.tl {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  font-size: 13px;
}
.grow {
  flex: 1;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.flow {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 12px 14px 24px;
}
.ev {
  display: flex;
  gap: 10px;
  position: relative;
  padding-bottom: 10px;
}
.ev::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 14px;
  bottom: 0;
  width: 1px;
  background: var(--line);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: 5px;
  flex: 0 0 9px;
  z-index: 1;
  box-shadow: 0 0 0 2px var(--bg);
}
.dot.dim {
  background: var(--line);
}
.card {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 10px;
  background: var(--bg-panel);
  cursor: pointer;
}
.card:hover {
  border-color: var(--accent);
}
.when {
  font-size: 13px;
}
.txt {
  color: var(--text-soft);
  margin: 2px 0;
  line-height: 1.6;
}
.tag {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.tag.info {
  border-color: var(--accent);
  color: var(--accent);
}
.side {
  width: 250px;
  flex: 0 0 250px;
  border-left: 1px solid var(--line);
  padding: 10px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.cf {
  border-left: 2px solid var(--warn);
  padding: 4px 0 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.warn-text {
  color: var(--warn);
}
.empty {
  margin: 24px auto;
  max-width: 460px;
  text-align: center;
  line-height: 1.8;
  font-size: 13px;
}
</style>
