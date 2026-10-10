import { reactive, ref } from 'vue'
import { orderOf, slideDirection, type SlideDir } from '@/core/motion'

/** 右侧面板页签 */
export type DockTab =
  | 'context'
  | 'candidate'
  | 'skill'
  | 'memory'
  | 'asset'
  | 'card'
  | 'search'
  | 'codex'
  | 'foreshadow'
  | 'style'
  | 'check'
  | 'stats'

/** 主区视图（P2 新增：除写作外的全局视图） */
export type MainView = 'write' | 'board' | 'graph' | 'timeline' | 'stats'

export const MAIN_VIEWS: Array<{ k: MainView; label: string; hint: string }> = [
  { k: 'write', label: '写作', hint: '单栏编辑器' },
  { k: 'board', label: '看板', hint: '按状态分列的章节看板' },
  { k: 'graph', label: '关系图', hint: '设定条目之间的关系网络' },
  { k: 'timeline', label: '时间线', hint: '事件时序与矛盾' },
  { k: 'stats', label: '统计', hint: '写作曲线与结构健康度' }
]

/** 编辑器 UI 状态（跨组件共享） */
export const editorState = reactive({
  mode: 'wysiwyg' as 'wysiwyg' | 'source',
  focusMode: false,
  findOpen: false,
  findQuery: '',
  replaceText: '',
  useRegex: false,
  hits: 0,
  view: 'write' as MainView,
  dockTab: 'context' as DockTab,
  /** 参考资料窗（P2-24 分屏 / P2-27 钉住）：开着看设定，不用切来切去 */
  refOpen: false,
  refPinned: false as boolean,
  refSourceId: '',
  refPos: { x: 120, y: 120 },
  /** 快捷键一览（P3-D）：`?` 打开，Esc 关闭 */
  helpOpen: false,
  /** 章节树筛选框输入（P3-D）：放 store 里，Ctrl+P 才能把焦点怼进去 */
  treeFilter: ''
})

export const selectedText = ref('')

/* ------------------------------------------------------------------ 切换动效
 * 手机上视图/页签是「整页换掉」，没有动画的话就是硬切，眼睛会丢参照物。
 * 方向（往左推还是往右推）由 core/motion 的纯函数算，这里只负责**在改状态之前**
 * 把方向记下来 —— 放到 watch 里算就晚了：Vue 的 <Transition> 要读的是
 * 「这次切换该用哪组 class」，而它自己也是靠 watch 触发的，两个 watch 的先后不可靠。
 */
export const viewFx = reactive({ dir: 'left' as SlideDir })
export const dockFx = reactive({ dir: 'left' as SlideDir })

const VIEW_ORDER = orderOf(MAIN_VIEWS)

/** 切主视图：顺手把推入方向定下来（所有入口都该走这里，别直接改 editorState.view） */
export function setView(k: MainView) {
  if (k === editorState.view) return
  viewFx.dir = slideDirection(editorState.view, k, VIEW_ORDER)
  editorState.view = k
}

/** 切右侧页签：order 是「当前可见的页签顺序」，用来判方向；不传就默认往左推 */
export function setDockTab(k: DockTab, order: readonly string[] = []) {
  if (k === editorState.dockTab) return
  dockFx.dir = order.length ? slideDirection(editorState.dockTab, k, order) : 'left'
  editorState.dockTab = k
}

/**
 * 编辑位置导航历史（P3-D）
 *
 * 作者会不停在章节之间跳：从「检查」跳到一处笔误、从搜索跳到某段、顺着双链跳到别的章。
 * 跳完往往想回到刚才写的地方，但浏览器/编辑器的撤销管不到「跨章节跳转」。
 * 这里只记「章节 + 光标位置」这些粗粒度落点，不记每一次按键 —— 那样历史会被打字淹掉。
 */
export interface NavSpot {
  chapterId: string
  pos: number
  /** 给 UI 显示的落点说明 */
  label: string
}

const NAV_LIMIT = 80
let navStack: NavSpot[] = []
let navIndex = -1
/** 正在执行「前进/后退」时不要往历史里记新落点，否则会把自己踩掉 */
let applyingNav = false

export const navState = reactive({
  canBack: false,
  canForward: false,
  backLabel: '',
  forwardLabel: ''
})

/** 当前光标位置：EditorPane 每次选区变化时更新，pushNav 时取用 */
export const caretPos = ref(0)

function syncNav() {
  navState.canBack = navIndex > 0
  navState.canForward = navIndex >= 0 && navIndex < navStack.length - 1
  navState.backLabel = navStack[navIndex - 1]?.label || ''
  navState.forwardLabel = navStack[navIndex + 1]?.label || ''
}

