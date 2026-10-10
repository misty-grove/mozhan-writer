<script setup lang="ts">
/**
 * 关系图视图（P2-21）
 * 图是「看」的，不是「算」的：节点可拖、可按类型筛、点开看它在哪些章出现过。
 */
import { computed, onMounted, reactive, ref, toRaw, watch } from 'vue'
import { KIND_LABEL } from '@/core/codex'
import type { SettingKind } from '@/core/types'
import { buildGraph, components, hubs, layout, type GraphEdge, type GraphNode } from '@/core/graph'
import { ensureCodex, codexState } from '@/stores/codex'
import { ensureBodies, orderedChapters, selectChapter, state } from '@/stores/workspace'
import { editorState, setDockTab, setView } from '@/stores/editor'
import { mobileEnv } from '@/platform'

const W = 900
const H = 620

/**
 * 画得动的上限，交给 buildGraph 去挑（显式链接优先，其余按强度）。
 *
 * SVG 是「一条线 = 一个 DOM 节点」。一部 300 章的作品，光是共现关系就能有
 * 四万多条 —— 全画出来浏览器会僵住好几秒（而且什么都没看清）。
 * 所以画布和布局都只吃最强的这些，剩下的**如实写在工具条上**，而不是假装画完了。
 */
const EDGE_BUDGET = 1200

const loading = ref(false)
const includeChapters = ref(false)
const cooccurMin = ref(2)
const kinds = ref<SettingKind[]>([])
const selected = ref<string | null>(null)
const dragId = ref<string | null>(null)
const bodies = ref<Record<string, string>>({})

const ALL_KINDS: SettingKind[] = ['character', 'location', 'item', 'organization', 'lore', 'timeline']

const graph = computed(() => {
  const visible = codexState.entries.filter((e) => !kinds.value.length || kinds.value.includes(e.kind))
  const g = buildGraph(visible, orderedChapters.value, bodies.value, {
    includeChapters: includeChapters.value,
    cooccurMin: cooccurMin.value,
    maxEdges: EDGE_BUDGET,
    kinds: []
  })
  // 节点必须包成响应式：拖动和「重排」只改 n.x / n.y 这两个数字。
  // 节点若是普通对象，Vue 收不到通知 —— 表现是「圆点拖着不动、点重排没反应」，
  // 要等碰巧有别的东西触发了重渲染才跳到新位置。
  g.nodes = g.nodes.map((n) => reactive(n))
  return g
})

const shownNodes = computed(() => graph.value.nodes.filter((n) => !n.hidden))
/** 完整关系（统计口径：度数、连通分量、枢纽都用它，不能只看画出来的那些） */
const shownEdges = computed(() => graph.value.edges)
/** 画布上真正画出来的边 */
const drawnEdges = computed(() => graph.value.drawnEdges)
const leftOutEdges = computed(() => Math.max(0, shownEdges.value.length - drawnEdges.value.length))

const nodeById = computed(() => new Map(shownNodes.value.map((n) => [n.id, n])))

interface EdgeLine {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  kind: GraphEdge['kind']
  width: number
  dash?: string
}

/**
 * 把坐标贴到边上。
 * 这一层在拖动时会重算，所以只做「上限条数」的活 —— 便宜到可以每帧跑。
 * （原来模板里每条边要 nodeById.get 四次，四万条边就是十六万次查表，全在渲染关键路径上。）
 */
const edgeLines = computed<EdgeLine[]>(() => {
  const byId = nodeById.value
  const out: EdgeLine[] = []
  for (const e of drawnEdges.value) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    out.push({
      key: `${e.source}|${e.target}`,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      kind: e.kind,
      width: e.kind === 'link' ? Math.min(4, 1 + e.weight * 0.3) : 1,
      dash: e.kind === 'cooccur' ? '3 3' : undefined
    })
  }
  return out
})

const KIND_COLOR: Record<string, string> = {
  character: '#c0553e',
  location: '#3f7d5a',
  item: '#9a7420',
  organization: '#4a5f9e',
  lore: '#7a4f9e',
  timeline: '#8a6327',
  chapter: '#8b8b8b'
}

function color(n: GraphNode) {
  return KIND_COLOR[n.kind] || '#666'
}

function radius(n: GraphNode) {
  if (n.kind === 'chapter') return 6
  return 8 + Math.min(12, Math.sqrt(n.weight + 1) * 3)
}

const sel = computed(() => (selected.value ? nodeById.value.get(selected.value) || null : null))

const selNeighbors = computed(() => {
  if (!selected.value) return [] as GraphNode[]
  const ids = new Set<string>()
  for (const e of shownEdges.value) {
    if (e.source === selected.value) ids.add(e.target)
    else if (e.target === selected.value) ids.add(e.source)
  }
  return [...ids].map((id) => nodeById.value.get(id)).filter(Boolean) as GraphNode[]
})

