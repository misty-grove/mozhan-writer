<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  allChapters,
  duplicate,
  newChapter,
  newVolume,
  removeChapter,
  removeVolume,
  reorder,
  renameChapter,
  renameVolume,
  selectChapter,
  setStatus,
  state,
  totalWords
} from '@/stores/workspace'
import { moveChapter } from '@/stores/workspace'
import { STATUS_LIST, type Chapter, type ChapterStatus } from '@/core/types'
import { filterTree, flattenTree, highlightParts, matchChapter, type ChapterMatch } from '@/core/filter'
import { editorState } from '@/stores/editor'
import { askConfirm, askText } from '@/stores/dialog'
import { chapterPlaceholder } from '@/core/dialog'
import { parseOrder } from '@/core/workspace'

const collapsed = ref<Record<string, boolean>>({})
const editingId = ref('')
const editingName = ref('')
const dragging = ref<string | null>(null)
const dragOver = ref<string | null>(null)
const filterBox = ref<HTMLInputElement | null>(null)
const treeBody = ref<HTMLElement | null>(null)

const pct = computed(() => (state.info.targetWords ? Math.min(100, Math.round((totalWords.value / state.info.targetWords) * 100)) : 0))

/** 新章会排到的章号：跟 core 的 createChapter 用同一个 parseOrder，别两边各算一套 */
function nextOrder(volumeId: string | null): number {
  const list = volumeId ? state.volumes.find((v) => v.id === volumeId)?.chapters || [] : state.rootChapters
  const max = list.reduce((m, c) => Math.max(m, parseOrder(c.file || '')), 0)
  return max + 1
}

/* ------------------------------------------------ 筛选（P3-D） */
const tree = computed(() => filterTree(state.volumes, state.rootChapters, editorState.treeFilter))
const filtering = computed(() => tree.value.active)

/** 命中详情按 id 先算一次：模板里每个标题要拿它做高亮 + 悬浮提示，逐次现算会重复做几遍 */
const matchMap = computed(() => {
  const m = new Map<string, ChapterMatch>()
  if (!tree.value.active) return m
  const all = [...tree.value.root, ...tree.value.volumes.flatMap((v) => v.chapters)]
  for (const c of all) m.set(c.id, matchChapter(c, tree.value.query))
  return m
})

function rangesOf(ch: Chapter): Array<[number, number]> {
  return matchMap.value.get(ch.id)?.ranges || []
}
function reasonsOf(ch: Chapter): string {
  return matchMap.value.get(ch.id)?.reasons.join(' · ') || ''
}
/** 卷名命中关键词时给出高亮区间 */
function volumeRanges(name: string): Array<[number, number]> {
  const q = tree.value.query.text
  if (!filtering.value || !q) return []
  const i = name.toLowerCase().indexOf(q.toLowerCase())
  return i < 0 ? [] : [[i, i + q.length]]
}

function focusFilter() {
  nextTick(() => filterBox.value?.focus())
}
/** 筛选框里按 ↓ 直接钻进章节列表，手不用离开键盘 */
function focusTree() {
  nextTick(() => treeBody.value?.focus())
}
defineExpose({ focusFilter, focusTree })

/* ------------------------------------------------ 键盘导航（P3-E） */
/**
 * 目录是一棵树，但键盘移动走的是「摊平后的可见行」—— 折叠起来的卷，
 * 它下面的章不该被方向键走到，否则光标会跳到看不见的地方。
 * 索引空间由 core/filter.ts 的 flattenTree 算，跟模板渲染用的是同一份过滤结果。
 */
const flat = computed(() => flattenTree(tree.value, collapsed.value))
const cursor = ref(-1)
const cursorKey = computed(() => flat.value[cursor.value]?.key || '')

function setCursorKey(key: string) {
  const i = flat.value.findIndex((r) => r.key === key)
  if (i >= 0) cursor.value = i
}

function revealCursor() {
  nextTick(() => {
    const row = flat.value[cursor.value]
    if (!row || !treeBody.value) return
    // 不用 CSS.escape 拼选择器：章 id 里有 `/` 和中文，逐个比 dataset 更稳
    const rows = Array.from(treeBody.value.querySelectorAll<HTMLElement>('[data-key]'))
    rows.find((r) => r.dataset.key === row.key)?.scrollIntoView({ block: 'nearest' })
  })
}

