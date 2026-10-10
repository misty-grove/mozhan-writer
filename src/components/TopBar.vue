<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { aiEnabled, settings, THEMES, cycleTheme } from '@/core/settings'
import { currentChapter, currentWords, saveNow, state, todayWordsNow, totalWords } from '@/stores/workspace'
import { editorState, MAIN_VIEWS, navState, setDockTab, setView } from '@/stores/editor'
import { chipText, sandbox, summaryText } from '@/stores/sandbox'
import { mobileEnv } from '@/platform'

const emit = defineEmits<{
  (e: 'export'): void
  (e: 'snapshots'): void
  (e: 'settings'): void
  (e: 'focus'): void
  (e: 'close'): void
  (e: 'outline'): void
  (e: 'import'): void
  (e: 'importOutline'): void
  (e: 'help'): void
  (e: 'navBack'): void
  (e: 'navForward'): void
  (e: 'sandbox'): void
}>()

const saveLabel = computed(() => (state.saving ? '保存中' : state.dirty ? '未保存' : state.lastSaved ? '已保存' : '就绪'))
const progress = computed(() => (settings.general.dailyTarget ? Math.min(100, Math.round((todayWordsNow.value / settings.general.dailyTarget) * 100)) : 0))

const themeLabel = computed(() => THEMES.find((t) => t.k === settings.editor.theme)?.label || '白底')
const themeHint = computed(() => THEMES.find((t) => t.k === settings.editor.theme)?.hint || '')

const backTip = computed(() => (navState.canBack ? `后退到：${navState.backLabel}（Alt + ←）` : '没有可后退的编辑位置（Alt + ←）'))
const forwardTip = computed(() => (navState.canForward ? `前进到：${navState.forwardLabel}（Alt + →）` : '没有可前进的编辑位置（Alt + →）'))

/* ------------------------------------------------------------------ 手机上的「更多」
 *
 * 顶栏在桌面是「一屏放得下全部工具」的设计：左（位置）+ 中（五个视图 + 字数）+ 右（十来
 * 个动作）。390px 宽的手机上这些加起来有一千多像素，右侧的按钮会整个跑到屏幕外 ——
 * 看着像没做适配，实际是点不到。
 *
 * 市面上的安卓应用在这里都是同一个答案：顶栏只留最常用的两三个，其余收进一个「更多」菜单。
 * 这里就按这个来 —— 桌面端一个字都不变（菜单入口带 data-mobile="only"，只有手机上露面）。
 */
const moreOpen = ref(false)
/** 视图切换在手机上也需要，但不在顶栏占位置，收进菜单第一节 */
const VIEW_ITEMS = MAIN_VIEWS
const editItems = computed(() => [
  { label: '‹ 后退', off: !navState.canBack, run: () => emit('navBack') },
  { label: '前进 ›', off: !navState.canForward, run: () => emit('navForward') },
  { label: '查找', off: false, run: () => (editorState.findOpen = true) },
  {
    label: editorState.mode === 'wysiwyg' ? '源码模式' : '所见模式',
    off: false,
    run: () => (editorState.mode = editorState.mode === 'wysiwyg' ? 'source' : 'wysiwyg')
  },
  { label: '资料面板', off: false, run: () => (settings.ui.dockOpen = !settings.ui.dockOpen) },
  { label: '快捷键一览', off: false, run: () => emit('help') }
])
const workItems = computed(() => [
  // AI 在窄顶栏里会被让位（它带 data-mobile="hide"），所以菜单里必须有它 ——
  // 「配好了 AI 却找不到入口」正是这次要修的那类问题。
  { label: 'AI 助手', off: false, run: openAi },
  { label: '大纲', off: false, run: () => emit('outline') },
  { label: '导出', off: false, run: () => emit('export') },
  { label: '快照', off: false, run: () => emit('snapshots') },
  { label: '导入稿件', off: false, run: () => emit('import') },
  { label: '导入大纲', off: false, run: () => emit('importOutline') },
  { label: '参考面板', off: false, run: () => (editorState.refOpen = !editorState.refOpen) },
  { label: '设置', off: false, run: () => emit('settings') },
  { label: '专注写作', off: false, run: () => emit('focus') },
  {
    label: '关闭作品',
    off: false,
    run: () => {
      saveNow()
      emit('close')
    }
  }
])

