/**
 * 应用内对话框：请求描述 + 校验。
 *
 * 这层是纯函数（不碰 DOM、不碰 vue），弹窗状态在 `stores/dialog.ts`，
 * 渲染在 `components/AppDialog.vue`。
 *
 * 为什么不用 window.prompt / window.confirm：
 *  - 样式不可控，跟界面主题（尤其夜间）完全不搭，看起来像另一个软件；
 *  - 桌面壳 / 部分 WebView 会直接把它们禁掉，调用处静默失败 ——
 *    用户点了「新建章节」，什么也没发生，也没报错，这是最难查的一类 bug；
 *  - 只能塞一整句话，没法把「这次删除会影响什么」排成清单。
 */

export type AskKind = 'text' | 'confirm'

export interface AskTextOptions {
  title: string
  /** 输入框上方的说明，一句话 */
  label?: string
  /** 初始值（打开时全选，直接打字即替换） */
  value?: string
  placeholder?: string
  /** 输入框下方的补充说明 */
  hint?: string
  okText?: string
  cancelText?: string
  maxLength?: number
  /** 允许留空（默认不允许） */
  allowEmpty?: boolean
  /** 返回非空字符串即为错误文案，此时「确定」点不动 */
  validate?: (v: string) => string | null
}

export interface AskConfirmOptions {
  title: string
  message?: string
  /** 逐条列出的影响，比一整段话更适合「删掉了什么」 */
  detail?: string[]
  okText?: string
  cancelText?: string
  /** 破坏性操作：确定按钮走危险色，默认文案变「删除」 */
  danger?: boolean
}

/** 输入闸门：文本弹窗的提交条件 */
export interface AskGate {
  allowEmpty: boolean
  maxLength: number
  validate?: (v: string) => string | null
}

export interface NormalizedAsk {
  kind: AskKind
  title: string
  label: string
  value: string
  placeholder: string
  hint: string
  okText: string
  cancelText: string
  maxLength: number
  message: string
  detail: string[]
  danger: boolean
  gate: AskGate
}

/** 危险操作的默认按钮文案；其余一律「确定」 */
export function suggestOkText(kind: AskKind, danger = false): string {
  if (danger) return '删除'
  return kind === 'text' ? '确定' : '确定'
}

/**
 * 输入校验：返回 null 表示可以提交。
 *
 * 顺序是「先看长度、再看空、最后交给调用方」，这样空值报的是「不能为空」，
 * 而不会被自定义校验器抢先说成「太短」之类更绕的话。
 */
export function checkInput(value: string, gate: AskGate): string | null {
  const v = value ?? ''
  if (gate.maxLength > 0 && v.length > gate.maxLength) return `最多 ${gate.maxLength} 个字（当前 ${v.length}）`
  if (!gate.allowEmpty && !v.trim()) return '不能为空'
  return gate.validate ? gate.validate(v) : null
}

/** 当前的输入能不能提交（确认框永远能提交） */
export function isSubmittable(ask: NormalizedAsk, input?: string): boolean {
  if (ask.kind === 'confirm') return true
  return checkInput(input ?? ask.value, ask.gate) === null
}

/** 建章时输入框的提示：留空会得到什么名字，明说，别让人猜 */
export function chapterPlaceholder(order: number): string {
  return `留空则为「第${String(order).padStart(3, '0')}章」`
}

function normalizeCommon(o: { title?: string; okText?: string; cancelText?: string; danger?: boolean }, kind: AskKind) {
  const danger = !!o.danger
  const title = String(o.title || '').trim()
  const okText = String(o.okText || '').trim()
  const cancelText = String(o.cancelText || '').trim()
  return {
    kind,
    danger,
    title: title || (kind === 'text' ? '请输入' : '请确认'),
    okText: okText || suggestOkText(kind, danger),
    cancelText: cancelText || '取消'
  }
}

export function normalizeTextAsk(o: AskTextOptions): NormalizedAsk {
  const maxLength = Math.max(0, Math.floor(o.maxLength ?? 0))
  const gate: AskGate = { allowEmpty: !!o.allowEmpty, maxLength }
  if (o.validate) gate.validate = o.validate
  return {
    ...normalizeCommon(o, 'text'),
    label: o.label || '',
    value: o.value || '',
    placeholder: o.placeholder || '',
    hint: o.hint || '',
    maxLength,
    message: '',
    detail: [],
    gate
  }
}

export function normalizeConfirmAsk(o: AskConfirmOptions): NormalizedAsk {
  return {
    ...normalizeCommon(o, 'confirm'),
    label: '',
    value: '',
    placeholder: '',
    hint: '',
    maxLength: 0,
    message: o.message || '',
    detail: Array.isArray(o.detail) ? o.detail.map((d) => String(d || '')).filter((d) => d.trim()) : [],
    gate: { allowEmpty: true, maxLength: 0 }
  }
}
