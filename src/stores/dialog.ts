/**
 * 应用内对话框的运行时状态。
 *
 * 调用方式跟 `window.prompt` 几乎一样，所以老的调用点改一行就行：
 *
 *   const t = await askText({ title: '新建章节', placeholder: '留空则为「第005章」' })
 *   if (t === null) return          // 取消
 *
 * 为什么是「队列」而不是「当前这一个」：如果某个调用点在一次异步流程里连开两个
 * 确认框，后者会把前者挤掉，前一个 Promise 永远不 resolve（await 卡死、静默丢操作）。
 * 队列只有十几行，换来的是「绝不会丢请求」。
 */
import { reactive } from 'vue'
import {
  checkInput,
  normalizeConfirmAsk,
  normalizeTextAsk,
  type AskConfirmOptions,
  type AskTextOptions,
  type NormalizedAsk
} from '@/core/dialog'

export interface PendingAsk extends NormalizedAsk {
  /** 自增序号：AppDialog 靠它知道「换了一个请求」，好重新聚焦/全选 */
  id: number
  /** 输入框的当前值（仅 text） */
  input: string
  /** 当前校验错误，空串表示可以提交（驱动「确定」的禁用态） */
  error: string
  /**
   * 用户是否已经碰过这个弹窗（打过字 or 点过确定）。
   * 错误文案要等这个为真才显示 —— 不然刚打开就飘一行红的「不能为空」，
   * 明明是还没开始填，看起来却像已经填错了。
   */
  touched: boolean
}

export const dialogState = reactive({
  current: null as PendingAsk | null,
  /** 一共弹出过几次 —— 冒烟/e2e 靠它确认「确实走了应用内弹窗」 */
  count: 0
})

let seq = 0
let resolveCurrent: ((v: unknown) => void) | null = null
const queue: Array<() => void> = []

function enqueue(ask: NormalizedAsk): Promise<unknown> {
  return new Promise((resolve) => {
    const job = () => {
      const pending: PendingAsk = { ...ask, id: ++seq, input: ask.value, error: '', touched: false }
      pending.touched = !!ask.value
      pending.error = checkInput(pending.input, pending.gate) ?? ''
      resolveCurrent = resolve
      dialogState.current = pending
      dialogState.count++
    }
    if (dialogState.current) queue.push(job)
    else job()
  })
}

/** 收尾：先开下一个（如果有），再 resolve 上一个 —— 顺序反过来的话，
 *  上一个的后续代码若又开了个弹窗，就会和队列里那个撞在一起 */
function finish(result: unknown) {
  const r = resolveCurrent
  resolveCurrent = null
  dialogState.current = null
  const next = queue.shift()
  if (next) next()
  if (r) r(result)
}

/** 问一句文本。返回 trim 后的内容；点取消返回 null */
export function askText(opts: AskTextOptions): Promise<string | null> {
  return enqueue(normalizeTextAsk(opts)) as Promise<string | null>
}

/** 问一句「确定吗」。确定 true，取消 false */
export function askConfirm(opts: AskConfirmOptions): Promise<boolean> {
  return enqueue(normalizeConfirmAsk(opts)) as Promise<boolean>
}

/** 改输入（AppDialog 的 v-model 走这里，顺便实时校验） */
export function setDialogInput(v: string) {
  const cur = dialogState.current
  if (!cur) return
  cur.input = v
  cur.touched = true
  cur.error = checkInput(v, cur.gate) ?? ''
}

/**
 * 点「确定」。文本弹窗校验没过就留在原地并把错误亮出来 —— 返回 false 让调用处知道没提交。
 */
export function confirmDialog(): boolean {
  const cur = dialogState.current
  if (!cur) return false
  if (cur.kind === 'text') {
    const err = checkInput(cur.input, cur.gate)
    if (err) {
      cur.error = err
      cur.touched = true
      return false
    }
    const v = cur.input.trim()
    finish(v)
    return true
  }
  finish(true)
  return true
}

/** 点「取消」/ 按 Esc / 点遮罩：文本返回 null，确认返回 false */
export function cancelDialog(): boolean {
  const cur = dialogState.current
  if (!cur) return false
  finish(cur.kind === 'text' ? null : false)
  return true
}

/** 测试用：清掉队列与当前弹窗，免得两条用例互相污染 */
export function resetDialog() {
  const r = resolveCurrent
  resolveCurrent = null
  dialogState.current = null
  dialogState.count = 0
  queue.length = 0
  if (r) r(null)
}