/** 菜单里点一项：先做事，再把菜单收起来 */
function pick(run: () => void) {
  run()
  moreOpen.value = false
}

/**
 * 顶栏的 AI 入口。这里曾经只是个 `<span class="tag">AI</span>` 徽章 ——
 * 作者配好 API 之后看到它、去点它，什么都不会发生：它从头到尾就不是一个按钮，
 * 只是「AI 层已解锁」的状态标记。「无法点击使用 AI 功能」的报告全部源于此。
 *
 * 现在它真的是个按钮：
 *  - 已配置 → 切回写作视图（右侧面板只在写作视图存在）→ 打开面板 → 落到「上下文」页签，
 *    那里就是选工具、生成、进候选区的起点；
 *  - 没配置 → 直接打开设置（AI 配置就在那里），而不是装作没看见。
 */
function openAi() {
  if (!aiEnabled()) {
    emit('settings')
    return
  }
  if (editorState.view !== 'write') setView('write')
  settings.ui.dockOpen = true
  setDockTab('context')
}

/* ------------------------------------------------------------------ 顶栏密度
 *
 * 顶栏原来是按「1920 全屏正好放得下全部工具」排的：左（位置）+ 中（五个视图 + 字数）
 * + 右（十几个动作）加起来一千七百像素。窗口一缩，`.right` 是 `flex: 0 0 auto`，
 * 不会被压缩 —— 结果右侧那排按钮整个被推到窗口外，看着像「功能没了」。
 *
 * 所以按**量出来的**可用宽度分三档（不是拍脑袋的像素断点：字体缩放、书名字数都会
 * 改变实际需要的宽度）：
 *   full    全显示；
 *   compact 缩间距、去掉图标、让次要字数与章节名让位 —— 按钮一个不少；
 *   mini    右区只留主题与「更多」，其余动作收进菜单（跟手机同一套，不另做一份）。
 * 三档都还放不下时还有最后一道兜底：允许顶栏换成两行（见 .bar 的 flex-wrap），
 * 这样再窄也只是变高，不会把按钮推到看不见的地方。
 */
type Density = 'full' | 'compact' | 'mini'
const density = ref<Density>('full')
/** 顶栏是不是要靠两行才放得下（两行时右区独占第二行，见样式里的 data-wrapped） */
const wrapped = ref(false)
const barEl = ref<HTMLElement | null>(null)
const rightEl = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
let rafId = 0

/**
 * 量出某一档「真正需要多宽」。
 *
 * 必须临时挂 `data-measure` 把换行与收缩全关掉再量 —— 否则 flex 会把需求悄悄吸收掉：
 * 按钮被压缩、右区自己折到第二行，于是量出来永远「放得下」，可屏幕上早就糊成一团或
 * 被推出可视区了（这正是「非全屏时功能显示不全」量不出来的原因）。
 */
function needAt(el: HTMLElement, d: Density) {
  el.dataset.density = d
  const all = el.scrollWidth // 读取即触发同步布局，拿到的是这一档的字面需求
  const right = rightEl.value ? rightEl.value.offsetWidth : all
  return { all, right }
}