const groups = computed(() => components(shownNodes.value, shownEdges.value))
const isolated = computed(() => groups.value.filter((g) => g.length === 1).map((g) => nodeById.value.get(g[0])?.name || ''))
const topHubs = computed(() => hubs(shownNodes.value, 6))

async function reload() {
  if (!state.ref) return
  loading.value = true
  try {
    // 强制重读设定库：这个应用的前提是「目录就是数据模型」，作者完全可能
    // 一边开着软件、一边在记事本里加条目 —— 切回这个视图（或点刷新）就该看见。
    // 不 force 的话 ensureCodex 会直接命中缓存，新条目永远不出现。
    await ensureCodex(true)
    bodies.value = await ensureBodies()
  } finally {
    loading.value = false
  }
}

onMounted(reload)
watch(() => state.ref, reload)

function toggleKind(k: SettingKind) {
  const i = kinds.value.indexOf(k)
  if (i >= 0) kinds.value.splice(i, 1)
  else kinds.value.push(k)
}

function relayout() {
  // 传 raw 对象：layout 内部要写上万次 x/y，走响应式代理会被逐次记账，白白慢一截。
  // 改完一次性触发（代理与 raw 是同一份数据，模板照样看得到新坐标）。
  layout(graph.value.nodes.map((n) => toRaw(n)), drawnEdges.value, 260, W, H)
}

/* 拖拽节点：改的是本次布局的 x/y，不落盘（图只是视图）
 *
 * 用 Pointer Events 而不是 mousedown + window 上的 mousemove：
 *   · 触摸设备上手指按住圆点一拖，浏览器会把它当成滚动，节点纹丝不动；
 *   · 鼠标那套的 mousemove 挂在 window 上，手指滑出圆点之后就收不到后续事件了。
 * Pointer Events 一套同时覆盖鼠标 / 触摸 / 触控笔，配合 `setPointerCapture`
 * 把这一串事件锁在节点上（CSS 里还要给 .node 加 `touch-action: none` 关掉原生手势，
 * 见 global.css 的 html.ua-mobile 段）。 */
function onDown(n: GraphNode, e: PointerEvent) {
  // 右键和多指（副指针）不该拖节点
  if (e.button !== 0 || !e.isPrimary) return
  selected.value = n.id
  dragId.value = n.id
  const start = { x: e.clientX, y: e.clientY }
  const origin = { x: n.x, y: n.y }
  const el = e.currentTarget as Element
  const svg = (el as SVGElement)?.ownerSVGElement
  // 宽度为 0 时（SVG 还没量出尺寸、或在 jsdom 里跑冒烟）不要拿它做除数，
  // 否则 scale=0 会把坐标算成 Infinity，节点直接飞出画布
  const rect = svg?.getBoundingClientRect().width ?? 0
  const scale = rect > 0 ? rect / W : 1
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    // 个别 WebView 不支持捕获：退化成「手指别滑出圆点」，比整个拖不动强
  }
  // 事件名与这个 DOM 版本的类型表对不上（'pointermove' 不在 ElementEventMap 里），
  // 所以监听器统一按 EventListener 声明、进去再窄化成 PointerEvent。
  const move: EventListener = (raw) => {
    const ev = raw as PointerEvent
    if (dragId.value !== n.id || ev.pointerId !== e.pointerId) return
    n.x = origin.x + (ev.clientX - start.x) / scale
    n.y = origin.y + (ev.clientY - start.y) / scale
  }
  const up: EventListener = (raw) => {
    const ev = raw as PointerEvent
    if (ev.pointerId !== e.pointerId) return
    dragId.value = null
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* 没捕获成功过，也就没什么可放的 */
    }
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

function openEntry(n: GraphNode) {
  if (n.kind === 'chapter') {
    const id = n.id.replace(/^ch:/, '')
    selectChapter(id)
    setView('write')
    return
  }
  codexState.selectedId = n.id
  setDockTab('codex')
  setView('write')
}
</script>

