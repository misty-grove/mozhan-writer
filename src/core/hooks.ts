/**
 * 跨 store 的钩子登记处。
 *
 * 为什么要有这个文件：`stores/ai.ts` 已经 `import * as wsStore from './workspace'`，
 * 而换作品时又需要反过来通知 AI 层重置状态 —— 直接在 workspace.ts 里 import ai.ts
 * 就成环了。ESM 能容忍一部分环，但**环上的初始化顺序不确定**，表现是
 * 「有时能用、改个 import 顺序就炸」这类极难复现的问题。
 *
 * 解法与 `applyApi` 同源：**注册表放 core，两侧都只依赖 core**。
 *   stores/workspace.ts  →  调 runWorkResetHooks()   （只依赖 core）
 *   stores/ai.ts         →  onWorkReset(resetForWork)（只依赖 core）
 *
 * 注意注册表本身不认识任何 store，只是一组函数。
 */
export type WorkResetHook = () => void

const hooks: WorkResetHook[] = []

/** 登记一个「换作品 / 关作品时要清状态」的回调，返回注销函数 */
export function onWorkReset(fn: WorkResetHook): () => void {
  hooks.push(fn)
  return () => {
    const i = hooks.indexOf(fn)
    if (i >= 0) hooks.splice(i, 1)
  }
}

/**
 * 通知所有登记过的回调。
 *
 * 单个回调抛异常不能连累其它回调 —— 状态清理是「尽力而为」的事，
 * 一个 store 清理失败不该让换作品整个失败（那样作者会被卡在旧作品上）。
 */
export function runWorkResetHooks() {
  for (const fn of hooks.slice()) {
    try {
      fn()
    } catch (e) {
      console.warn('[work-reset] 钩子执行失败：', e)
    }
  }
}