/** 列表拿到焦点时，光标落到当前正在写的那一章上 */
function onTreeFocus() {
  if (cursor.value >= 0 && flat.value[cursor.value]) return
  setCursorKey(state.currentId)
}

async function openChapter(ch: Chapter) {
  setCursorKey(ch.id)
  await selectChapter(ch.id)
}

function onTreeKey(e: KeyboardEvent) {
  if (editingId.value) return // 正在改标题，方向键归输入框
  const k = e.key
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault()
    const n = flat.value.length
    if (!n) return
    const base = cursor.value < 0 ? (k === 'ArrowDown' ? -1 : n) : cursor.value
    cursor.value = Math.max(0, Math.min(n - 1, base + (k === 'ArrowDown' ? 1 : -1)))
    revealCursor()
    return
  }
  if (k === 'Home' || k === 'End') {
    e.preventDefault()
    if (!flat.value.length) return
    cursor.value = k === 'Home' ? 0 : flat.value.length - 1
    revealCursor()
    return
  }
  if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const row = flat.value[cursor.value]
    if (!row || row.kind !== 'volume' || !row.volumeId) return
    e.preventDefault()
    collapsed.value[row.volumeId] = k === 'ArrowLeft'
    return
  }
  if (k === 'Enter' || k === ' ') {
    const row = flat.value[cursor.value]
    if (!row) return
    e.preventDefault()
    if (row.kind === 'chapter') void openChapter(allChapters.value.find((c) => c.id === row.key)!)
    else if (row.volumeId) toggle(row.volumeId)
    return
  }
  if (k === 'F2') {
    const row = flat.value[cursor.value]
    const ch = row && row.kind === 'chapter' ? allChapters.value.find((c) => c.id === row.key) : null
    if (!ch) return
    e.preventDefault()
    startRename(ch)
  }
}

// 筛选条件一变，摊平结果就换了，旧光标指向的行可能已经不在；交给「聚焦时对齐当前章」兜底
watch(
  () => editorState.treeFilter,
  () => (cursor.value = -1)
)

function toggle(id: string) {
  collapsed.value[id] = !collapsed.value[id]
}

async function addChapter(volumeId: string | null) {
  const t = await askText({
    title: '新建章节',
    label: volumeId ? `加到「${state.volumes.find((v) => v.id === volumeId)?.name || '本卷'}」` : '加到「未分卷」',
    placeholder: chapterPlaceholder(nextOrder(volumeId)),
    hint: '章号按本卷现有的最后一章自动往下排',
    maxLength: 60
  })
  if (t === null) return
  await newChapter(volumeId, t.trim())
}

async function addVolume() {
  const t = await askText({
    title: '新建卷',
    label: '卷名',
    value: `第${state.volumes.length + 1}卷`,
    maxLength: 40
  })
  if (t === null) return
  await newVolume(t.trim())
}

function startRename(ch: Chapter) {
  editingId.value = ch.id
  editingName.value = ch.title
  focusRename()
}
async function commitRename(ch: Chapter) {
  const v = editingName.value.trim()
  editingId.value = ''
  if (!v || v === ch.title) return
  await renameChapter(ch.id, v)
}

function startVolumeRename(volumeId: string, name: string) {
  editingId.value = 'v:' + volumeId
  editingName.value = name
  focusRename()
}
async function commitVolumeRename(volumeId: string, oldName: string) {
  const v = editingName.value.trim()
  editingId.value = ''
  if (!v || v === oldName) return
  await renameVolume(volumeId, v)
}

/* ------------------------------------------------ 就地改名 */
/**
 * 改名框是 v-if 现渲的，`autofocus` 属性对动态插入的元素并不生效 ——
 * 不显式聚焦的话，按 F2 之后光标还留在列表上，敲字没反应（像是「坏了」）。
 *
 * 这里用函数 ref 收集元素：改名框在 v-for 里，模板 ref 会收成数组，反而更绕。
 */
let renameBox: HTMLInputElement | null = null
function bindRename(el: unknown) {
  if (el) renameBox = el as HTMLInputElement
}

function focusRename() {
  nextTick(() => {
    renameBox?.focus()
    renameBox?.select()
  })
}