function measure() {
  const el = barEl.value
  if (!el) return
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    const have = el.clientWidth
    el.dataset.measure = '1'
    const full = needAt(el, 'full')
    const compact = needAt(el, 'compact')
    const mini = needAt(el, 'mini')
    delete el.dataset.measure
    el.dataset.density = density.value // 交回给 Vue 之前先还原成当前值

    /* 退让顺序就是作者要的那个：先缩间距（去图标、藏次要读数）→ 再换成两行 →
       最后才把动作收进「更多」菜单。任何一步都不许把按钮推出屏幕。 */
    let want: Density
    let twoRow = false
    if (full.all <= have) {
      want = 'full'
    } else if (compact.all <= have) {
      want = 'compact'
    } else if (compact.right <= have) {
      // 一整条放不下，但右区自己一行放得下：两行全显示（比收菜单更接近「功能都在」）
      want = 'compact'
      twoRow = true
    } else if (mini.all <= have) {
      // 右区一行都放不下：收进菜单换回一行
      want = 'mini'
    } else {
      // 极窄（分屏到很小）：菜单 + 换行兜底，至少不出屏幕
      want = 'mini'
      twoRow = true
    }
    if (want !== density.value) density.value = want
    if (twoRow !== wrapped.value) wrapped.value = twoRow
  })
}

/* 只在**宽度**变了的时候重量。
   量的时候要临时挂 data-measure（布局会跟着变高变矮），若拿尺寸变化本身当触发条件，
   就会「测量 → 尺寸变 → 再测量」空转不停。宽度只有容器/窗口能改，换档改不了它。 */
let lastW = 0
function onBarResize() {
  const el = barEl.value
  if (!el) return
  const w = el.clientWidth
  if (w === lastW) return
  lastW = w
  measure()
}

onMounted(() => {
  onBarResize()
  // jsdom（冒烟测试）里没有 ResizeObserver —— 两处都得能缺席，不能因为没有它就报错
  if (typeof ResizeObserver !== 'undefined' && barEl.value) {
    ro = new ResizeObserver(onBarResize)
    ro.observe(barEl.value)
  }
  window.addEventListener('resize', onBarResize)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  ro?.disconnect()
  window.removeEventListener('resize', onBarResize)
})
// 缩放改的是字号，顶栏宽度没变（ResizeObserver 不会响），但需要的宽度变了 —— 得重新量
watch(() => settings.ui.scale, measure)

const onEsc = (e: KeyboardEvent) => {
  if (e.key === 'Escape') moreOpen.value = false
}
watch(moreOpen, (on) => {
  if (on) window.addEventListener('keydown', onEsc, true)
  else window.removeEventListener('keydown', onEsc, true)
})
// 离开手机形态（理论上不会中途变）或组件销毁时，别把监听落下
watch(mobileEnv, (on) => {
  if (!on) moreOpen.value = false
})
// 窗口拉宽回 full 档后「更多」入口就消失了 —— 菜单不能还浮在那儿
watch(density, (d) => {
  if (d !== 'mini' && !mobileEnv.value) moreOpen.value = false
})
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc, true))
</script>

