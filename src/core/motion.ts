/**
 * 动效的方向判定（纯逻辑）。
 *
 * 为什么单独放一个 core 模块：**方向是算出来的，不是写死的**。
 * 写作 → 看板要往左推、看板 → 写作要往右推，靠的是「两个视图在顺序表里的相对位置」。
 * 这是个纯函数，能在没有浏览器的 Node 里断言（selfcheck §43），样式那边只负责
 * 照着一组固定的 class 名演。判定逻辑只有这一份，改顺序表不用去翻 CSS。
 *
 * 时长不在这里 —— 它们定义在 global.css 的 `html { --motion-* }` 里。
 * 那样只有一个来源：Vue 是靠**读 CSS 算出来的时长**决定何时把旧元素摘掉的，
 * JS 里再放一份数字，两边一漂就会出现「动画没演完元素就没了」。
 */

/** `left` = 新内容从右边推进来（往后翻）；`right` = 从左边推进来（往前翻） */
export type SlideDir = 'left' | 'right'

/**
 * 算出该往哪边推。
 *
 * 表里找不到（比如从别处直接把 view 设成一个没登记的值）就默认 `left` ——
 * 方向错了只是不好看，没必要为此让切换功能整个挂掉。
 */
export function slideDirection(from: string, to: string, order: readonly string[]): SlideDir {
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  if (a < 0 || b < 0 || a === b) return 'left'
  return b > a ? 'left' : 'right'
}

/** 顺序表 → 查表用的数组。视图表在别处维护，这里只负责取出顺序。 */
export function orderOf<T extends { k: string }>(list: readonly T[]): string[] {
  return list.map((x) => x.k)
}
