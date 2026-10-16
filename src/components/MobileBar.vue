<script setup lang="ts">
/**
 * 手机底部工具条（只在移动端渲染）。
 *
 * 两副面孔：
 *  - 平时是**导航条**：目录 / 大纲 / 撤销 / 保存 / 资料 / 查找 / 导入。放在底部而不是顶上，
 *    是因为单手握持时拇指够得着的是屏幕下半部 —— 顶栏在手机上是够不着的，
 *    而顶栏上的「查找 / 导入稿件」都标了 data-mobile="hide"，等于手机上没有入口。
 *  - 软键盘弹起时变成**标点条**，贴在键盘上沿：中文写作一天要敲几百次的
 *    「」——…… 这些，用系统输入法翻页找非常打断思路。
 *
 * 两个容易踩的点：
 *  1. 标点按钮必须用 `@mousedown.prevent` 而不是 `@click`：默认的 mousedown 会把焦点
 *     抢走，键盘立刻收起，第二条标点就点不成了。
 *  2. 键盘高度由 src/platform/mobile.ts 量出来，写进 `--kb`，条子靠它贴在键盘上沿。
 */
import { computed } from 'vue'
import { keyboardHeight } from '@/platform'
import { editorApi, editorState } from '@/stores/editor'
import { saveNow, state } from '@/stores/workspace'
import { settings } from '@/core/settings'

const emit = defineEmits<{
  (e: 'outline'): void
  (e: 'import'): void
}>()

const kb = computed(() => keyboardHeight.value)

/** 成对的标点插完后把光标退回中间（「｜」而不是「」｜） */
const KEYS: Array<{ label: string; ins: string; back?: number }> = [
  { label: '「」', ins: '「」', back: 1 },
  { label: '『』', ins: '『』', back: 1 },
  { label: '——', ins: '——' },
  { label: '……', ins: '……' },
  { label: '、', ins: '、' },
  { label: '；', ins: '；' },
  { label: '！', ins: '！' },
  { label: '？', ins: '？' },
  // 段首空两格：中文正文的段落起手式，手机上敲两个全角空格太麻烦
  { label: '段', ins: '\n\n　　' }
]

function insert(k: { ins: string; back?: number }) {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    el.value = el.value.slice(0, start) + k.ins + el.value.slice(end)
    const caret = start + k.ins.length - (k.back || 0)
    el.selectionStart = el.selectionEnd = caret
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  // 所见即所得模式：走 execCommand 让 ProseMirror 自己接管这次输入
  // （它监听 beforeinput，直接改 DOM 会让它状态错乱）
  document.execCommand('insertText', false, k.ins)
  if (k.back) {
    try {
      const sel = document.getSelection()
      for (let i = 0; i < k.back; i++) sel?.modify('move', 'backward', 'character')
    } catch {
      // 个别 WebView 不支持 Selection.modify：光标停在右半边后面，不影响内容
    }
  }
}

function hideKeyboard() {
  const el = document.activeElement as HTMLElement | null
  el?.blur?.()
}

function undo() {
  editorApi.value?.undo()
  editorApi.value?.focus()
}

const saveClass = computed(() => (state.saving || state.dirty ? 'busy' : state.lastSaved ? 'on' : ''))
const saveText = computed(() => (state.saving ? '保存中' : state.dirty ? '未保存' : '已保存'))
</script>

<template>
  <div class="mobile-bar" :class="{ 'on-keyboard': kb > 0, keys: kb > 0 }" :style="{ '--kb': kb + 'px' }">
    <!-- 键盘弹起：标点条 + 收起 -->
    <template v-if="kb > 0">
      <button v-for="k in KEYS" :key="k.label" @mousedown.prevent="insert(k)">{{ k.label }}</button>
      <button data-ic="⌄" title="收起键盘" @mousedown.prevent="hideKeyboard">收起</button>
    </template>

    <!-- 平时：底部导航 -->
    <template v-else>
      <button data-ic="☰" :class="{ on: settings.ui.sidebarOpen }" @click="settings.ui.sidebarOpen = !settings.ui.sidebarOpen">
        目录
      </button>
      <button data-ic="▤" @click="emit('outline')">大纲</button>
      <button data-ic="↶" title="撤销" @click="undo()">撤销</button>
      <button data-ic="⤒" @click="saveNow()">
        保存<i class="save-dot" :class="saveClass"></i>
      </button>
      <button
        data-ic="❐"
        :class="{ on: settings.ui.dockOpen || editorState.refOpen }"
        @click="((settings.ui.dockOpen = !settings.ui.dockOpen), (editorState.refOpen = false))"
      >
        资料
      </button>
      <!-- 查找：EditorPane 顶部的查找替换条。顶栏那颗在手机上是隐藏的，这里补上 -->
      <button data-ic="⌕" @click="editorState.findOpen = true">查找</button>
      <!-- 导入：顶栏「导入稿件」在手机上同样被收起来了，从底栏重新给一条路 -->
      <button data-ic="⤓" @click="emit('import')">导入</button>
    </template>
  </div>
</template>

<style scoped>
/* 大部分皮肤在 global.css 的 .mobile-bar 里（那条要跟 .ua-mobile 一起用，
   写在组件里会拿不到 html 上的类）。这里只放组件独有的两处。 */
button {
  position: relative;
}
/* 标点条上的按钮，文字本身就是标点，不需要伪元素图标 */
.keys button::before {
  content: none;
}
.save-dot {
  position: absolute;
  top: 6px;
  right: 50%;
  margin-right: -16px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line);
}
.save-dot.on {
  background: var(--ok);
}
.save-dot.busy {
  background: var(--warn);
}
</style>
