<script setup lang="ts">
/**
 * 应用内对话框宿主：整个应用只挂一个（在 App.vue 里），
 * 谁要弹窗就 `await askText(...)` / `await askConfirm(...)`。
 *
 * 键盘按原生习惯来：Enter 提交（多行时不劫持）、Esc 取消、遮罩点击取消。
 * 打开时输入框自动聚焦并全选 —— 默认值就是拿来被替换的。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { cancelDialog, confirmDialog, dialogState, setDialogInput } from '@/stores/dialog'

const box = ref<HTMLInputElement | null>(null)
const panel = ref<HTMLElement | null>(null)

/** 值住在 store 里，写回时顺带跑校验 */
const input = computed({
  get: () => dialogState.current?.input ?? '',
  set: (v: string) => setDialogInput(v)
})

const canSubmit = () => {
  const cur = dialogState.current
  if (!cur) return false
  return cur.kind === 'confirm' || !cur.error
}

function submit() {
  if (!canSubmit()) return
  confirmDialog()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelDialog()
    return
  }
  if (e.key === 'Enter') {
    // 确认框也认 Enter —— 焦点万一不在按钮上（比如刚点过遮罩）也能直接确认。
    // 这里必须 preventDefault：焦点就在按钮上时，浏览器默认还会补一次 click，
    // 不拦住就会提交两遍（删除类操作提交两遍的后果不用多说）。
    e.preventDefault()
    submit()
    return
  }
  // 两个按钮 + 输入框之间循环 Tab，别让焦点跑到底下运行着的写作界面上去
  if (e.key === 'Tab') {
    const items = Array.from(panel.value?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || [])
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 || at < 0 ? 0 : at + 1)
    e.preventDefault()
    items[next].focus()
  }
}

// 换一个请求就重新聚焦：连开两个弹窗时焦点不能留在上一个上
watch(
  () => dialogState.current?.id,
  async (id) => {
    if (!id) return
    await nextTick()
    const cur = dialogState.current
    if (!cur) return
    if (cur.kind === 'text' && box.value) {
      box.value.focus()
      box.value.select()
    } else {
      // 确认框把焦点放到「确定」上，回车即可确认
      panel.value?.querySelector<HTMLElement>('button.primary, button.danger')?.focus()
    }
  }
)
</script>

<template>
  <div v-if="dialogState.current" class="dlg-mask" @click.self="cancelDialog()" @keydown="onKey">
    <div
      ref="panel"
      class="dlg"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogState.current.title"
    >
      <div class="dlg-head">
        <b>{{ dialogState.current.title }}</b>
      </div>

      <div class="dlg-body">
        <template v-if="dialogState.current.kind === 'text'">
          <label v-if="dialogState.current.label" class="small dim">{{ dialogState.current.label }}</label>
          <input
            ref="box"
            v-model="input"
            class="dlg-input"
            :placeholder="dialogState.current.placeholder"
            :maxlength="dialogState.current.maxLength > 0 ? dialogState.current.maxLength : undefined"
            spellcheck="false"
          />
          <p v-if="dialogState.current.touched && dialogState.current.error" class="dlg-err small">
            {{ dialogState.current.error }}
          </p>
          <p v-else-if="dialogState.current.hint" class="small dim">{{ dialogState.current.hint }}</p>
        </template>

        <template v-else>
          <p v-if="dialogState.current.message" class="dlg-msg">{{ dialogState.current.message }}</p>
          <ul v-if="dialogState.current.detail.length" class="dlg-detail">
            <li v-for="(d, i) in dialogState.current.detail" :key="i">{{ d }}</li>
          </ul>
        </template>
      </div>

      <div class="dlg-foot">
        <button class="text small" @click="cancelDialog()">{{ dialogState.current.cancelText }}</button>
        <button
          class="small"
          :class="dialogState.current.danger ? 'danger' : 'primary'"
          :disabled="!canSubmit()"
          @click="submit()"
        >
          {{ dialogState.current.okText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 17, 18, 0.34);
  /* 背后轻微失焦：既说明「现在只问你这一个」，又不至于把正在写的那段稿糊掉 */
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* 比其它弹窗高一层：它是「操作的中断点」，必须压在最上面 */
  z-index: 80;
  animation: ui-fade-in 0.16s ease both;
}
.dlg {
  width: 420px;
  max-width: 100%;
  max-height: 100%;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-3);
  animation: ui-pop-in 0.2s cubic-bezier(0.16, 0.84, 0.44, 1) both;
}
.dlg-head {
  padding: 13px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  border-radius: 9px 9px 0 0;
  font-size: 13.5px;
}
.dlg-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  overflow: auto;
}
.dlg-input {
  font-size: 13px;
}
.dlg-err {
  color: var(--danger);
  margin: 0;
}
.dlg-msg {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}
.dlg-detail {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.8;
}
.dlg-detail li {
  list-style: none;
  position: relative;
  padding-left: 12px;
}
/* 用点代替默认的圆点：这里列的是「要被影响的东西」，读起来要慢一点才安全 */
.dlg-detail li::before {
  content: '·';
  position: absolute;
  left: 0;
  color: var(--accent);
  font-weight: 600;
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-panel);
  border-radius: 0 0 9px 9px;
}
.dlg-foot button {
  min-width: 76px;
  padding: 6px 14px;
}
</style>
