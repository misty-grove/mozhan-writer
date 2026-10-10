/**
 * 快捷键目录：**单一事实来源**。
 *
 * 以前快捷键只在 WriteView 里散着一串 if/else，帮助面板如果另抄一份，两边一定会漂。
 * 现在「有哪些键、按哪些修饰键、归到哪一组、显示成什么样」全在这张表里，
 * 派发（WriteView）和展示（ShortcutHelp）都读它。
 *
 * 纯数据 + 纯函数，不碰 DOM、不碰 settings —— 能在没有浏览器的环境里自检。
 */

/** 只取我们关心的那几个字段，方便自检直接塞对象进来 */
export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export type ShortcutId =
  | 'save'
  | 'toggleSidebar'
  | 'toggleDock'
  | 'toggleFind'
  | 'focusTreeFilter'
  | 'view1'
  | 'view2'
  | 'view3'
  | 'view4'
  | 'view5'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'focusMode'
  | 'toggleTheme'
  | 'navBack'
  | 'navForward'
  | 'help'
  /** 仅展示：键位由编辑器自己处理，我们不派发 */
  | 'editor'
  /** 仅展示：键位由章节目录自己处理（列表拿到焦点时才生效），同样不在这里派发 */
  | 'tree'

export interface Shortcut {
  id: ShortcutId
  group: string
  /** e.key 的候选值（大小写不敏感）。同一个动作有多个同义键就写多个 */
  keys: string[]
  /** 展示用的按键序列，如 ['Ctrl','S']；单元素 ['?'] 表示就是一个键 */
  display: string[]
  label: string
  note?: string
  /** 需要 Ctrl（Mac 上 Cmd 等价）；false = 必须没按；不写 = 不关心 */
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /**
   * 只在「焦点不在正文编辑器里」时由我们派发：正文里同一个键往往已经被编辑器占用
   * （Ctrl+B 加粗、Ctrl+E 行内代码），硬抢会把加粗废掉。
   * 真正的让位机制是编辑器 preventDefault 后我们不再处理，这里只用于把话说清楚。
   */
  outsideEditor?: boolean
  /** 仅展示行：键位完全由编辑器处理 */
  info?: boolean
}

export const SHORTCUTS: Shortcut[] = [
  /* ---------------- 写作 ---------------- */
  { id: 'save', group: '写作', keys: ['s'], display: ['Ctrl', 'S'], label: '立即保存', ctrl: true },
  { id: 'toggleFind', group: '写作', keys: ['f'], display: ['Ctrl', 'F'], label: '查找与替换', ctrl: true },
  { id: 'toggleSidebar', group: '写作', keys: ['b'], display: ['Ctrl', 'B'], label: '章节目录显隐', ctrl: true, outsideEditor: true, note: '光标在正文里时 Ctrl+B 是加粗' },
  { id: 'toggleDock', group: '写作', keys: ['j'], display: ['Ctrl', 'J'], label: '资料面板显隐', ctrl: true },
  { id: 'focusTreeFilter', group: '写作', keys: ['p'], display: ['Ctrl', 'P'], label: '跳到章节筛选框', ctrl: true },
  { id: 'focusMode', group: '写作', keys: ['F11'], display: ['F11'], label: '专注模式（再按或 Esc 退出）', ctrl: false, alt: false },
  { id: 'focusMode', group: '写作', keys: ['e'], display: ['Ctrl', 'Shift', 'E'], label: '专注模式（备选键）', ctrl: true, shift: true, outsideEditor: true, note: '正文里 Ctrl+Shift+E 没有被占用，Ctrl+E 则让给行内代码' },

  /* ---------------- 正文编辑器（由编辑器自身处理，这里只列出来给人看） ---------------- */
  { id: 'editor', group: '正文编辑器', keys: [], display: ['Ctrl', 'B'], label: '加粗', info: true },
  { id: 'editor', group: '正文编辑器', keys: [], display: ['Ctrl', 'I'], label: '斜体', info: true },
  { id: 'editor', group: '正文编辑器', keys: [], display: ['Ctrl', 'E'], label: '行内代码', info: true },
  { id: 'editor', group: '正文编辑器', keys: [], display: ['Ctrl', 'Z'], label: '撤销（Ctrl+Shift+Z 重做）', info: true },
  { id: 'editor', group: '正文编辑器', keys: [], display: ['@'], label: '唤起设定条目补全（双链）', info: true },
  { id: 'editor', group: '正文编辑器', keys: [], display: ['Enter'], label: '选中补全项 / 换行', info: true },

  /* ---------------- 导航 ---------------- */
  // 为什么导航历史有两套键：Bare Alt+←/→ 在 Windows 的 Chrome/Edge 里是浏览器自己的
  // 「后退/前进」，网页不一定抢得回来；Ctrl+Alt+←/→ 没人占，浏览器宿主和桌面端都稳。
  // 两套都认，作者按顺手的那套来。
  { id: 'navBack', group: '导航', keys: ['ArrowLeft'], display: ['Ctrl', 'Alt', '←'], label: '回到上一个编辑位置', ctrl: true, alt: true },
  { id: 'navForward', group: '导航', keys: ['ArrowRight'], display: ['Ctrl', 'Alt', '→'], label: '前进到下一个编辑位置', ctrl: true, alt: true },
  { id: 'navBack', group: '导航', keys: ['ArrowLeft'], display: ['Alt', '←'], label: '同上（备选键）', alt: true, ctrl: false, note: '在浏览器里可能被浏览器的前进/后退占用，桌面端无碍' },
  { id: 'navForward', group: '导航', keys: ['ArrowRight'], display: ['Alt', '→'], label: '同上（备选键）', alt: true, ctrl: false },
  { id: 'view1', group: '导航', keys: ['1'], display: ['Ctrl', '1'], label: '写作视图', ctrl: true },
  { id: 'view2', group: '导航', keys: ['2'], display: ['Ctrl', '2'], label: '看板视图', ctrl: true },
  { id: 'view3', group: '导航', keys: ['3'], display: ['Ctrl', '3'], label: '关系图视图', ctrl: true },
  { id: 'view4', group: '导航', keys: ['4'], display: ['Ctrl', '4'], label: '时间线视图', ctrl: true },
  { id: 'view5', group: '导航', keys: ['5'], display: ['Ctrl', '5'], label: '统计视图', ctrl: true },

  /* ---------------- 章节目录（列表拿到焦点时才生效，由 ChapterTree 自己处理） ---------------- */
  { id: 'tree', group: '章节目录', keys: [], display: ['↑', '↓'], label: '上下移动', info: true },
  { id: 'tree', group: '章节目录', keys: [], display: ['Home', 'End'], label: '跳到第一 / 最后一章', info: true },
  { id: 'tree', group: '章节目录', keys: [], display: ['Enter'], label: '打开选中的章节', info: true },
  { id: 'tree', group: '章节目录', keys: [], display: ['F2'], label: '重命名选中的章节', info: true },
  { id: 'tree', group: '章节目录', keys: [], display: ['←', '→'], label: '折叠 / 展开光标所在的卷', info: true },

  /* ---------------- 界面 ---------------- */
  { id: 'zoomIn', group: '界面', keys: ['=', '+'], display: ['Ctrl', '+'], label: '放大界面', ctrl: true },
  { id: 'zoomOut', group: '界面', keys: ['-'], display: ['Ctrl', '−'], label: '缩小界面', ctrl: true },
  { id: 'zoomReset', group: '界面', keys: ['0'], display: ['Ctrl', '0'], label: '界面缩放复位', ctrl: true },
  { id: 'toggleTheme', group: '界面', keys: ['.'], display: ['Ctrl', '.'], label: '切换 白底 / 护眼 / 夜间', ctrl: true },
  { id: 'help', group: '界面', keys: ['?'], display: ['?'], label: '快捷键一览（Esc 关闭）', ctrl: false, alt: false, outsideEditor: true },
  { id: 'help', group: '界面', keys: ['/'], display: ['Ctrl', '/'], label: '快捷键一览（备选键）', ctrl: true }
]