/** 回车确认：改完把焦点还给列表，好接着用方向键翻 */
async function confirmRename(ch: Chapter) {
  await commitRename(ch)
  nextTick(() => treeBody.value?.focus())
}
async function confirmVolumeRename(volumeId: string, oldName: string) {
  await commitVolumeRename(volumeId, oldName)
  nextTick(() => treeBody.value?.focus())
}

/** Esc 放弃改名：名字不写盘，焦点还给列表 */
function cancelRename() {
  editingId.value = ''
  nextTick(() => treeBody.value?.focus())
}

async function onDrop(targetId: string, volumeId: string | null) {
  const id = dragging.value
  dragging.value = null
  dragOver.value = null
  if (!id || id === targetId) return
  const list = (volumeId ? state.volumes.find((v) => v.id === volumeId)?.chapters || [] : state.rootChapters).map((c) => c.id)
  const from = list.indexOf(id)
  const to = list.indexOf(targetId)
  if (from < 0 || to < 0) {
    // 跨卷移动
    await moveChapter(id, volumeId, [id, ...list].filter((x, i, a) => a.indexOf(x) === i))
    return
  }
  list.splice(to, 0, ...list.splice(from, 1))
  await reorder(volumeId, list)
}

async function dropIntoVolume(volumeId: string | null) {
  const id = dragging.value
  dragging.value = null
  if (!id) return
  const list = state.volumes.find((v) => v.id === volumeId)?.chapters.map((c) => c.id) || []
  await moveChapter(id, volumeId, [...list, id])
}

async function changeStatus(ch: Chapter, status: ChapterStatus) {
  await setStatus(ch.id, status)
}

