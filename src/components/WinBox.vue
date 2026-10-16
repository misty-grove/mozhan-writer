<script setup lang="ts">
/**
 * 窗口化容器：功能栏打开的对话框用它装，桌面上变成「可拖动、可缩放的独立窗口」。
 *
 * 两种形态（跟着 mobileEnv 走）：
 *  - 桌面：无遮罩浮窗 —— 标题栏按住可拖，右下角可拉大小，Esc 或 × 关闭；
 *    位置尺寸按 storeKey 记进 localStorage，下次打开还是上次那副样子。
 *  - 手机：保持原来的底部抽屉（mask + dialog），触摸端拖窗口没有意义。
 *
 * 对外只暴露两件事：slot 放内容、close 事件关窗。
 * 类名刻意保留 `.dialog` / `.head` / `.btn-icon` —— 既有的验收选择器全靠它们定位。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { mobileEnv } from '@/platform'

const props = withDefaults(
  defineProps<{
    /** 窗口标题（显示在标题栏） */
    title: string
    /** 初始宽度 */
    width?: number
    /** 初始高度；0 = 按内容撑（最多不超过视口） */
    height?: number
    /** 位置尺寸记忆键（同一窗口每次打开都恢复上次的几何） */
    storeKey?: string
  }>(),
  { width: 680, height: 0, storeKey: '' }
)

const emit = defineEmits<{ (e: 'close'): void }>()

const root = ref<HTMLElement | null>(null)
const x = ref(0)
const y = ref(0)
const w = ref(props.width)
const h = ref(props.height)
const ready = ref(false)

const mobile = computed(() => mobileEnv.value)

/* ------------------------------------------------ 几何：读写与归位 */
function loadGeom() {
  if (mobile.value) return
  if (props.storeKey) {
    try {
      const g = JSON.parse(localStorage.getItem('mozhan.win.' + props.storeKey) || '')
      if (g && typeof g.x === 'number' && typeof g.w === 'number') {
        w.value = Math.max(380, Math.min(g.w, window.innerWidth - 20))
        h.value = Math.max(240, Math.min(g.h || 0, window.innerHeight - 40))
        x.value = Math.max(0, Math.min(g.x, window.innerWidth - 120))
        y.value = Math.max(0, Math.min(g.y, window.innerHeight - 60))
        return
      }
    } catch {
      /* 没有记录 / 记录坏了 —— 走居中 */
    }
  }
  center()
}

function center() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const boxH = h.value || Math.min(640, vh - 80)
  x.value = Math.max(8, Math.round((vw - w.value) / 2))
  y.value = Math.max(8, Math.round((vh - boxH) / 2))
}

function saveGeom() {
  if (!props.storeKey || mobile.value) return
  try {
    localStorage.setItem(
      'mozhan.win.' + props.storeKey,
      JSON.stringify({ x: x.value, y: y.value, w: w.value, h: h.value })
    )
  } catch {
    /* 存不下就算了，不挡关窗 */
  }
}

const winStyle = computed(() => ({
  left: x.value + 'px',
  top: y.value + 'px',
  width: w.value + 'px',
  height: h.value ? h.value + 'px' : 'auto',
  maxHeight: window.innerHeight - Math.max(16, y.value) - 8 + 'px'
}))

/* ------------------------------------------------ 拖动（标题栏） */
let dragging = false
function startDrag(e: MouseEvent) {
  if (mobile.value) return
  // 右侧按钮不是拖动的把手
  if ((e.target as HTMLElement).closest('button')) return
  dragging = true
  const sx = e.clientX
  const sy = e.clientY
  const ox = x.value
  const oy = y.value
  const move = (ev: MouseEvent) => {
    if (!dragging) return
    x.value = Math.max(0, Math.min(ox + ev.clientX - sx, window.innerWidth - 100))
    y.value = Math.max(0, Math.min(oy + ev.clientY - sy, window.innerHeight - 40))
  }
  const up = () => {
    dragging = false
    saveGeom()
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/* ------------------------------------------------ 缩放（右下角把手） */
let resizing = false
function startResize(e: MouseEvent) {
  if (mobile.value) return
  e.preventDefault()
  resizing = true
  const sx = e.clientX
  const sy = e.clientY
  const ow = w.value
  const oh = h.value || (root.value?.offsetHeight ?? 480)
  const move = (ev: MouseEvent) => {
    if (!resizing) return
    w.value = Math.max(380, Math.min(ow + ev.clientX - sx, window.innerWidth - x.value - 8))
    h.value = Math.max(260, Math.min(oh + ev.clientY - sy, window.innerHeight - y.value - 8))
  }
  const up = () => {
    resizing = false
    saveGeom()
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/* Esc 关窗（输入框里打 Esc 先归输入框自己，不冒泡到这里） */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  emit('close')
}

onMounted(() => {
  loadGeom()
  ready.value = true
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <!-- 手机：底部抽屉（原对话框形态，行为不变） -->
  <div v-if="mobile" class="mask" @click.self="emit('close')">
    <div class="dialog win">
      <div class="spread head">
        <b>{{ title }}</b>
        <span class="row">
          <slot name="extra" />
          <button class="btn-icon" @click="emit('close')">×</button>
        </span>
      </div>
      <div class="body col"><slot /></div>
    </div>
  </div>

  <!-- 桌面：可拖动、可缩放的独立窗口 -->
  <div v-else-if="ready" ref="root" class="dialog win float" :style="winStyle">
    <div class="head grab" @mousedown="startDrag">
      <b>{{ title }}</b>
      <span class="row">
        <slot name="extra" />
        <button class="btn-icon" title="关闭（Esc）" @click="emit('close')">×</button>
      </span>
    </div>
    <div class="body col"><slot /></div>
    <div class="resize-grip" title="拖动调整大小" @mousedown="startResize"></div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: var(--scrim, rgba(0, 0, 0, 0.4));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog.win {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
/* 桌面浮窗：固定定位 + 几何由 JS 管（位置尺寸会记住） */
.dialog.float {
  position: fixed;
  z-index: 50;
  max-width: calc(100vw - 16px);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  user-select: none;
}
.head.grab {
  cursor: move;
}
.head b {
  font-size: 13px;
  letter-spacing: 0.3px;
}
.body.col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 12px 14px;
  gap: 8px;
}
/* 右下角缩放把手：视觉上只是一道小斜角，指针变成斜双向箭头 */
.resize-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 0 50%, var(--line) 50% 58%, transparent 58% 68%, var(--line) 68% 76%, transparent 76%);
  border-bottom-right-radius: 9px;
}
</style>
