<script setup lang="ts">
/**
 * 大纲翻阅窗（只读）。
 *
 * 写作时想看一眼「这卷到底要发生什么」「全书主线是什么」—— 以前得记住去
 * 资料面板里翻文件，现在目录树顶端就是全书大纲、每卷第一章上头就是分卷大纲，
 * 点开就能读，读完 Esc 关掉接着写。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { mdToSimpleHtml } from '@/core/outlineView'

const props = defineProps<{ title: string; text: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const html = computed(() => mdToSimpleHtml(props.text))
const empty = computed(() => !props.text.trim())

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog ov">
      <div class="spread head">
        <b>{{ title }}</b>
        <button class="btn-icon" title="关闭（Esc）" @click="emit('close')">×</button>
      </div>
      <div class="body">
        <div v-if="empty" class="dim small">这份大纲还是空的。</div>
        <div v-else class="md" v-html="html"></div>
      </div>
      <div class="foot">
        <span class="grow"></span>
        <span class="small dim">只读 · 改动请回大纲面板或直接改文件</span>
        <button @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov {
  width: 640px;
  max-height: 82vh;
}
.md {
  font-size: 13.5px;
  line-height: 1.75;
}
.md :deep(h2) {
  font-size: 15px;
  margin: 14px 0 6px;
}
.md :deep(h3) {
  font-size: 14px;
  margin: 12px 0 4px;
}
.md :deep(h4) {
  font-size: 13px;
  margin: 10px 0 4px;
  color: var(--text-soft);
}
.md :deep(p) {
  margin: 6px 0;
}
.md :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12.5px;
  width: 100%;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.md :deep(th) {
  background: var(--bg-panel);
  white-space: nowrap;
}
.md :deep(ul) {
  margin: 6px 0;
  padding-left: 20px;
}
.md :deep(li) {
  margin: 2px 0;
}
.md :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--line);
  color: var(--text-soft);
}
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 12px 0;
}
.md :deep(code) {
  background: var(--line-soft);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
}
</style>