async function removeCh(ch: Chapter) {
  const ok = await askConfirm({
    title: `删除《${ch.title}》`,
    message: '这一章的正文文件会从磁盘上移除。',
    detail: [
      `${ch.file || ch.title}${ch.wordCount ? ` · ${ch.wordCount} 字` : ''}`,
      '已保存的快照不受影响，删完仍可在「快照」里找回'
    ],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  await removeChapter(ch.id)
}

async function removeVol(volumeId: string, name: string) {
  const vol = state.volumes.find((v) => v.id === volumeId)
  const ok = await askConfirm({
    title: `删除卷「${name}」`,
    message: '整卷目录（含它下面所有章节的正文文件）都会从磁盘上移除。',
    detail: [
      `共 ${vol?.chapters.length || 0} 章 · ${(vol?.wordCount || 0).toLocaleString()} 字`,
      '这个操作不可撤销（快照里仍留有各自的备份）'
    ],
    okText: '删除整卷',
    danger: true
  })
  if (!ok) return
  await removeVolume(volumeId)
}
</script>

<template>
  <div class="tree">
    <div class="tree-head">
      <div class="spread">
        <b class="bk">{{ state.info.title || '未命名作品' }}</b>
        <button class="btn-icon" title="新建卷" @click="addVolume">＋卷</button>
      </div>
      <div class="small dim">{{ totalWords.toLocaleString() }} 字 · {{ allChapters.length }} 章</div>
      <div v-if="state.info.targetWords" class="progress" :title="`目标 ${state.info.targetWords.toLocaleString()} 字`">
        <div class="bar" :style="{ width: pct + '%' }"></div>
      </div>
    </div>

    <!-- 筛选（P3-D）：长篇几百章时靠滚动找一章太慢；Ctrl+P 直接跳进来 -->
    <div class="filter-bar">
      <input
        ref="filterBox"
        v-model="editorState.treeFilter"
        class="filter-input"
        placeholder="筛选章节：标题 / #状态 / >3000"
        title="标题关键词、#草稿 这类状态、>3000 / <1000 这类字数条件，可叠加"
        @keydown.esc="editorState.treeFilter = ''"
        @keydown.down.prevent="focusTree"
      />
      <button v-if="editorState.treeFilter" class="btn-icon" title="清空筛选" @click="editorState.treeFilter = ''">×</button>
    </div>
    <div v-if="filtering" class="filter-info small dim">
      命中 {{ tree.hits }} / 共 {{ tree.total }} 章
      <template v-if="tree.query.status"> · 状态 {{ tree.query.status }}</template>
      <template v-if="tree.query.minWords !== null"> · &gt;{{ tree.query.minWords }} 字</template>
      <template v-if="tree.query.maxWords !== null"> · &lt;{{ tree.query.maxWords }} 字</template>
    </div>

    <div
      ref="treeBody"
      class="tree-body"
      role="listbox"
      aria-label="章节目录"
      tabindex="0"
      @keydown="onTreeKey"
      @focus="onTreeFocus"
    >
      <!-- 未分卷（筛选时若一条都没命中就整块收起） -->
      <div v-if="!filtering || tree.root.length" class="vol" @dragover.prevent @drop="dropIntoVolume(null)">
        <div class="spread vol-line" :class="{ cursor: cursorKey === 'v:' }" data-key="v:">
          <span class="dim small">未分卷</span>
          <button class="btn-icon" title="在「未分卷」里新建章节" @click="addChapter(null)">＋</button>
        </div>
        <div
          v-for="ch in tree.root"
          :key="ch.id"
          class="ch"
          :class="{ active: ch.id === state.currentId, over: dragOver === ch.id, cursor: cursorKey === ch.id }"
          :data-key="ch.id"
          role="option"
          :aria-selected="ch.id === state.currentId"
          draggable="true"
          @dragstart="dragging = ch.id"
          @dragover.prevent="dragOver = ch.id"
          @dragleave="dragOver = null"
          @drop="onDrop(ch.id, null)"
          @click="openChapter(ch)"
        >
          <template v-if="editingId === ch.id">
            <input
              v-model="editingName"
              :ref="bindRename"
              @blur="commitRename(ch)"
              @keydown.enter="confirmRename(ch)"
              @keydown.esc.stop="cancelRename()"
            />
          </template>
          <template v-else>
            <span class="ch-title" :title="reasonsOf(ch)" @dblclick.stop="startRename(ch)">
              <template v-for="(p, pi) in highlightParts(ch.title, rangesOf(ch))" :key="pi">
                <mark v-if="p.hit" class="hl">{{ p.text }}</mark>
                <template v-else>{{ p.text }}</template>
              </template>
            </span>
            <span class="meta small dim">{{ ch.wordCount }} 字</span>
            <span class="st" :class="'s-' + ch.status">{{ ch.status }}</span>
          </template>
        </div>
      </div>

      <!-- 卷 -->
      <div v-for="hit in tree.volumes" :key="hit.volume.id" class="vol">
        <div class="spread vol-line" :class="{ cursor: cursorKey === 'v:' + hit.volume.id }" :data-key="'v:' + hit.volume.id">
          <div class="row" @click="toggle(hit.volume.id)">
            <span class="caret">{{ !filtering && collapsed[hit.volume.id] ? '▸' : '▾' }}</span>
            <template v-if="editingId === 'v:' + hit.volume.id">
              <input
                v-model="editingName"
                :ref="bindRename"
                @blur="commitVolumeRename(hit.volume.id, hit.volume.name)"
                @keydown.enter="confirmVolumeRename(hit.volume.id, hit.volume.name)"
                @keydown.esc.stop="cancelRename()"
              />
            </template>
            <b v-else class="vname" @dblclick.stop="startVolumeRename(hit.volume.id, hit.volume.name)">
              <template v-for="(p, pi) in highlightParts(hit.volume.name, volumeRanges(hit.volume.name))" :key="pi">
                <mark v-if="p.hit" class="hl">{{ p.text }}</mark>
                <template v-else>{{ p.text }}</template>
              </template>
            </b>
          </div>
          <div class="row">
            <span class="small dim">{{ filtering ? hit.chapters.length + ' 章命中' : hit.volume.wordCount.toLocaleString() }}</span>
            <button class="btn-icon" @click="addChapter(hit.volume.id)">＋</button>
            <button class="btn-icon" @click="removeVol(hit.volume.id, hit.volume.name)">×</button>
          </div>
        </div>
        <div v-show="filtering || !collapsed[hit.volume.id]" @dragover.prevent @drop="dropIntoVolume(hit.volume.id)">
          <div
            v-for="ch in hit.chapters"
            :key="ch.id"
            class="ch"
            :class="{ active: ch.id === state.currentId, over: dragOver === ch.id, cursor: cursorKey === ch.id }"
            :data-key="ch.id"
            role="option"
            :aria-selected="ch.id === state.currentId"
            draggable="true"
            @dragstart="dragging = ch.id"
            @dragover.prevent="dragOver = ch.id"
            @dragleave="dragOver = null"
            @drop="onDrop(ch.id, hit.volume.id)"
            @click="openChapter(ch)"
          >
            <template v-if="editingId === ch.id">
              <input
                v-model="editingName"
                :ref="bindRename"
                @blur="commitRename(ch)"
                @keydown.enter="confirmRename(ch)"
                @keydown.esc.stop="cancelRename()"
              />
            </template>
            <template v-else>
              <span class="ch-title" :title="(ch.file || '') + (filtering ? ' · ' + reasonsOf(ch) : '')" @dblclick.stop="startRename(ch)">
                <template v-for="(p, pi) in highlightParts(ch.title, rangesOf(ch))" :key="pi">
                  <mark v-if="p.hit" class="hl">{{ p.text }}</mark>
                  <template v-else>{{ p.text }}</template>
                </template>
              </span>
              <span class="meta small dim">{{ ch.wordCount }} 字</span>
              <span class="st" :class="'s-' + ch.status">{{ ch.status }}</span>
              <span class="ops">
                <button class="btn-icon" title="复制章" @click.stop="duplicate(ch.id)">⧉</button>
                <button class="btn-icon" title="删除章" @click.stop="removeCh(ch)">×</button>
              </span>
            </template>
          </div>
        </div>
      </div>

      <p v-if="filtering && !tree.hits" class="dim small no-hit">没有符合条件的章节</p>
    </div>

    <div class="tree-foot small dim">
      双击标题可重命名 · 拖拽可排序或跨卷移动
      <br />
      列表内：↑↓ 移动 · Enter 打开 · F2 重命名 · ←→ 折叠展开 · Home/End 到头尾
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  border-right: 1px solid var(--line);
}
.tree-head {
  padding: 11px 12px 9px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bk {
  font-size: 13px;
  letter-spacing: 0.2px;
}
.progress {
  height: 4px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 5px;
}
.bar {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  /* 进度每秒都在动，给它一个缓动，别像开关一样跳 */
  transition: width 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.tree-body {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px 0 12px;
  outline: none;
}
/* 键盘光标：不能只靠背景色（当前章已经有底色了），用内描边区分开 */
.ch.cursor,
.vol-line.cursor {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  border-radius: 3px;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 0;
}
.filter-input {
  font-size: 12px;
  padding: 4px 9px;
}
.filter-input:focus {
  box-shadow: 0 0 0 3px var(--ring);
}
.filter-info {
  padding: 5px 12px 5px;
  border-bottom: 1px solid var(--line-soft);
}
.no-hit {
  padding: 22px 14px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
.hl {
  background: var(--mark);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.vol {
  margin-bottom: 6px;
}
.vol-line {
  padding: 6px 12px;
  cursor: pointer;
  transition: background-color 0.14s ease;
}
.vol-line:hover {
  background: var(--bg-hover);
}
.caret {
  width: 12px;
  display: inline-block;
  color: var(--text-dim);
  font-size: 11px;
}
.vname {
  font-size: 13px;
  font-weight: 600;
}
.ch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 28px;
  cursor: pointer;
  font-size: 13px;
  border-left: 2px solid transparent;
  transition: background-color 0.14s ease, border-color 0.14s ease;
}
.ch:hover {
  background: var(--bg-hover);
}
.ch.active {
  background: var(--accent-soft);
  border-left-color: var(--accent);
}
.ch.over {
  border-top: 1px dashed var(--accent);
}
.ch-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch .ops {
  display: none;
}
.ch:hover .ops {
  display: flex;
}
.st {
  font-size: 11px;
  line-height: 1.6;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--line);
  color: var(--text-dim);
  background: var(--bg-field);
  white-space: nowrap;
}
.s-草稿 {
  color: var(--accent);
  border-color: var(--line);
}
.s-已定稿 {
  color: var(--ok);
  border-color: var(--tag-ok-line);
  background: var(--tag-ok-bg);
}
.s-待修 {
  color: var(--warn);
  border-color: var(--tag-warn-line);
  background: var(--tag-warn-bg);
}
.tree-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--bg-panel);
}
</style>
