<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TopBar from '@/components/TopBar.vue'
import ChapterTree from '@/components/ChapterTree.vue'
import EditorPane from '@/components/EditorPane.vue'
import RightDock from '@/components/RightDock.vue'
import ReferencePane from '@/components/ReferencePane.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import SnapshotDialog from '@/components/SnapshotDialog.vue'
import OutlineDialog from '@/components/OutlineDialog.vue'
import ImportDialog from '@/components/ImportDialog.vue'
import ImportOutlineDialog from '@/components/ImportOutlineDialog.vue'
import ShortcutHelp from '@/components/ShortcutHelp.vue'
import MobileBar from '@/components/MobileBar.vue'
import SandboxDialog from '@/components/SandboxDialog.vue'
import { aiEnabled, cycleTheme, setScale, settings, zoomBy } from '@/core/settings'
import { matchShortcut, type Shortcut } from '@/core/shortcuts'
import { editorState, MAIN_VIEWS, navBack, navForward, requestJump, resetNav, setView, viewFx } from '@/stores/editor'
import BoardView from './BoardView.vue'
import GraphView from './GraphView.vue'
import TimelineView from './TimelineView.vue'
import StatsView from './StatsView.vue'
import { buildContext, loadSkills } from '@/stores/ai'
import { closeWork, saveNow, state } from '@/stores/workspace'
import { sandbox, summaryText, leaveSandbox } from '@/stores/sandbox'
import { attachDrawerSwipe, beginBackGuard, endBackGuard, mobileEnv, startKeyboardWatch } from '@/platform'

const showSettings = ref(false)
const showExport = ref(false)
const showSnapshots = ref(false)
const showOutline = ref(false)
const showImport = ref(false)
const showImportOutline = ref(false)

/** 从「大纲」面板里点导入：先关掉大纲那个框，再开导入框，别叠两层 */
function openOutlineImport() {
  showOutline.value = false
  showImport.value = false
  showImportOutline.value = true
}
/** 从「导入大纲」里点「查看本书大纲」：对调过来，同样别叠两层 */
function openOutlineView() {
  showImportOutline.value = false
  showImport.value = false
  showOutline.value = true
}
const showSandbox = ref(false)
const bodyEl = ref<HTMLElement | null>(null)
/**
 * 这两个必须声明在**所有 watch 之前**：Vue 的 `watch(source, cb)` 不是 immediate 时
 * 也会先跑一次 source 取旧值，所以 `watch(() => focus.value, …)` 会在 setup 阶段
 * 立刻读 `focus` —— 声明在它后面就是一个 "Cannot access 'focus' before initialization"。
 * （TS 编译期不报，因为箭头函数体里的引用算「稍后使用」。）
 */
const focus = ref(false)
const treeRef = ref<InstanceType<typeof ChapterTree> | null>(null)

/** 移动端：两个侧栏是盖在稿纸上的抽屉，任何一个开着就得有个「点别处收起」的地方 */
const drawerOpen = computed(() => mobileEnv.value && (settings.ui.sidebarOpen || settings.ui.dockOpen))
const scrimVisible = computed(() => drawerOpen.value && !focus.value)

function closeDrawers() {
  settings.ui.sidebarOpen = false
  settings.ui.dockOpen = false
  editorState.refOpen = false
}

/**
 * 安卓返回键：抽屉开着时先关抽屉，而不是退出写作。
 * 做法见 src/platform/mobile.ts —— WebView 里返回键就是 history back，
 * 所以往栈里压一条占位记录，让它有得可退。
 */
watch(drawerOpen, (open) => {
  if (!mobileEnv.value) return
  if (open) beginBackGuard(closeDrawers)
  else endBackGuard()
})
watch(() => focus.value, (f) => {
  // 进专注模式等于把抽屉收了，占位记录也得跟着退掉
  if (f && mobileEnv.value) endBackGuard()
})

// 边缘滑动开合抽屉 + 软键盘高度（都只在手机上挂）
let detachSwipe: (() => void) | null = null
let stopKeyboard: (() => void) | null = null

/**
 * 手机上才需要的两件「跟宿主打交道」的活：边缘滑动手势、软键盘高度监听。
 *
 * 必须等到 DOM 挂载之后再挂 —— 手势要绑在 `.body` 元素上，setup 阶段它还是 null。
 * 早先这里写成 `watch(mobileEnv, ..., { immediate: true })`，结果回调在 setup 里就跑完了，
 * `bodyEl.value` 为空直接 return；而 mobileEnv 之后再也不会变，于是手势**从来没挂上过**
 * （端到端里「划了半天抽屉不动」就是这么来的）。所以改成 onMounted 必调一次。
 */