<template>
  <header ref="barEl" class="bar" :data-density="density" :data-wrapped="wrapped ? 'true' : 'false'">
    <div class="row left">
      <button class="btn-icon" title="章节目录 Ctrl+B" @click="settings.ui.sidebarOpen = !settings.ui.sidebarOpen">☰</button>
      <!-- 后退/前进靠 Alt+←/→，手机上没键盘；手机上收进「更多」菜单 -->
      <span class="navpair" data-mobile="hide">
        <button class="btn-icon nav" :disabled="!navState.canBack" :title="backTip" @click="emit('navBack')">‹</button>
        <button class="btn-icon nav" :disabled="!navState.canForward" :title="forwardTip" @click="emit('navForward')">›</button>
      </span>
      <!-- 作品徽标：写在书名旁边，给「我现在改的是哪一部」一个图形锚点。
           必须放在 .bk 外面 —— .bk 的文本是被端到端断言直接读的。 -->
      <i class="seal" aria-hidden="true">{{ (state.info.title || '未').trim().charAt(0) }}</i>
      <span class="sep" data-mobile="hide"></span>
      <b class="bk" :title="state.ref?.name">{{ state.info.title || '未命名作品' }}</b>
      <span class="dim small chp" data-mobile="hide" :title="'当前章节：' + (currentChapter?.title || '')">{{ currentChapter?.title || '—' }}</span>
    </div>

    <!-- 五个视图：桌面上是顶栏正中的分段控件；手机上收进「更多」 -->
    <div class="row views" data-mobile="hide">
      <button
        v-for="v in MAIN_VIEWS"
        :key="v.k"
        class="vtab"
        :class="{ on: editorState.view === v.k }"
        :title="v.hint"
        @click="setView(v.k)"
      >
        {{ v.label }}
      </button>
    </div>

    <div class="row center small">
      <!-- 手机上只留「本章」与保存状态：今日目标/进度条/全书字数都进不了这块窄屏 -->
      <span class="plan" data-mobile="hide" :title="`今日已写 ${todayWordsNow} 字，目标 ${settings.general.dailyTarget} 字`">
        今日 <b class="num">{{ todayWordsNow.toLocaleString() }}</b>
        <span class="dim">/ {{ settings.general.dailyTarget.toLocaleString() }}</span>
      </span>
      <span class="mini" data-mobile="hide" :title="`完成度 ${progress}%`"><i :style="{ width: progress + '%' }"></i></span>
      <span class="nowrap">本章 <b class="num">{{ currentWords.toLocaleString() }}</b></span>
      <span class="dim nowrap" data-mobile="hide">全书 {{ totalWords.toLocaleString() }}</span>
      <span class="dot" :class="{ on: !state.dirty && state.lastSaved, busy: state.saving || state.dirty }"></span>
      <span class="save small" data-mobile="hide" :class="{ warn: state.dirty }">{{ saveLabel }}</span>
      <button
        class="aibtn"
        :class="{ off: !aiEnabled() }"
        data-mobile="hide"
        :title="aiEnabled() ? '打开 AI 助手：选工具 → 生成 → 候选区' : 'AI 未配置 —— 点这里去设置里填 Base URL / Key / 模型'"
        @click="openAi"
      >
        AI
      </button>
    </div>

    <div ref="rightEl" class="row right">
      <!-- 沙盒的「已保存」和磁盘无关，必须说清楚，否则作者以为稿子已经落盘了 -->
      <button
        v-if="sandbox.active"
        class="tag sbx"
        :class="sandbox.diff.count ? 'warn' : 'info'"
        :title="summaryText + '（点开看导出）'"
        @click="emit('sandbox')"
      >
        {{ chipText }}
      </button>
      <!-- 图标走 data-ic + 伪元素：不进 textContent，端到端断言按文案定位不会受影响。
           带 data-mobile="hide" 的按钮在手机上会让位给「更多」菜单（见文件末尾）。 -->
      <span class="grp">
        <button class="text small" data-ic="◇" data-mobile="hide" @click="editorState.mode = editorState.mode === 'wysiwyg' ? 'source' : 'wysiwyg'">
          {{ editorState.mode === 'wysiwyg' ? '源码' : '所见' }}
        </button>
        <button class="text small" data-ic="⌕" data-mobile="hide" @click="editorState.findOpen = !editorState.findOpen">查找</button>
      </span>
      <span class="sep" data-mobile="hide"></span>
      <span class="grp">
        <button class="text small" data-ic="☰" data-mobile="hide" @click="emit('outline')">大纲</button>
        <button class="text small" data-ic="⤓" data-mobile="hide" @click="emit('import')">导入稿件</button>
        <button class="text small" data-ic="⌸" data-mobile="hide" @click="emit('importOutline')">导入大纲</button>
        <button class="text small" data-ic="▤" data-mobile="hide" :class="{ on: editorState.refOpen }" @click="editorState.refOpen = !editorState.refOpen">参考</button>
        <button class="text small" data-ic="⧉" data-mobile="hide" @click="emit('snapshots')">快照</button>
        <button class="text small" data-ic="⤒" data-mobile="hide" @click="emit('export')">导出</button>
      </span>
      <span class="sep" data-mobile="hide"></span>
      <!-- 主题轮换留在顶栏：夜间/护眼是随手就要切的，进菜单太深 -->
      <span class="grp">
        <button class="text small" data-ic="◐" :title="`当前：${themeLabel}（${themeHint}）· Ctrl+. 轮换`" @click="cycleTheme()">{{ themeLabel }}</button>
        <button class="text small" data-ic="⚙" data-mobile="hide" @click="emit('settings')">设置</button>
        <button class="text small" data-ic="⌖" data-mobile="hide" @click="emit('focus')">专注</button>
        <button class="text small" data-ic="↩" data-mobile="hide" @click="((saveNow()), emit('close'))">关闭作品</button>
      </span>
      <span class="sep" data-mobile="hide"></span>
      <button class="btn-icon" data-mobile="hide" title="快捷键一览（?）" @click="emit('help')">?</button>
      <button class="btn-icon" data-mobile="hide" title="资料面板 Ctrl+J" @click="settings.ui.dockOpen = !settings.ui.dockOpen">▤</button>
      <!-- 手机上、以及桌面窄窗口（mini 档）：把上面让位的动作收进这里。
           显示与否由 class 控制，不再只认 ua-mobile —— 桌面半屏也常常放不下整条顶栏。 -->
      <button class="btn-icon morebtn" title="更多" @click="moreOpen = !moreOpen">⋯</button>
    </div>

    <!-- 更多菜单：只在手机上会出现（入口自带 data-mobile="only"）。遮罩负责「点别处收起」 -->
    <div v-if="moreOpen" class="more-mask" @click="moreOpen = false"></div>
    <div v-if="moreOpen" class="more-menu">
      <div class="mm-title">视图</div>
      <div class="mm-grid">
        <button
          v-for="v in VIEW_ITEMS"
          :key="'mv-' + v.k"
          :class="{ on: editorState.view === v.k }"
          @click="pick(() => setView(v.k))"
        >
          {{ v.label }}
        </button>
      </div>
      <div class="mm-title">编辑</div>
      <div class="mm-grid">
        <button v-for="m in editItems" :key="m.label" :disabled="m.off" @click="pick(m.run)">{{ m.label }}</button>
      </div>
      <div class="mm-title">作品</div>
      <div class="mm-grid">
        <button v-for="m in workItems" :key="m.label" @click="pick(m.run)">{{ m.label }}</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* 顶栏是唯一横跨全部五个视图的东西，所以它必须「安静」：
   降噪办法是不给按钮画边框、只在悬停时显形，用分组 + 细分隔线交代结构。 */
