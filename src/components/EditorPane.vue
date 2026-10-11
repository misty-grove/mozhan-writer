<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { settings } from '@/core/settings'
import { mobileEnv } from '@/platform'
import { countWords } from '@/core/util'
import { allChapters, currentChapter, currentVolume, markDirty, newChapter, saveNow, selectChapter, state } from '@/stores/workspace'
import { jumpRequest, applyApi, editorApi, editorState, selectedText, caretPos, pushNav, touchNavPos, withNavApplied } from '@/stores/editor'
import { codexState, ensureCodex } from '@/stores/codex'
import type { SettingEntry } from '@/core/types'

const root = ref<HTMLElement | null>(null)
const sourceText = ref('')
const switching = ref(false)
const hits = ref(0)

/* ------------------------------------------------ 无章节时的起步入口 */
// 不用原生 prompt：真浏览器里它可能被拦（跨源 iframe / 部分 WebView），
// 而且无法做校验与样式。直接在编辑器里给一个输入框更稳。
const firstTitle = ref('')
const creatingFirst = ref(false)

async function createFirstChapter() {
  if (creatingFirst.value) return
  creatingFirst.value = true
  try {
    await newChapter(null, firstTitle.value.trim() || '启程')
    firstTitle.value = ''
  } finally {
    creatingFirst.value = false
  }
}

let editor: Editor | null = null

/* ------------------------------------------------ @ 提及补全（双链） */
const mention = ref({
  open: false,
  query: '',
  items: [] as SettingEntry[],
  index: 0,
  x: 0,
  y: 0
})

function mentionCandidates(q: string): SettingEntry[] {
  const list = codexState.entries
  if (!q) return list.slice(0, 8)
  const lower = q.toLowerCase()
  return list
    .filter((e) => e.name.toLowerCase().includes(lower) || e.aliases.some((a) => a.toLowerCase().includes(lower)))
    .slice(0, 8)
}

/** 光标往前的 "@xxx" 片段；不在 @ 上下文里返回 null */
function mentionState(view: any): { q: string; start: number } | null {
  const pos: number = view.state.selection.from
  const from = Math.max(0, pos - 32)
  const before: string = view.state.doc.textBetween(from, pos, '\n')
  const i = before.lastIndexOf('@')
  if (i < 0) return null
  const q = before.slice(i + 1)
  if (/[\s\n]/.test(q)) return null
  return { q, start: pos - (before.length - i) }
}

function refreshMention(view: any) {
  const m = mentionState(view)
  if (!m) {
    mention.value.open = false
    return
  }
  const items = mentionCandidates(m.q)
  mention.value.items = items
  mention.value.query = m.q
  mention.value.open = items.length > 0
  if (mention.value.index >= items.length) mention.value.index = 0
  if (mention.value.open) {
    try {
      const c = view.coordsAtPos(view.state.selection.from)
      const host = document.querySelector('.editor-wrap')?.getBoundingClientRect()
      mention.value.x = c.left - (host?.left || 0)
      mention.value.y = c.bottom - (host?.top || 0)
    } catch {
      /* noop */
    }
  }
}

function applyMention(name: string) {
  if (!editor) return
  const view: any = editor.view
  const m = mentionState(view)
  if (!m) return
  const pos: number = view.state.selection.from
  view.dispatch(view.state.tr.delete(m.start, pos).insertText(`[[${name}]]`))
  mention.value.open = false
  editor.commands.focus()
  markDirty(editor.storage.markdown.getMarkdown())
}

function onKeyDown(view: any, event: KeyboardEvent): boolean {
  const m = mention.value
  if (m.open) {
    if (event.key === 'ArrowDown') {
      m.index = (m.index + 1) % m.items.length
      return true
    }
    if (event.key === 'ArrowUp') {
      m.index = (m.index - 1 + m.items.length) % m.items.length
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (m.items[m.index]) applyMention(m.items[m.index].name)
      return true
    }
    if (event.key === 'Escape') {
      m.open = false
      return true
    }
    setTimeout(() => refreshMention(view), 0)
    return false
  }
  if (event.key === '@') {
    // 等 '@' 落进文档再读取上下文
    setTimeout(() => refreshMention(view), 0)
  }
  return false
}