function syncMobile() {
  detachSwipe?.()
  detachSwipe = null
  stopKeyboard?.()
  stopKeyboard = null
  if (!mobileEnv.value) return
  if (bodyEl.value) {
    detachSwipe = attachDrawerSwipe(bodyEl.value, {
      leftOpen: () => settings.ui.sidebarOpen,
      rightOpen: () => settings.ui.dockOpen,
      openLeft: () => {
        settings.ui.dockOpen = false
        settings.ui.sidebarOpen = true
      },
      openRight: () => {
        settings.ui.sidebarOpen = false
        settings.ui.dockOpen = true
      },
      close: closeDrawers
    })
  }
  stopKeyboard = startKeyboardWatch()
}
// 宿主信息可能比组件晚到（那时 mobileEnv 才翻真），所以两边都挂
watch(mobileEnv, syncMobile)
onMounted(syncMobile)
onBeforeUnmount(() => {
  detachSwipe?.()
  stopKeyboard?.()
  if (mobileEnv.value) endBackGuard()
})

async function reloadSkillsAndContext() {
  if (!aiEnabled()) return
  await loadSkills()
  await buildContext()
}

watch(
  () => aiEnabled(),
  (on) => {
    if (!on) return
    reloadSkillsAndContext()
  }
)

watch(
  () => state.currentId,
  () => {
    if (aiEnabled()) buildContext()
  }
)

onMounted(() => {
  if (aiEnabled()) reloadSkillsAndContext()
})

// 切到全局视图时自动退出专注，否则看不见全局结构
watch(
  () => editorState.view,
  (v) => {
    if (v !== 'write') focus.value = false
  }
)

/** 焦点是否在可输入的地方：在输入框里按 `?` 应该是打一个字，不是弹帮助 */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = (e.target || document.activeElement) as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return !!el.isContentEditable
}

/** 焦点是否落在正文编辑器里（决定 Ctrl+B / Ctrl+E 归谁） */
function isInProseMirror(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el?.closest?.('.ProseMirror')
}

/** 编辑位置前进 / 后退：Alt+← / Alt+→ */
function gotoNavSpot(dir: 'back' | 'forward') {
  const spot = dir === 'back' ? navBack() : navForward()
  if (!spot) return
  if (editorState.view !== 'write') setView('write')
  // 「这是历史回放」由 EditorPane 自己在落地过程中标记，这里只管发跳转请求
  requestJump(spot.chapterId, spot.pos, '')
}

function openHelp() {
  editorState.helpOpen = true
}

async function focusTreeFilter() {
  if (!settings.ui.sidebarOpen) settings.ui.sidebarOpen = true
  if (focus.value) focus.value = false
  await nextTick()
  treeRef.value?.focusFilter()
}

/** 不带修饰键的可打印字符（比如 `?`）：在输入框里应该是打一个字，不是触发功能 */
function isBarePrintable(sc: Shortcut): boolean {
  return !sc.ctrl && !sc.alt && sc.keys.some((k) => k.length === 1)
}

/**
 * 全局快捷键派发。
 *
 * 键位表住在 core/shortcuts.ts（帮助面板读同一份，不会两边漂）。
 * 两条前提必须先处理：
 *  1. `e.defaultPrevented` —— 正文编辑器（ProseMirror）已经把键用掉了就别再动，
 *     否则 Ctrl+B 会同时加粗并收起目录。
 *  2. 在输入框里打字时不抢键（`?` 之类）。
 */
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  const sc = matchShortcut(e, { inEditor: isInProseMirror() })
  if (!sc) {
    if (e.key === 'Escape') {
      if (editorState.helpOpen) editorState.helpOpen = false
      else if (focus.value) focus.value = false
    }
    return
  }
  if (isBarePrintable(sc) && isTypingTarget(e)) return

  e.preventDefault()
  switch (sc.id) {
    case 'save':
      saveNow()
      break
    case 'toggleSidebar':
      settings.ui.sidebarOpen = !settings.ui.sidebarOpen
      break
    case 'toggleDock':
      settings.ui.dockOpen = !settings.ui.dockOpen
      break
    case 'toggleFind':
      editorState.findOpen = true
      break
    case 'focusTreeFilter':
      focusTreeFilter()
      break
    case 'view1':
    case 'view2':
    case 'view3':
    case 'view4':
    case 'view5':
      setView(MAIN_VIEWS[Number(sc.keys[0]) - 1].k)
      break
    case 'zoomIn':
      zoomBy(0.1)
      break
    case 'zoomOut':
      zoomBy(-0.1)
      break
    case 'zoomReset':
      setScale(1)
      break
    case 'focusMode':
      focus.value = !focus.value
      break
    case 'toggleTheme':
      cycleTheme()
      break
    case 'navBack':
      gotoNavSpot('back')
      break
    case 'navForward':
      gotoNavSpot('forward')
      break
    case 'help':
      editorState.helpOpen = !editorState.helpOpen
      break
  }
}

window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/**
 * 关闭作品。
 * 沙盒模式下要顺手「退出沙盒」：把在途改动存好、内存镜像落一次 IndexedDB、
 * 再把宿主装回原来的那个 —— 否则首页明明没人打开作品，宿主却还是内存宿主。
 */
async function close() {
  resetNav() // 导航历史是「这部作品内的」概念，关掉就清空
  if (sandbox.active) await leaveSandbox()
  closeWork()
}

/** 降级模式：磁盘上什么都没有，得让作者随时看得见这件事 */
const sbxNotice = ref('')
watch(
  () => sandbox.message,
  (m) => {
    if (m) sbxNotice.value = m
  },
  { immediate: true }
)
</script>