.bar {
  /* min-height 而不是 height：窗口窄到一定程度时允许换成两行（flex-wrap），
     凭这一条兜底，任何宽度下按钮都不会被推到看不见的地方 */
  min-height: 44px;
  height: auto;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  align-content: center;
  padding: 5px 12px;
  background: var(--bg-panel);
  gap: 10px;
  row-gap: 4px; /* 必须在 gap 之后：gap 是简写，会把它重置掉 */
  flex: 0 0 auto;
  /* 「更多」菜单以顶栏为定位参照（手机上、以及桌面窄窗口的 mini 档） */
  position: relative;
}
.left,
.center,
.right {
  gap: 6px;
  min-width: 0;
}
.left {
  flex: 0 1 auto;
  overflow: hidden;
}
.center {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-soft);
}
/* 右区不收缩、内部也不换行：一行放不下时它整块被顶栏挤到第二行去。
   这是**故意的** —— 让「放不下」这件事变成可测量的（顶栏变高），
   脚本据此降档（缩间距 → 收进菜单）；若这里允许它自己内部折行，
   溢出就被它悄悄吸收，脚本永远量不出该降档，最后只能整排推到屏幕外。 */
.right {
  flex: 0 0 auto;
  justify-content: flex-end;
}

/* ---- 左：位置 ---- */
.navpair {
  display: inline-flex;
  gap: 1px;
}
/* 作品徽标：一个写着书名前的小方块，比单纯加粗好认 */
.seal {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  box-shadow: var(--shadow-1);
  user-select: none;
}
.bk {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 190px;
}
.chp {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}
.chp::before {
  content: '·';
  margin-right: 5px;
  color: var(--line);
}