<template>
  <div class="graph">
    <div class="head">
      <b>关系图</b>
      <span class="dim small">设定条目之间的显式链接 + 正文共现；{{
        mobileEnv ? '按住圆点拖动可摆位置' : '拖动圆点可摆位置'
      }}</span>
      <span class="grow"></span>
      <button class="text small" @click="relayout">重排</button>
      <button class="text small" @click="reload">刷新</button>
    </div>

    <div class="bar">
      <span class="chips">
        <button
          v-for="k in ALL_KINDS"
          :key="k"
          class="chip"
          :class="{ on: kinds.length === 0 || kinds.includes(k) }"
          @click="toggleKind(k)"
        >
          {{ KIND_LABEL[k] }}
        </button>
      </span>
      <label class="small"><input v-model="includeChapters" type="checkbox" @change="relayout" /> 含章节</label>
      <label class="small">
        共现 ≥
        <select v-model.number="cooccurMin">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
          <option :value="5">5</option>
          <option :value="8">8</option>
          <option :value="12">12</option>
          <option :value="20">20</option>
        </select>
      </label>
      <span class="dim small">{{ shownNodes.length }} 节点 · {{ shownEdges.length }} 关系</span>
      <span v-if="leftOutEdges" class="small warn-text">
        线条太多，只画了最强的 {{ drawnEdges.length }} 条（省略 {{ leftOutEdges }} 条弱关系）—— 把「共现 ≥」调高会清爽很多
      </span>
    </div>

    <div class="stage">
      <svg v-if="shownNodes.length" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
        <g class="edges">
          <line
            v-for="l in edgeLines"
            :key="l.key"
            :x1="l.x1"
            :y1="l.y1"
            :x2="l.x2"
            :y2="l.y2"
            class="edge"
            :class="l.kind"
            :stroke-width="l.width"
            :stroke-dasharray="l.dash"
          />
        </g>
        <g class="nodes">
          <g
            v-for="n in shownNodes"
            :key="n.id"
            :transform="`translate(${n.x}, ${n.y})`"
            class="node"
            @pointerdown.prevent="onDown(n, $event)"
            @dblclick="openEntry(n)"
          >
            <circle :r="radius(n)" :fill="color(n)" class="dot" :class="{ sel: selected === n.id }" :stroke-width="selected === n.id ? 2 : 1.2" />
            <text :y="radius(n) + 12" text-anchor="middle" class="lbl">{{ n.name }}</text>
          </g>
        </g>
      </svg>

      <div v-else-if="loading" class="empty dim">正在读取设定库…</div>
      <div v-else class="empty dim">
        还没有画得出关系的内容。在「设定」面板里建条目，并在条目正文里用 [[名称]] 或 @名称 指向别的条目。
      </div>
    </div>

    <aside class="side">
      <template v-if="sel">
        <div class="spread">
          <b>{{ sel.name }}</b>
          <span class="tag" :style="{ background: color(sel) }">{{ KIND_LABEL[sel.kind as SettingKind] || '章节' }}</span>
        </div>
        <div class="small dim">出场 {{ sel.weight }} 章 · 关联 {{ sel.degree }} 项</div>
        <div class="small"><b>关系（{{ selNeighbors.length }}）</b></div>
        <div class="nbrs">
          <button v-for="nb in selNeighbors" :key="nb.id" class="chip" @click="selected = nb.id">{{ nb.name }}</button>
        </div>
        <button class="text small" @click="openEntry(sel)">在设定面板打开</button>
      </template>

      <template v-else>
        <div class="small"><b>枢纽（度最高）</b></div>
        <div class="nbrs">
          <button v-for="h in topHubs" :key="h.id" class="chip" @click="selected = h.id">{{ h.name }}·{{ h.degree }}</button>
        </div>
        <div class="small dim" v-if="topHubs.length">点一个名字看它的关系。</div>
      </template>

      <div class="small"><b>结构</b></div>
      <div class="small dim">分成 {{ groups.length }} 个互不相连的小团体</div>
      <div v-if="isolated.length" class="small warn-text">孤立条目（跟谁都没关系）：{{ isolated.join('、') }}</div>
      <div v-else class="small dim">没有完全孤立的条目。</div>
    </aside>
  </div>
</template>

<style scoped>
.graph {
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
.grow {
  flex: 1;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.chips {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.chip {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-dim);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
}
.chip.on {
  border-color: var(--accent);
  color: var(--accent);
}
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
}
svg {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.node {
  cursor: grab;
}
.node:hover circle {
  stroke: var(--text);
}
/* 连线与节点的描边走 CSS，而不是 SVG 属性：presentation attribute 里不能用 var()，
   夜间模式下底色变了、描边却还留白，节点看起来会糊成一团 */
.edge {
  stroke: var(--edge);
}
.edge.link {
  stroke: var(--edge-link);
}
.dot {
  stroke: var(--canvas);
}
.dot.sel {
  stroke: var(--text);
}
.lbl {
  font-size: 11px;
  fill: var(--text-soft);
  pointer-events: none;
}
.empty {
  margin: auto;
  padding: 24px;
  text-align: center;
  font-size: 13px;
  max-width: 420px;
  line-height: 1.7;
}
.side {
  width: 210px;
  flex: 0 0 210px;
  border-left: 1px solid var(--line);
  padding: 10px;
  overflow: auto;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tag {
  color: var(--on-accent);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
}
.nbrs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.warn-text {
  color: var(--warn);
}
</style>
