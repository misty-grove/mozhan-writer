<script setup lang="ts">
/**
 * 伏笔台账面板（Task #3）
 * 读写「记忆/伏笔台账.md」里那张人能看懂的 Markdown 表格，外加超期预警。
 */
import { computed, ref, watch } from 'vue'
import { emptyRow, parseTable, serializeTable, warnings, type Foreshadow, type ForeshadowStatus } from '@/core/foreshadow'
import { readMemoryFile, writeMemoryFile } from '@/core/memory'
import { currentChapter, orderedChapters, state } from '@/stores/workspace'

const FILE = '伏笔台账.md'
const raw = ref('')
const rows = ref<Foreshadow[]>([])
const intro = ref('')
const filter = ref<'all' | ForeshadowStatus>('all')
const msg = ref('')
const busy = ref(false)

const LEVEL_TAG: Record<string, string> = {
  overdue: '伏笔超期',
  soondue: '即将到期',
  unplanted: '信息不全'
}

const currentIndex = computed(() => {
  const i = orderedChapters.value.findIndex((c) => c.id === state.currentId)
  return i >= 0 ? i + 1 : orderedChapters.value.length
})

const warns = computed(() => warnings(rows.value, currentIndex.value, orderedChapters.value.map((c) => c.title)))
const warnMap = computed(() => {
  const m = new Map<number, ReturnType<typeof warnings>[number]>()
  for (const w of warns.value) m.set(w.row.id, w)
  return m
})
const shown = computed(() => rows.value.filter((r) => filter.value === 'all' || r.status === filter.value))

function badge(level: string) {
  return level === 'overdue' ? 'warn' : 'info'
}

function warnMsg(id: number): string {
  return warnMap.value.get(id)?.message || ''
}

function takeIntro(text: string): string {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('|')) break
    if (line.trim().startsWith('#')) continue
    if (line.trim().startsWith('---')) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

watch([() => state.ref, currentChapter], load, { immediate: true })

async function load() {
  if (!state.ref) return
  raw.value = await readMemoryFile(state.ref, FILE)
  intro.value = takeIntro(raw.value)
  rows.value = parseTable(raw.value)
  msg.value = ''
}

async function save() {
  if (!state.ref) return
  busy.value = true
  try {
    await writeMemoryFile(state.ref, FILE, serializeTable('伏笔台账', intro.value, rows.value))
    msg.value = '已写入 记忆/伏笔台账.md'
  } catch (e: any) {
    msg.value = `保存失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

function add() {
  rows.value.push(emptyRow())
}

function remove(i: number) {
  rows.value.splice(i, 1)
}

function fillHere(r: Foreshadow) {
  const ch = currentChapter.value
  if (!ch) return
  if (!r.planted) r.planted = ch.title
  else r.planned = ch.title
}

function currentChapterLabel() {
  return currentChapter.value?.title || String(currentIndex.value)
}
</script>

<template>
  <div class="fs">
    <div class="spread">
      <b class="tt">伏笔台账</b>
      <select v-model="filter">
        <option value="all">全部</option>
        <option value="未回收">未回收</option>
        <option value="已回收">已回收</option>
        <option value="废弃">废弃</option>
      </select>
    </div>
    <p class="small dim">当前进度：{{ currentChapterLabel() }}（第 {{ currentIndex }} 章）</p>

    <div v-if="warns.length" class="warns">
      <div v-for="(w, i) in warns" :key="i" class="warn">
        <span class="tag" :class="badge(w.level)">{{ LEVEL_TAG[w.level] }}</span>
        <span class="small">{{ w.message }}</span>
      </div>
    </div>
    <p v-else class="small dim">没有超期伏笔。</p>

    <div class="rows">
      <div v-for="(r, i) in shown" :key="i" class="card" :class="{ bad: !!warnMsg(r.id) }">
        <div class="row">
          <input v-model="r.text" class="grow" placeholder="伏笔内容" />
          <button class="btn-icon" @click="remove(rows.indexOf(r))">×</button>
        </div>
        <div class="row">
          <input v-model="r.planted" placeholder="埋设章节" />
          <input v-model="r.planned" placeholder="计划回收" />
        </div>
        <div class="row">
          <select v-model="r.status">
            <option>未回收</option>
            <option>已回收</option>
            <option>废弃</option>
          </select>
          <select v-model="r.priority">
            <option>高</option>
            <option>中</option>
            <option>低</option>
          </select>
          <input v-model="r.note" placeholder="备注" />
        </div>
        <div class="row">
          <span v-if="warnMsg(r.id)" class="small warn-text">{{ warnMsg(r.id) }}</span>
          <button class="text small" @click="fillHere(r)">填入本章</button>
        </div>
      </div>
      <button class="text small" @click="add">+ 新增一条</button>
    </div>

    <div class="row">
      <button class="primary" :disabled="busy" @click="save">保存到 记忆/{{ FILE }}</button>
      <span class="small dim">表格本身仍是 Markdown</span>
    </div>
    <p v-if="msg" class="small dim">{{ msg }}</p>
  </div>
</template>

<style scoped>
.fs {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.warns {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.warn {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  border-left: 2px solid var(--line);
  padding-left: 6px;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow: auto;
}
.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.card.bad {
  border-color: var(--tag-warn-line);
  background: var(--bg-soft);
}
.grow {
  flex: 1;
}
.warn-text {
  color: var(--warn);
  flex: 1;
}
</style>
