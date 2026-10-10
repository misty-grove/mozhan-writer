<script setup lang="ts">
/**
 * 沙盒面板（P3-F）
 *
 * 降级模式下，「保存」这个词是有歧义的：自动保存只写进浏览器的内存/IndexedDB，
 * 磁盘上什么都没有。这个面板就是把这层歧义讲清楚的地方 ——
 * 上面是「磁盘上已有什么」，中间是「现在差多少」，下面是两个导出按钮。
 */
import { computed, ref } from 'vue'
import { discardSandbox, exportSandbox, leaveSandbox, sandbox } from '@/stores/sandbox'
import { askConfirm } from '@/stores/dialog'
import { closeWork } from '@/stores/workspace'

const emit = defineEmits<{ (e: 'close'): void }>()
const msg = ref('')
const err = ref('')
const busy = ref(false)

const d = computed(() => sandbox.diff)
const dirtyList = computed(() => [...d.value.added.map((p) => ['新增', p] as const), ...d.value.changed.map((p) => ['修改', p] as const)])
const shortList = computed(() => dirtyList.value.slice(0, 30))

const originText = computed(() => {
  if (sandbox.origin === 'import') return '从本机文件夹导入'
  if (sandbox.origin === 'created') return '在沙盒里新建'
  if (sandbox.origin === 'restored') return '从浏览器存储恢复'
  return '沙盒'
})

async function run(scope: 'all' | 'changed') {
  busy.value = true
  err.value = ''
  try {
    const r = await exportSandbox(scope)
    if (r.ok) msg.value = r.text
    else err.value = r.text
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function exit() {
  await leaveSandbox()
  closeWork()
  emit('close')
}

async function discard() {
  const ok = await askConfirm({
    title: '丢弃浏览器里的这份沙盒',
    message: '浏览器里保存的沙盒副本会被删掉。',
    detail: [
      `作品：${sandbox.name}`,
      d.value.count ? `其中 ${d.value.count} 个文件还没导出，丢了就找不回` : '当前没有未导出的改动',
      '磁盘上原来的文件夹不受影响，一直是原样'
    ],
    okText: '丢弃',
    danger: true
  })
  if (!ok) return
  await discardSandbox()
  closeWork()
  emit('close')
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog sbx">
      <div class="spread head">
        <b>沙盒模式 · {{ sandbox.name }}</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="body">
        <p class="small dim">
          这个浏览器拿不到本机文件夹的写权限，所以改动先落在浏览器里。<b>只有点了下面的导出，磁盘上的文件才会变。</b>
        </p>

        <div class="stat">
          <span class="tag" :class="d.count ? 'warn' : 'info'">{{ d.count ? '未导出' : '已对齐' }}</span>
          <span class="small">{{ d.count ? `新增 ${d.added.length} · 修改 ${d.changed.length} · 删除 ${d.removed.length}` : `${d.total} 个文件都在磁盘上` }}</span>
          <span class="grow"></span>
          <span class="small dim">{{ originText }} · 共 {{ d.total }} 个文件</span>
        </div>

        <p v-if="sandbox.mirrored" class="small dim">
          浏览器里另存了一份，防手滑刷新用。<b>它不是磁盘上的那份。</b>
        </p>
        <p v-else class="small dim">
          浏览器里存不下镜像（隐私模式 / 空间不足），刷新会丢 —— 记得导出留底。
        </p>

        <div class="row">
          <button class="primary" :disabled="busy" @click="run('all')">导出全部 {{ d.total }} 个文件</button>
          <button :disabled="busy || !d.dirty.length" @click="run('changed')">仅导出改动的 {{ d.dirty.length }} 个</button>
          <span class="grow"></span>
          <span class="small dim" v-if="sandbox.lastExportAt">上次导出 {{ sandbox.lastExportAt }}</span>
        </div>

        <p v-if="msg" class="ok-box small">{{ msg }}</p>
        <p v-if="err" class="err-box small">{{ err }}</p>

        <template v-if="dirtyList.length">
          <div class="sec-title small">这些文件与磁盘不一样</div>
          <div class="list small">
            <div v-for="[kind, path] in shortList" :key="path" class="row item">
              <span class="tag small" :class="kind === '新增' ? 'info' : 'warn'">{{ kind }}</span>
              <span class="path">{{ path }}</span>
            </div>
            <div v-if="dirtyList.length > shortList.length" class="dim">…还有 {{ dirtyList.length - shortList.length }} 个</div>
          </div>
        </template>

        <template v-if="d.removed.length">
          <div class="sec-title small">沙盒里删掉了、但磁盘上还在</div>
          <p class="small dim">压缩包表达不了「删除」，解压覆盖不会替你删文件。这几条要自己到磁盘上删：</p>
          <div class="list small">
            <div v-for="p in d.removed" :key="p" class="item path">{{ p }}</div>
          </div>
        </template>

        <template v-if="sandbox.skipped.length">
          <div class="sec-title small">没有进沙盒的文件（{{ sandbox.skipped.length }} 个）</div>
          <p class="small dim">非文本素材（插图、字体等）不参与导入导出，它们一直留在你原来的文件夹里。</p>
          <div class="list small">
            <div v-for="p in sandbox.skipped.slice(0, 12)" :key="p" class="item path">{{ p }}</div>
            <div v-if="sandbox.skipped.length > 12" class="dim">…还有 {{ sandbox.skipped.length - 12 }} 个</div>
          </div>
        </template>

        <hr />
        <div class="row">
          <button @click="exit">退出沙盒（浏览器里保留一份）</button>
          <button class="danger" @click="discard">丢弃沙盒</button>
          <span class="grow"></span>
          <span class="small dim">退出后可以在首页重新导入原文件夹</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 640px;
  max-height: 82vh;
}
.stat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--bg-panel);
}
.sec-title {
  font-weight: 600;
  color: var(--text-soft);
  margin-top: 2px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow: auto;
}
.item {
  padding: 3px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
}
.path {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.grow {
  flex: 1;
}
.ok-box,
.err-box {
  border: 1px solid var(--ok-line, var(--line));
  background: var(--ok-bg);
  color: var(--ok-fg);
  padding: 6px 10px;
  border-radius: 4px;
}
.err-box {
  border-color: var(--danger-line);
  background: var(--danger-bg);
  color: var(--danger);
}
</style>