<template>
  <div class="write" :class="{ focus }">
    <TopBar
      v-if="!focus"
      @export="showExport = true"
      @snapshots="showSnapshots = true"
      @settings="showSettings = true"
      @focus="focus = true"
      @close="close()"
      @outline="showOutline = true"
      @import="showImport = true"
      @import-outline="showImportOutline = true"
      @help="openHelp"
      @nav-back="gotoNavSpot('back')"
      @nav-forward="gotoNavSpot('forward')"
      @sandbox="showSandbox = true"
    />

    <!-- 沙盒提示条：导入结果 / 恢复提示。点掉就收起来（顶栏的沙盒标记一直在） -->
    <div v-if="sandbox.active && sbxNotice" class="sbx-note">
      <span class="tag warn small">沙盒</span>
      <span class="small">{{ sbxNotice }}</span>
      <span class="grow"></span>
      <span class="small dim">{{ summaryText }}</span>
      <button class="text small" @click="showSandbox = true">导出…</button>
      <button class="btn-icon small" @click="sbxNotice = ''">×</button>
    </div>

    <div ref="bodyEl" class="body">
      <Transition name="scrim">
        <div v-if="scrimVisible" class="drawer-scrim" @click="closeDrawers"></div>
      </Transition>
      <!-- 目录抽屉：从左边滑出来（手机上它是「盖在稿纸上的抽屉」，不是并排的栏） -->
      <Transition name="drawer-l">
        <ChapterTree v-if="settings.ui.sidebarOpen && !focus" ref="treeRef" class="sidebar" />
      </Transition>
      <main class="main">
        <!-- 主区五视图：PPT 式左右推入。方向由 setView 在改状态之前就算好了（见 stores/editor） -->
        <Transition :name="'vp-' + viewFx.dir">
          <EditorPane v-if="editorState.view === 'write'" key="write" />
          <BoardView v-else-if="editorState.view === 'board'" key="board" />
          <GraphView v-else-if="editorState.view === 'graph'" key="graph" />
          <TimelineView v-else-if="editorState.view === 'timeline'" key="timeline" />
          <StatsView v-else-if="editorState.view === 'stats'" key="stats" />
        </Transition>
        <!-- 分屏对照：贴在编辑器右侧，和正文并排看 -->
        <ReferencePane v-if="editorState.refOpen && !editorState.refPinned && !focus && editorState.view === 'write'" mode="dock" />
      </main>
      <Transition name="drawer-r">
        <RightDock v-if="settings.ui.dockOpen && !focus" />
      </Transition>
    </div>

    <!-- 手机底部工具条：拇指区。键盘弹起时它变成标点条贴在键盘上沿 -->
    <MobileBar v-if="mobileEnv && !focus" @outline="showOutline = true" @import="showImport = true" />

    <!-- 钉住的参考窗：切到别的视图也还在 -->
    <ReferencePane
      v-if="editorState.refOpen && editorState.refPinned && !focus"
      mode="pin"
      :style="{ left: editorState.refPos.x + 'px', top: editorState.refPos.y + 'px' }"
    />

    <button v-if="focus" class="exit-focus" @click="focus = false">退出专注（Esc）</button>

    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
    <ExportDialog v-if="showExport" @close="showExport = false" />
    <OutlineDialog v-if="showOutline" @close="showOutline = false" @import-outline="openOutlineImport" />
    <ImportDialog v-if="showImport" @close="showImport = false" @import-outline="openOutlineImport" />
    <ImportOutlineDialog v-if="showImportOutline" @close="showImportOutline = false" @view-outline="openOutlineView" />
    <SnapshotDialog v-if="showSnapshots" @close="showSnapshots = false" />
    <SandboxDialog v-if="showSandbox" @close="showSandbox = false" />
    <ShortcutHelp v-if="editorState.helpOpen" @close="editorState.helpOpen = false" />

    <div v-if="state.loading" class="loading">{{ state.loadingText }}</div>
  </div>
</template>

<style scoped>
.write {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar {
  width: 232px;
  flex: 0 0 232px;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
}
.write.focus {
  background: var(--bg);
}
/* 专注模式的退出按钮：平时半透明贴在角落里，鼠标过去才「浮」出来 */
.exit-focus {
  position: fixed;
  right: 20px;
  bottom: 20px;
  opacity: 0.35;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  box-shadow: var(--shadow-2);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  transition: opacity 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
  z-index: 30;
}
.exit-focus:hover {
  opacity: 1;
  transform: translateY(-1px);
  box-shadow: var(--shadow-3);
}
.loading {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-3);
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 60;
  animation: ui-pop-in 0.2s ease both;
}
/* 转圈用的是纯 CSS，避免为此引入任何依赖 */
.loading::before {
  content: '';
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.sbx-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--note-bg);
  color: var(--note-fg);
  font-size: 12px;
  box-shadow: inset 0 -1px 0 var(--lift);
  animation: ui-slide-down 0.18s ease both;
}
.grow {
  flex: 1;
}
</style>