/* ---- 中：视图分段 + 写作状态 ---- */
.views {
  gap: 2px;
  padding: 3px;
  background: var(--bg-field);
  border: 1px solid var(--line);
  border-radius: 8px;
  flex: 0 0 auto;
  box-shadow: inset 0 1px 0 var(--lift);
}
.vtab {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 3px 11px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}
.vtab:hover {
  color: var(--text);
}
.vtab.on {
  background: var(--bg-elev);
  color: var(--text);
  font-weight: 500;
  /* 描边是给夜间主题准备的：那里 bg-elev 和 bg-field 太接近，光靠色差认不出激活项 */
  box-shadow: var(--shadow-1), 0 0 0 1px var(--line);
}

.sep {
  width: 1px;
  height: 16px;
  background: var(--line);
  flex: 0 0 auto;
}
.grp {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
}
.nav {
  font-size: 15px;
  line-height: 1;
  padding: 3px 6px;
}
.nav:disabled {
  opacity: 0.3;
}

/* 数字对齐：字数每秒都在变，不等宽的话整条顶栏会跟着抖 */
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text);
}
.plan {
  white-space: nowrap;
}
.mini {
  display: inline-block;
  width: 56px;
  height: 4px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
  flex: 0 0 auto;
}
.mini i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line);
  flex: 0 0 auto;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.dot.on {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
}
/* 有改动未保存：让这个点自己呼吸，而不是只换种没人注意的灰色 */
.dot.busy {
  background: var(--warn);
  animation: bar-pulse 1.6s ease-in-out infinite;
}
@keyframes bar-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--warn) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 0%, transparent);
  }
}
.save {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}
.save.warn {
  color: var(--warn);
}

/* ---- 右：工具 ---- */
.right .text {
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 6px;
  white-space: nowrap;
}
/* data-ic：图标写在属性里、由伪元素画出来，不进 textContent
   ——端到端断言是靠按钮文案定位的，图标绝不能混进那里去。 */
.right [data-ic]::before {
  content: attr(data-ic);
  margin-right: 4px;
  opacity: 0.65;
  font-size: 12px;
}
.right [data-ic]:hover::before {
  opacity: 1;
}
button.text.on {
  color: var(--accent);
  background: var(--accent-soft);
}
/* AI 入口：一颗真正的按钮（见 openAi 的注释 —— 它以前只是个徽章，点了没反应）。
   配置了就亮着；没配置是描边空心，一样能点（进设置）。 */
.aibtn {
  flex: 0 0 auto;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 9px;
  cursor: pointer;
  box-shadow: var(--shadow-1);
  transition: filter 0.15s ease, transform 0.15s ease;
}
.aibtn:hover {
  filter: brightness(1.08);
}
.aibtn:active {
  transform: translateY(1px);
}
.aibtn.off {
  background: transparent;
  color: var(--text-dim);
  border-color: var(--line);
  box-shadow: none;
}
.aibtn.off:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.tag.sbx {
  border: 1px solid currentColor;
  cursor: pointer;
  background: transparent;
  font-size: 11px;
  padding: 1px 7px;
}
.tag.sbx:hover {
  background: var(--accent-soft);
}

/* ---- 手机上的「更多」菜单 ----
 * 入口按钮带 data-mobile="only"：桌面端整块都不存在（见 global.css 末尾那条规则）。
 * 遮罩用 fixed 铺满，负责「点别处就收起」——比挂 document 监听干净，也不会漏解绑。 */
.more-mask {
  position: fixed;
  inset: 0;
  z-index: 39;
}
.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 6px;
  z-index: 40;
  width: min(78vw, 320px);
  max-height: 62vh; /* 手机：菜单别把整屏盖住 */
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-3);
  animation: ui-pop-in 0.16s ease both;
}
/* 桌面上顶栏变窄是「窗口拖小了」，屏幕高度还在，菜单没必要被 62vh 卡住 ——
   否则末尾的「专注写作 / 关闭作品」还得滚一下才看得见，又成了「功能没显示全」 */