/** 修饰键是否吻合：true=必须按下，false=必须没按，undefined=不关心 */
function modOk(want: boolean | undefined, got: boolean): boolean {
  if (want === undefined) return true
  return want ? got : !got
}

/**
 * 找一个匹配当前按键的快捷键。
 * `info` 项（编辑器自己管的）不参与派发，直接跳过。
 */
export function matchShortcut(e: KeyLike, opts: { inEditor?: boolean } = {}): Shortcut | null {
  const key = (e.key || '').toLowerCase()
  if (!key) return null
  const mod = !!(e.ctrlKey || e.metaKey)
  for (const s of SHORTCUTS) {
    if (s.info || !s.keys.length) continue
    if (!s.keys.some((k) => k.toLowerCase() === key)) continue
    if (!modOk(s.ctrl, mod)) continue
    if (!modOk(s.alt, !!e.altKey)) continue
    if (!modOk(s.shift, !!e.shiftKey)) continue
    if (opts.inEditor && s.outsideEditor) continue
    return s
  }
  return null
}

/** 显示用：把按键序列拼成 `Ctrl + S` 这种样子；单键原样返回 */
export function formatKeys(display: string[]): string {
  if (!display.length) return ''
  if (display.length === 1) return display[0]
  return display.slice(0, -1).join(' + ') + ' + ' + display[display.length - 1]
}

/** 显示用：给一个 Shortcut 取按键文本（display 优先，兜底 keys 的大写化） */
export function shortcutText(s: Shortcut): string {
  if (s.display.length) return formatKeys(s.display)
  return s.keys.map((k) => (k.length === 1 ? k.toUpperCase() : k)).join(' / ')
}

/** 帮助面板的筛选：空查询返回全部；否则按标签 / 按键 / 分组 / 说明模糊匹配（不区分大小写） */
export function searchShortcuts(q: string): Shortcut[] {
  const needle = (q || '').trim().toLowerCase()
  if (!needle) return SHORTCUTS.slice()
  return SHORTCUTS.filter(
    (s) =>
      s.label.toLowerCase().includes(needle) ||
      s.group.toLowerCase().includes(needle) ||
      shortcutText(s).toLowerCase().includes(needle) ||
      (s.note || '').toLowerCase().includes(needle)
  )
}

/** 帮助面板展示用：按 group 归拢，保持表里的先后顺序 */
export function shortcutGroups(list: Shortcut[] = SHORTCUTS): Array<{ group: string; items: Shortcut[] }> {
  const out: Array<{ group: string; items: Shortcut[] }> = []
  for (const s of list) {
    let g = out.find((x) => x.group === s.group)
    if (!g) {
      g = { group: s.group, items: [] }
      out.push(g)
    }
    g.items.push(s)
  }
  return out
}
