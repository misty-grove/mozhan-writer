<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { currentChapter, makeSnapshot, markDirty, readSnap, saveNow, selectChapter, snapshots, state } from '@/stores/workspace'
import { applyApi } from '@/stores/editor'
import { countWords, diffLines } from '@/core/util'
import { askConfirm } from '@/stores/dialog'

const emit = defineEmits<{ (e: 'close'): void }>()
const list = ref<any[]>([])
const compareId = ref('')
const diff = ref<any[]>([])

async function load() {
  if (!currentChapter.value) return
  list.value = await snapshots(currentChapter.value.id)
}

watch(() => currentChapter.value?.id, load, { immediate: true })

async function create() {
  if (!currentChapter.value) return
  await makeSnapshot(currentChapter.value.id, 'manual')
  await load()
}

async function compare(name: string) {
  compareId.value = name
  const old = await readSnap(currentChapter.value!.id, name)
  diff.value = diffLines(old.split('\n---\n').pop() || old, state.content)
}

async function restore(name: string) {
  const ok = await askConfirm({
    title: '回滚到这个快照',
    message: '当前这一章的正文会被快照内容替换。',
    detail: [`快照：${name}`, '回滚前的正文会先自动存一份快照，找得回来'],
    okText: '回滚',
    danger: true
  })
  if (!ok) return
  const old = await readSnap(currentChapter.value!.id, name)
  const body = old.replace(/^---[\s\S]*?---\r?\n/, '')
  await selectChapter(currentChapter.value!.id, true)
  // 必须走编辑器。编辑器只在 currentId **变化**时从 state.content 同步一次，
  // 而这里 id 没变 —— 只改 state.content 的话屏幕上还是回滚前的正文，
  // 下一个按键/自动保存就按旧正文把回滚覆盖回去（静默丢改动）。
  const api = applyApi.value
  if (api) {
    api.setContent(body)
  } else {
    // 编辑器不在（人在看板 / 关系图，快照面板还开着）：镜像就是唯一真相，
    // 切回写作视图时编辑器会按 state.content 重新初始化，正好读到这段。
    markDirty(body)
    await saveNow()
  }
  emit('close')
}

const added = computed(() => diff.value.filter((d) => d.type === 'add').length)
const removed = computed(() => diff.value.filter((d) => d.type === 'del').length)
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>版本快照 · {{ currentChapter?.title }}</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>
      <div class="body">
        <div class="row">
          <button class="primary" @click="create">创建快照</button>
          <span class="small dim">自动快照约每 10 分钟一次，每章保留最近 20 个</span>
        </div>
        <div class="list">
          <div v-for="s in list" :key="s.name" class="spread row item">
            <div class="row">
              <span class="tag small" :class="s.kind === 'manual' ? 'info' : ''">{{ s.kind === 'manual' ? '手动' : '自动' }}</span>
              <span class="small">{{ s.time }}</span>
              <span class="dim small">{{ s.words }} 字</span>
            </div>
            <div class="row">
              <button class="text small" @click="compare(s.name)">对比</button>
              <button class="text small" @click="restore(s.name)">回滚</button>
            </div>
          </div>
          <div v-if="!list.length" class="small dim">还没有快照。写上一会儿或点上面的按钮。</div>
        </div>
        <template v-if="diff.length">
          <hr />
          <div class="small dim">与 {{ compareId }} 的差异：+{{ added }} / -{{ removed }} 行</div>
          <div class="diff">
            <div v-for="(d, i) in diff" :key="i" class="line" :class="d.type">
              <span class="mk">{{ d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ' }}</span>
              <span>{{ d.text || ' ' }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 620px;
  max-height: 80vh;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow: auto;
}
.item {
  padding: 4px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
}
.diff {
  border: 1px solid var(--line-soft);
  max-height: 300px;
  overflow: auto;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
  padding: 6px 8px;
}
.line {
  white-space: pre-wrap;
}
.line.add {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
.line.del {
  background: var(--danger-bg);
  color: var(--danger-fg);
}
.mk {
  display: inline-block;
  width: 16px;
  color: var(--text-dim);
}
</style>