/**
 * 记一个落点。
 * `force` 为真时不做去重 —— 同一章内的一次「跳转」（比如从搜索结果跳到本章某段）
 * 也算一次导航，否则 Alt+← 会退不回来。
 */
export function pushNav(spot: NavSpot, force = false) {
  if (applyingNav) return
  const cur = navStack[navIndex]
  if (!force && cur && cur.chapterId === spot.chapterId && Math.abs(cur.pos - spot.pos) < 2) return
  navStack = navStack.slice(0, navIndex + 1)
  navStack.push(spot)
  if (navStack.length > NAV_LIMIT) navStack = navStack.slice(navStack.length - NAV_LIMIT)
  navIndex = navStack.length - 1
  syncNav()
}

/**
 * 光标动了就更新「当前这个落点」的位置，不新增历史。
 *
 * 只在落点记录时取光标位置是不够的：作者在第 5 章写了半小时，期间从没跳过页，
 * 那 Alt+← 只能回到「刚进第 5 章时的第 0 个字」。这里让栈顶跟着光标走，
 * 于是后退再前进能精确回到离开时那一段。
 */
export function touchNavPos(chapterId: string, pos: number) {
  const cur = navStack[navIndex]
  if (!cur || cur.chapterId !== chapterId) return
  cur.pos = pos
}

export function navBack(): NavSpot | null {
  if (navIndex <= 0) return null
  navIndex--
  syncNav()
  return navStack[navIndex]
}

export function navForward(): NavSpot | null {
  if (navIndex < 0 || navIndex >= navStack.length - 1) return null
  navIndex++
  syncNav()
  return navStack[navIndex]
}

/**
 * 应用一个历史落点：期间不记新历史。
 *
 * 必须是 **await 整个异步过程** 的写法：`selectChapter` 要读文件，
 * 等读完之后编辑器才会收到新的 currentId 并触发 watch；如果用
 * `setTimeout(0)` 去关这个锁，IO 一慢锁就提前开了，历史里会多出一条
 * 「刚跳到的那一章的第 0 个字」，Alt+← 就退不回真正的上一处。
 */
export async function withNavApplied<T>(fn: () => T | Promise<T>): Promise<T> {
  applyingNav = true
  try {
    return await fn()
  } finally {
    applyingNav = false
  }
}

export function resetNav() {
  navStack = []
  navIndex = -1
  syncNav()
}

export function navHistory(): NavSpot[] {
  return [...navStack]
}

/** 历史里当前所在的位置（0 起）；没有历史时为 -1。自检与 UI 提示用 */
export function navCursor(): number {
  return navIndex
}

/** 「跳到这一处」请求：由检查/文风面板发起，EditorPane 负责落地 */
export const jumpRequest = ref<{ seq: number; chapterId: string; pos: number; needle: string } | null>(null)

let jumpSeq = 0
export function requestJump(chapterId: string, pos = 0, needle = '') {
  jumpRequest.value = { seq: ++jumpSeq, chapterId, pos, needle }
}

/** 「在资料面板打开这个文件」请求 */
export const openAssetRequest = ref<{ seq: number; id: string } | null>(null)
export function requestOpenAsset(id: string) {
  openAssetRequest.value = { seq: ++jumpSeq, id }
}

/** EditorPane 注册的应用接口，供 AI 候选区把文本写回编辑器 */
/**
 * 编辑器实例的几个动作，给外部 UI（手机底部工具条）用。
 *
 * 撤销这种事只能由编辑器实例执行，而实例住在 EditorPane 里 ——
 * 与其把整个 Tiptap 实例塞进全局状态，不如只把要用的那两个动作挂出来。
 */
export const editorApi = ref<{ undo: () => void; focus: () => void } | null>(null)

export interface ApplyApi {
  append(md: string): void
  /**
   * 整篇替换当前章节的正文（快照回滚用）。
   *
   * 又一个踩过的坑，和 replaceSelection 同一个家族：编辑器只在 `currentId` **变化**时
   * 从 `state.content` 同步一次。所以「读快照 → 直接写 state.content」的结果是
   * 屏幕上还是回滚前的正文、盘上却已经是快照内容 —— 下一次自动保存或随手一个按键
   * 就按屏幕上的旧正文把回滚**覆盖回去**。改正文只有一条路：走编辑器。
   */
  setContent(md: string): void
  /**
   * 替换当前选区。**返回有没有真的替换成功**。
   *
   * 这是个踩过的坑：原来返回 void，没选区时内部直接 `return`，
   * 调用方（候选区）却照样把候选标成「已采纳」—— 作者看到标签变了、正文一个字没动。
   * 所以返回值不是装饰，是「静默失败」的唯一出口。
   */
  replaceSelection(md: string): boolean
  focus(): void
}

export const applyApi = ref<ApplyApi | null>(null)