html:not(.ua-mobile) .more-menu {
  max-height: calc(100vh - 76px);
}
.mm-title {
  font-size: 11px;
  color: var(--text-dim);
  padding: 8px 6px 4px;
}
.mm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.mm-grid button {
  min-height: 44px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-field);
  color: var(--text);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mm-grid button:active:not(:disabled) {
  background: var(--bg-active);
}
.mm-grid button.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.mm-grid button:disabled {
  opacity: 0.35;
}

/* 「更多」入口：手机上出现（与底部工具条配套），桌面窄窗口的 mini 档也出现。
   显示与否由 class 管，不再只挂 data-mobile —— 桌面半屏同样需要它。 */
.morebtn {
  display: none;
}
html.ua-mobile .morebtn {
  display: inline-flex;
}

/* ---- 密度三档（档位由脚本量出来的宽度决定，见 measure()） ----
 * 桌面窗口被拖窄（或不是全屏）时，原来的做法是右侧按钮整排被推出可视区，
 * 看起来像「功能不见了」。这里按「先省装饰、再省入口」的顺序退让：
 * 中档不牺牲任何功能，窄档把动作收进菜单。 */
.bar[data-density='compact'] {
  padding: 5px 8px;
  gap: 6px;
}
/* 图标只是锦上添花，一排十来个按钮去掉它就能省下两百来像素 */
.bar[data-density='compact'] [data-ic]::before {
  display: none;
}
.bar[data-density='compact'] .right .text {
  padding: 4px 6px;
}
.bar[data-density='compact'] .vtab {
  padding: 3px 7px;
}
.bar[data-density='compact'] .bk {
  max-width: 130px;
}
/* 中档让位的是「读数」而不是「动作」：章节名 / 今日目标 / 进度条 / 保存文字。
   保存状态仍由那个会呼吸的小圆点交代（dot 带 title）。 */
.bar[data-density='compact'] .chp,
.bar[data-density='compact'] .plan,
.bar[data-density='compact'] .mini,
.bar[data-density='compact'] .save {
  display: none;
}

.bar[data-density='mini'] {
  padding: 5px 8px;
  gap: 6px;
}
/* 窄档：右区只留主题与「更多」，其余（都带 data-mobile="hide"）收进菜单。
   菜单里视图 / 编辑 / 作品三节齐全，功能一个不少，只是少了「一眼看见」。 */
.bar[data-density='mini'] [data-mobile='hide'] {
  display: none !important;
}
.bar[data-density='mini'] .morebtn {
  display: inline-flex;
}
.bar[data-density='mini'] .bk {
  max-width: 34vw;
}
.bar[data-density='mini'] .right {
  justify-content: flex-end;
}

/* 两行形态：右区独占第二行并靠右排（不然它会顶到第二行最左边，看着像掉下来的）。
   第一行留给「位置 + 视图 + 字数」这些看一眼就够的信息。 */
.bar[data-wrapped='true'] .right {
  flex: 1 1 100%;
}

/* 按钮自己不许被压缩：压到文字互相叠在一起，比换行难看得多 */
.right button {
  flex: 0 0 auto;
}

/* ---- 测量态 ----
 * 脚本量「这一档需要多宽」时临时挂上：把换行与收缩全关掉，让 scrollWidth 反映字面需求。
 * 不这么做，flex 就会把「放不下」悄悄吸收掉（按钮被压扁、右区自己折到第二行），
 * 量出来永远够用 —— 而屏幕上早就缺东西了，这正是「非全屏时功能显示不全」量不出来的原因。 */
.bar[data-measure='1'] {
  flex-wrap: nowrap;
}
.bar[data-measure='1'] .left,
.bar[data-measure='1'] .center,
.bar[data-measure='1'] .right,
.bar[data-measure='1'] .left *,
.bar[data-measure='1'] .center *,
.bar[data-measure='1'] .right * {
  flex: 0 0 auto !important;
  flex-wrap: nowrap !important;
}
</style>
