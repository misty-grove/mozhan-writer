<script setup lang="ts">
/**
 * 快捷键一览（P3-D）
 *
 * 表本身住在 core/shortcuts.ts，这里只负责画 —— 之前那种「代码里一套键位、
 * 文档里另一套」的漂移，靠这个结构从根上避免。
 */
import { computed, onMounted, ref } from 'vue'
import { searchShortcuts, shortcutGroups, shortcutText } from '@/core/shortcuts'

const emit = defineEmits<{ (e: 'close'): void }>()

const q = ref('')
const filterBox = ref<HTMLInputElement | null>(null)

const groups = computed(() => shortcutGroups(searchShortcuts(q.value)))
const total = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

onMounted(() => filterBox.value?.focus())
</script>

<template>
  <div class="mask help-mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>快捷键一览</b>
        <button class="btn-icon" title="关闭 Esc" @click="emit('close')">×</button>
      </div>

      <div class="filter row">
        <!-- Esc 必须 .stop：否则全局快捷键监听会同时把面板一起关掉，搜索就永远清不干净 -->
        <input ref="filterBox" v-model="q" placeholder="搜一搜：加粗 / 导航 / Ctrl+P" @keydown.esc.stop="q ? (q = '') : emit('close')" />
        <span class="dim small nowrap">{{ total }} 条</span>
      </div>

      <div class="body">
        <section v-for="g in groups" :key="g.group" class="grp">
          <h4>{{ g.group }}</h4>
          <div v-for="(s, i) in g.items" :key="g.group + i" class="line">
            <kbd>{{ shortcutText(s) }}</kbd>
            <span class="lbl">
              {{ s.label }}
              <em v-if="s.note" class="dim">{{ s.note }}</em>
            </span>
          </div>
        </section>
        <p v-if="!total" class="dim small no-hit">没有匹配的快捷键</p>
      </div>

      <div class="foot small dim">
        快捷键是「按场景」设计的：光标在正文里时，Ctrl+B / Ctrl+E 归加粗与行内代码，
        界面类快捷键只在正文之外生效，不会互相抢键。Mac 上 Ctrl 可用 ⌘ 代替。
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 快捷键面板要在任何打开的对话框之上 —— 它是「我卡住了」时的最后一层求助 */
.mask {
  z-index: 60;
}
.dialog {
  width: 620px;
  max-height: 84vh;
}
.filter {
  padding: 10px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--bg-panel);
}
.grp h4 {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  letter-spacing: 0.05em;
}
.line {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 4px 6px;
  margin: 0 -6px;
  border-radius: 6px;
  font-size: 13px;
  transition: background-color 0.14s ease;
}
.line:hover {
  background: var(--accent-soft);
}
/* 键帽的皮肤在 global.css（同一套 .kbd 也管原生 kbd），这里只给固定宽度 */
kbd {
  flex: 0 0 132px;
}
.lbl em {
  font-style: normal;
  margin-left: 6px;
}
.no-hit {
  text-align: center;
  padding: 22px 16px;
  color: var(--text-dim);
}
.foot {
  line-height: 1.7;
}
</style>