/* ------------------------------------------------ 跳转到指定位置（检查/文风/搜索/导航历史） */
watch(jumpRequest, async (req) => {
  const ed = editor
  if (!req || !ed) return
  // 整段包起来：跳转过程中（含异步读正文）不往导航历史里追加新落点
  await withNavApplied(async () => {
    if (req.chapterId && req.chapterId !== state.currentId) await selectChapter(req.chapterId)
    await nextTick()
    if (editorState.mode === 'source') {
      const el = document.querySelector('.source-box') as HTMLTextAreaElement | null
      if (!el) return
      const i = req.needle ? sourceText.value.indexOf(req.needle) : req.pos
      const at = i >= 0 ? i : 0
      el.focus()
      el.setSelectionRange(at, at + (req.needle?.length || 0))
      rememberSpot(req.chapterId || state.currentId, at)
      return
    }
    const target = req.needle ? plainText().indexOf(req.needle) : req.pos
    const docPos = locateInDoc(target >= 0 ? target : 0)
    if (docPos < 0) return
    ed.commands.focus()
    ed.commands.setTextSelection({ from: docPos, to: Math.min(docPos + (req.needle?.length || 1), ed.state.doc.content.size) })
    const host = document.querySelector('.editor-scroll')
    if (host) {
      const el = ed.view.domAtPos(docPos).node as HTMLElement
      el?.scrollIntoView?.({ block: 'center' })
    }
    rememberSpot(req.chapterId || state.currentId, target >= 0 ? target : 0)
  })
})

/** 记一个导航落点（章节 + 落点说明）。标题取不到就退回文件名，别让提示是空的 */
function rememberSpot(chapterId: string, pos: number) {
  if (!chapterId) return
  const ch = allChapters.value.find((c) => c.id === chapterId)
  pushNav({ chapterId, pos, label: ch?.title || ch?.file || '未命名章节' }, true)
}

/** 把文档摊平成与 sourceText 近似的纯文本（用于按字符下标定位） */
function plainText(): string {
  const parts: string[] = []
  editor?.state.doc.descendants((node: any) => {
    if (node.isTextblock) {
      parts.push(node.textContent)
      return false
    }
    return true
  })
  return parts.join('\n\n')
}

/** 纯文本下标 → ProseMirror 文档位置 */
function locateInDoc(target: number): number {
  if (!editor) return -1
  let acc = 0
  let found = -1
  editor.state.doc.descendants((node: any, pos: number) => {
    if (found >= 0) return false
    if (!node.isTextblock) return true
    const len: number = node.textContent.length
    if (target <= acc + len) {
      found = pos + 1 + Math.max(0, target - acc)
      return false
    }
    acc += len + 2
    return false
  })
  return found
}

/**
 * ProseMirror 文档位置 → 纯文本下标（`locateInDoc` 的逆运算）。
 *
 * 导航历史里存的是纯文本下标：它跟 `jumpRequest` 的口径一致，来回跳能精确落回原处；
 * 存 PM 位置的话，一旦文档结构变了（比如切章重载）下标就失去意义。
 */
function docPosToPlain(pmPos: number): number {
  if (!editor) return 0
  let acc = 0
  let out = -1
  editor.state.doc.descendants((node: any, pos: number) => {
    if (out >= 0) return false
    if (!node.isTextblock) return true
    const len: number = node.textContent.length
    if (pmPos >= pos && pmPos <= pos + node.nodeSize) {
      out = acc + Math.min(len, Math.max(0, pmPos - (pos + 1)))
      return false
    }
    acc += len + 2
    return false
  })
  return out < 0 ? 0 : out
}

const paperStyle = computed(() => {
  const s = settings.editor
  // 手机上字太小、行太密是真的读不下去：给字号和行高各兜一个下限。
  // 作者自己调得比下限大时照他的来 —— 这里只管「别小到看不清」。
  const size = mobileEnv.value ? Math.max(s.fontSize, 17) : s.fontSize
  const line = mobileEnv.value ? Math.max(s.lineHeight, 1.9) : s.lineHeight
  return {
    '--write-font': s.fontFamily,
    '--write-size': size + 'px',
    '--write-line': String(line),
    '--write-indent': String(s.indent),
    maxWidth: s.width + 'px'
  }
})

