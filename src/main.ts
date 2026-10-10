import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import { installSaveGuards } from './stores/workspace'

// 先把「离开前把稿子写下去」的守卫装好，再挂载界面：
// 万一挂载过程中出错，至少关窗保护是生效的。
installSaveGuards()

createApp(App).use(createPinia()).mount('#app')

// 开发/验收用的调试出口：把几个模块级 store 挂到 window 上。
//
// 为什么需要它：有些状态是**模块级 reactive**（最典型的是 `aiState.candidates`），
// 它们不落盘、也没有 UI 之外的写入口 —— 端到端验收想验「候选删得掉吗」就只能
// 干等一次真网络请求，既慢又不稳。挂个出口，验收脚本可以直接塞两张候选进去，
// 然后点真实的删除按钮，验「删得掉」这个**行为**本身。
//
// 触发条件是 `DEV` 或 `VITE_E2E=1`：
//  - DEV：`npm run dev` 起的开发服务器；
//  - VITE_E2E：`scripts/e2e/run.mjs` 在构建时注入（它跑的是 `vite build` +
//    `vite preview`，MODE 在构建时就被定成 production，光靠 MODE 判断拿不到出口）。
// 正式出包（`npm run build`）两个条件都不满足，产物里没有这一段。
const e2eHook = import.meta.env.DEV || import.meta.env.VITE_E2E === '1'
if (e2eHook) {
  Promise.all([import('./stores/ai'), import('./stores/workspace'), import('./stores/editor')]).then(
    ([ai, ws, editor]) => {
      ;(window as any).__writerDev = {
        aiState: ai.aiState,
        openWork: ws.openWork,
        closeWork: ws.closeWork,
        editorState: editor.editorState
      }
    }
  )
}
