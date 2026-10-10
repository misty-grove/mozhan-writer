<script setup lang="ts">
/**
 * 参考资料窗（P2-24 分屏对照 / P2-27 钉住浮窗）
 *
 * 两种形态：
 *  - 内嵌（dock）：贴在编辑器右侧，和正文并排看
 *  - 钉住（pin）：浮动小窗，切到看板 / 关系图 / 时间线时依然在，可拖动
 * 内容一律只读 —— 参考资料不该在对照的时候被误改。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { listSources, readSource, type RefGroup } from '@/core/reference'
import { highlightRefs } from '@/core/links'
import { ensureCodex, codexState } from '@/stores/codex'
import { orderedChapters, selectChapter, state } from '@/stores/workspace'
import { applyApi, editorState } from '@/stores/editor'

const props = defineProps<{ mode: 'dock' | 'pin' }>()

const groups = ref<RefGroup[]>([])
const text = ref('')
const query = ref('')
const loading = ref(false)
const dragging = ref(false)

const flat = computed(() => groups.value.flatMap((g) => g.sources))
const current = computed(() => flat.value.find((s) => s.id === editorState.refSourceId) || null)

const html = computed(() => {
  let t = text.value
  if (query.value.trim()) {
    // 把命中的词标出来，方便在一大篇设定里找东西
    const q = query.value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(q, 'g'), (m) => `\u0001${m}\u0002`)
  }
  const rendered = highlightRefs(t)
    .replace(/\u0001/g, '<mark>')
    .replace(/\u0002/g, '</mark>')
    .split(/\n{2,}/)
    .map((p) => (p.trim() ? `<p>${p.replace(/\n/g, '<br/>')}</p>` : ''))
    .join('')
  return rendered || '<p class="dim">（空）</p>'
})

async function reload() {
  if (!state.ref) return
  loading.value = true
  try {
    await ensureCodex()
    groups.value = await listSources(state.ref, codexState.entries, orderedChapters.value)
    if (!editorState.refSourceId && flat.value.length) editorState.refSourceId = flat.value[0].id
  } finally {
    loading.value = false
  }
}

async function loadText() {
  if (!state.ref || !editorState.refSourceId) {
    text.value = ''
    return
  }
  text.value = await readSource(state.ref, editorState.refSourceId, codexState.entries, orderedChapters.value)
}

onMounted(async () => {
  await reload()
  await loadText()
})
watch(() => state.ref, reload)
watch(() => editorState.refSourceId, loadText)
// 正文有改动时刷新（参考源可能是当前章）
watch(() => state.content, loadText)

function pick(id: string) {
  editorState.refSourceId = id
}

/** 把参考里选中的文字插进正文 */
function insertSelection() {
  const sel = window.getSelection()?.toString().trim()
  if (!sel) return
  applyApi.value?.append(sel)
}

function openAsChapter() {
  const c = current.value
  if (!c || c.kind !== 'chapter') return
  selectChapter(c.id.replace(/^chapter:/, ''))
}

/* 钉住窗的拖动 */
function startDrag(e: MouseEvent) {
  if (props.mode !== 'pin') return
  dragging.value = true
  const start = { x: e.clientX, y: e.clientY }
  const origin = { ...editorState.refPos }
  const move = (ev: MouseEvent) => {
    if (!dragging.value) return
    editorState.refPos = {
      x: Math.max(0, Math.min(window.innerWidth - 200, origin.x + ev.clientX - start.x)),
      y: Math.max(0, Math.min(window.innerHeight - 80, origin.y + ev.clientY - start.y))
    }
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <div class="ref" :class="mode">
    <div class="rhead" @mousedown="startDrag">
      <b class="small">参考</b>
      <span v-if="current" class="dim small nowrap">{{ current.label }}</span>
      <span class="grow"></span>
      <button class="text small" :title="mode === 'dock' ? '钉成浮动窗' : '收进侧栏'" @click="editorState.refPinned = !editorState.refPinned">
        {{ mode === 'dock' ? '钉住' : '收回' }}
      </button>
      <button class="text small" @click="editorState.refOpen = false">×</button>
    </div>

    <div class="rtools row">
      <select v-model="editorState.refSourceId">
        <optgroup v-for="g in groups" :key="g.group" :label="g.group">
          <option v-for="s in g.sources" :key="s.id" :value="s.id">{{ s.label }}</option>
        </optgroup>
      </select>
      <input v-model="query" placeholder="在这篇里找" />
    </div>

    <div class="rbody" @dblclick="insertSelection">
      <div v-if="loading" class="dim small pad">读取中…</div>
      <div v-else class="rtext" v-html="html"></div>
    </div>

    <div class="rfoot small dim">
      <span>只读。双击选中内容可插入正文</span>
      <button v-if="current?.kind === 'chapter'" class="text small" @click="openAsChapter">打开这章</button>
    </div>
  </div>
</template>

<style scoped>
.ref {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--line);
}
.ref.dock {
  width: 300px;
  flex: 0 0 300px;
  height: 100%;
}
.ref.pin {
  position: fixed;
  width: 320px;
  height: 380px;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  box-shadow: var(--shadow-3);
  z-index: 40;
  background: var(--bg);
}
.rhead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  cursor: move;
}
.grow {
  flex: 1;
}
.rtools {
  padding: 6px 8px;
  gap: 6px;
  border-bottom: 1px solid var(--line-soft);
}
.rtools input {
  flex: 1;
}
.rbody {
  flex: 1;
  overflow: auto;
  padding: 10px 12px;
}
.rtext {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text);
  word-break: break-word;
}
.rtext :deep(p) {
  margin: 0 0 0.7em;
}
.rtext :deep(mark) {
  background: var(--mark);
  color: inherit;
}
.rtext :deep(.reflink) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dotted var(--accent);
  cursor: pointer;
}
.rfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-top: 1px solid var(--line-soft);
}
.pad {
  padding: 8px;
}
</style>