onMounted(() => {
  ensureCodex()
  editor = new Editor({
    element: root.value!,
    extensions: [StarterKit.configure({ history: { depth: 200, newGroupDelay: 300 } }), Markdown.configure({ html: false, breaks: false })],
    content: state.content,
    autofocus: false,
    editorProps: {
      attributes: { class: 'paper' },
      handleKeyDown: (view, event) => onKeyDown(view, event)
    },
    onUpdate: ({ editor: ed }) => {
      if (switching.value) return
      markDirty(ed.storage.markdown.getMarkdown())
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to } = ed.state.selection
      selectedText.value = from === to ? '' : ed.state.doc.textBetween(from, to, '\n')
      // 光标位置跟着记：这样「后退再前进」能回到离开时那一段，而不是只回到章首
      caretPos.value = docPosToPlain(from)
      touchNavPos(state.currentId, caretPos.value)
      if (settings.editor.typewriter) keepCaret()
      paintFocus()
    }
  })
  // 手机底部工具条要用：撤销只能由实例执行，而实例只能住在这里
  editorApi.value = {
    undo: () => editor?.commands.undo(),
    focus: () => editor?.commands.focus()
  }
  applyApi.value = {
    append(md: string) {
      if (!editor) return
      editor.commands.focus('end')
      const from = editor.state.doc.content.size
      editor.commands.focus('end')
      editor.commands.insertContentAt(from, '\n\n' + md)
      markDirty(editor.storage.markdown.getMarkdown())
      saveNow()
    },
    setContent(md: string) {
      // 复用查找替换那条路（同时改编辑器与镜像），再多落一次盘：
      // 回滚是「作者以为已经生效」的操作，不能只等防抖。
      setContentBoth(md)
      saveNow()
    },
    replaceSelection(md: string) {
      if (!editor) return false
      const { from, to } = editor.state.selection
      // 光标没选中任何东西时，替不出内容来。这里必须**如实返回 false** ——
      // 调用方靠它决定要不要把候选标成「已采纳」。
      if (from === to) return false
      editor.commands.insertContentAt({ from, to }, md)
      markDirty(editor.storage.markdown.getMarkdown())
      saveNow()
      return true
    },
    focus: () => editor?.commands.focus()
  }
  // 打开作品时编辑器是带着已有章节挂载的，currentId 的 watch 不会触发；
  // 这里补一个初始落点，否则第一次 Alt+← 无处可退。
  if (state.currentId) rememberSpot(state.currentId, 0)
})

onBeforeUnmount(() => {
  applyApi.value = null
  editorApi.value = null
  editor?.destroy()
})

watch(
  () => state.ref,
  () => ensureCodex(true)
)

watch(
  () => state.currentId,
  (id) => {
    if (!editor) return
    switching.value = true
    if (editorState.mode === 'source') sourceText.value = state.content
    else editor.commands.setContent(state.content || '', false)
    setTimeout(() => (switching.value = false), 60)
    // 从目录点进来也算一次导航。
    // 这里必须**同步**调用：pushNav 要靠 withNavApplied 的锁判断「这是回放」，
    // 放到 setTimeout 里的话锁早就开了，历史会被自己踩出一条废记录。
    if (id) rememberSpot(id, 0)
  }
)

watch(
  () => editorState.mode,
  (mode) => {
    if (!editor) return
    switching.value = true
    if (mode === 'source') {
      sourceText.value = editor.storage.markdown.getMarkdown()
    } else {
      editor.commands.setContent(sourceText.value, false)
      markDirty(editor.storage.markdown.getMarkdown())
    }
    setTimeout(() => (switching.value = false), 60)
  }
)

function onSourceInput() {
  sourceText.value = sourceText.value
  markDirty(sourceText.value)
}

/* ------------------------------------------------ 打字机滚动 */
function keepCaret() {
  const scroller = document.querySelector('.editor-scroll') as HTMLElement | null
  const sel = window.getSelection()
  if (!scroller || !sel || !sel.rangeCount) return
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (!rect.height) return
  const box = scroller.getBoundingClientRect()
  const target = box.top + box.height * 0.38
  const delta = rect.top - target
  if (Math.abs(delta) > 40) scroller.scrollBy({ top: delta })
}

/* ------------------------------------------------ 段落聚焦 */
function paintFocus() {
  const pm = document.querySelector('.ProseMirror') as HTMLElement | null
  if (!pm || !editor) return
  if (!settings.editor.focusParagraph) return
  const { from } = editor.state.selection
  let active = -1
  let i = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (from >= pos && from <= pos + node.nodeSize) active = i
      i++
    }
  })
  const blocks = pm.querySelectorAll('p, h1, h2, h3, blockquote, li')
  blocks.forEach((c, ci) => {
    ;(c as HTMLElement).style.opacity = ci === active ? '1' : '0.42'
  })
}

watch(
  () => settings.editor.focusParagraph,
  (on) => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement | null
    if (!on) pm?.querySelectorAll('p,h1,h2,h3,blockquote,li').forEach((c) => ((c as HTMLElement).style.opacity = '1'))
    else paintFocus()
  }
)

/* ------------------------------------------------ 查找替换 */
function buildRe(): RegExp | null {
  const q = editorState.findQuery
  if (!q) return null
  try {
    return editorState.useRegex
      ? new RegExp(q, 'g')
      : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  } catch {
    return null
  }
}

function doFind() {
  const re = buildRe()
  hits.value = re ? (state.content.match(re) || []).length : 0
}

function replaceFirst() {
  const re = buildRe()
  if (!re || !editorState.findQuery) return
  const next = state.content.replace(re, (m) => editorState.replaceText)
  setContentBoth(next)
  doFind()
}

function replaceAll() {
  const re = buildRe()
  if (!re || !editorState.findQuery) return
  const next = state.content.replace(re, editorState.replaceText)
  setContentBoth(next)
  doFind()
}

function setContentBoth(md: string) {
  switching.value = true
  if (editorState.mode === 'source') sourceText.value = md
  else editor?.commands.setContent(md, false)
  markDirty(md)
  setTimeout(() => (switching.value = false), 40)
}

const words = computed(() => countWords(state.content))

defineExpose({ doFind })
</script>

<template>
  <div class="editor-wrap">
    <div v-if="editorState.findOpen" class="find-bar">
      <input v-model="editorState.findQuery" placeholder="查找（以 /xxx/ 包裹视为正则）" @input="doFind" @keydown.enter="doFind" />
      <span class="dim small nowrap">{{ hits }} 处</span>
      <input v-model="editorState.replaceText" placeholder="替换为" class="rep" />
      <label class="small row"><input type="checkbox" v-model="editorState.useRegex" style="width: auto" />正则</label>
      <button class="text small" @click="replaceFirst">替换首个</button>
      <button class="text small" @click="replaceAll">全部替换</button>
      <button class="btn-icon" @click="editorState.findOpen = false">×</button>
    </div>

    <div class="editor-scroll" @scroll="mention.open = false">
      <div class="paper-col" :style="paperStyle">
        <div v-if="state.currentId" class="head-line">
          <h2 class="ch-title">{{ currentChapter?.title || '（未选择章节）' }}</h2>
          <div class="small dim row">
            <span v-if="currentVolume">{{ currentVolume.name }}</span>
            <span>·</span>
            <span>{{ words }} 字</span>
          </div>
        </div>

        <!-- 一部新作品一章都没有时的起步入口 -->
        <div v-if="!state.currentId" class="blank-start">
          <p class="dim small">这部作品还没有章节。给第一章起个名字，马上开始写。</p>
          <div class="row">
            <input
              v-model="firstTitle"
              class="first-input"
              placeholder="第一章标题，例如：启程"
              @keydown.enter="createFirstChapter"
            />
            <button class="primary" :disabled="creatingFirst" @click="createFirstChapter">新建第一章</button>
            <button class="text small" @click="settings.ui.sidebarOpen = true">展开目录</button>
          </div>
          <p class="dim small">每一章就是 正文/ 下的一个 Markdown 文件，用记事本也能改。</p>
        </div>

        <div v-show="editorState.mode === 'wysiwyg' && !!state.currentId" ref="root" class="editor-host"></div>

        <textarea
          v-if="editorState.mode === 'source'"
          v-model="sourceText"
          class="source-box"
          spellcheck="false"
          @input="onSourceInput"
        ></textarea>
      </div>
    </div>

    <ul v-if="mention.open" class="mention" :style="{ left: mention.x + 'px', top: mention.y + 'px' }">
      <li
        v-for="(e, i) in mention.items"
        :key="e.id"
        :class="{ on: i === mention.index }"
        @mouseenter="mention.index = i"
        @mousedown.prevent="applyMention(e.name)"
      >
        <span class="tag info">{{ e.name }}</span>
        <span class="dim small">{{ e.aliases.length ? '别名：' + e.aliases.join('、') : e.group }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.editor-wrap {
  flex: 1 1 auto; /* 必须自己伸手要宽度，见下 —— 丢了它空章时整个写作区塌成窄竖条 */
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  position: relative;
  /* .main 是行向 flex，而 flex item 的默认值是 `flex: 0 1 auto` —— 基准尺寸取内容的
     max-content。于是稿纸宽度 = 「正文最长一行不换行的宽度」：章节一空（新章/只有几个字），
     整个写作区就塌成一条几十像素的窄竖条贴在左边，`justify-content: center` 也因为
     容器里没有剩余空间而失效。内容多时 flex-shrink 又把它压回可用宽度，bug 自我掩盖 ——
     所以「有字的章看着正常、空章就坏」只有截图才看得出来（2026-10-09 的真实事故）。 */
}
.find-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  box-shadow: var(--shadow-1);
  animation: ui-slide-down 0.16s ease both;
}
.find-bar input {
  width: 210px;
}
.find-bar .rep {
  width: 150px;
}
.editor-scroll {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 28px 32px 45vh;
  display: flex;
  justify-content: center;
  /* 稿纸是这张滚动画布唯一的 flex item，这里必须 **flex-start**，不能用默认的 stretch：
     容器是定高的（flex:1 撑满写作区），单行 flex 的行高就等于容器高，stretch 会把
     稿纸钉死在「一屏高」—— 章节一超过一屏（AI 续写采纳后正文第一次变长就会），
     ProseMirror 的内容直接从稿纸底下画出去：稿纸的圆角/投影只裹住前几行，
     后面的字漂在桌面底色上，看起来像「一块白气泡浮在正文上」（2026-10-10 作者实报）。
     flex-start 让稿纸高度回到「由内容决定」，min-height 仍保证短章也撑满一屏。 */
  align-items: flex-start;
}
/* 稿纸是一张「放在桌面上的纸」：白底、圆角、投影，和四周的桌面（--bg）拉开一层。
   宽度由行内样式 maxWidth（设置里的「稿纸宽度」）封顶，这里负责把它撑满并居中。 */
.paper-col {
  width: 100%;
  background: var(--bg-writing);
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  box-shadow: var(--shadow-2);
  padding: 34px 52px 96px;
  min-height: calc(100vh - 200px);
}
.head-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.ch-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.4;
}
.blank-start {
  border: 1px dashed var(--line);
  border-radius: 10px;
  padding: 20px 22px;
  margin-top: 26px;
  background: var(--bg-panel);
  box-shadow: var(--shadow-1);
  animation: ui-pop-in 0.22s ease both;
}
.blank-start p {
  margin: 0 0 10px;
}
.blank-start .row {
  gap: 8px;
  margin-bottom: 10px;
}
.first-input {
  flex: 1;
  min-width: 0;
}
.source-box {
  width: 100%;
  min-height: 60vh;
  border: none;
  outline: none;
  resize: none;
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: 15px;
  line-height: 1.7;
  color: var(--text);
  background: transparent;
  padding: 0;
}
.mention {
  position: absolute;
  z-index: 40;
  margin: 0;
  padding: 5px;
  list-style: none;
  min-width: 200px;
  max-width: 300px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow-2);
  animation: ui-pop-in 0.14s ease both;
}
.mention li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
}
.mention li.on {
  background: var(--accent-soft);
  color: var(--text);
}
:deep(.ProseMirror) {
  outline: none;
  /* 双保险：全局的 :focus-visible 焦点环不许画到整张稿纸上来 */
  box-shadow: none;
  min-height: 55vh;
  /* 光标跟着强调色：在宽行距的正文里，细黑竖线不好找 */
  caret-color: var(--accent);
}
</style>
