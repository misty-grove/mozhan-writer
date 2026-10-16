<script setup lang="ts">
/**
 * 「大纲」—— 本书已导入内容的查看窗（功能已汇总进「导入大纲」，这里只管看）。
 *
 * 作者的原话：「导入大纲后可以在大纲页面看本作大纲卷纲」。所以这个窗口做的事只有三件：
 *  ① 列出全书大纲（大纲/剧情大纲.md）
 *  ② 列出每卷的分卷大纲（正文/第X卷/卷纲.md）
 *  ③ 点哪份读哪份（右侧就地阅读，只读）
 *
 * 什么都没有时不再给「生成骨架 / AI 推荐」——那些功能已经搬进「导入大纲」，
 * 这里只留一句实话和一个跳过去的按钮，免得作者在两个入口之间来回猜。
 *
 * 桌面上它是可拖动、可缩放的独立窗口（WinBox）；手机上保持底部抽屉。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { readAsset, readVolumeOutline } from '@/core/workspace'
import { findBookOutlinePath } from '@/core/importOutline'
import { hasRealOutline } from '@/core/worldbuild'
import { mdToSimpleHtml } from '@/core/outlineView'
import { refresh, state } from '@/stores/workspace'
import WinBox from './WinBox.vue'

const emit = defineEmits<{ (e: 'close'): void; (e: 'import-outline'): void }>()

interface OutlineItem {
  key: string
  icon: string
  label: string
  sub: string
  text: string
}

const items = ref<OutlineItem[]>([])
const sel = ref('')
const loading = ref(false)

const current = computed(() => items.value.find((i) => i.key === sel.value) || items.value[0] || null)
const html = computed(() => (current.value ? mdToSimpleHtml(current.value.text) : ''))

/** 全书大纲在不在（从扫描产物里找「作者可见的那份」，与目录树同一判据） */
const bookAsset = computed(() =>
  state.assets.find((a) => a.group === '大纲' && !a.id.includes('.mdAI文件') && /剧情大纲|全书/.test(a.name)) || null
)

async function load() {
  if (!state.ref) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const out: OutlineItem[] = []

    // 全书大纲：只认「有真内容」的（稿纸模板不算，免得点开是个空壳）
    try {
      const path = await findBookOutlinePath(state.ref)
      const text = await readAsset(state.ref, path.join('/'))
      if (hasRealOutline(text)) {
        const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
        out.push({ key: 'book', icon: '📖', label: h || '全书大纲', sub: '大纲/剧情大纲.md', text })
      }
    } catch {
      /* 没有全书大纲 */
    }

    // 每卷的分卷大纲
    for (const v of state.volumes) {
      if (!v.hasOutline) continue
      try {
        const { body, meta } = await readVolumeOutline(state.ref, v.id)
        const full = `# ${v.name}\n\n${body}`
        if (!hasRealOutline(full)) continue
        out.push({
          key: v.id,
          icon: '📑',
          label: v.name,
          sub: meta.target ? `卷目标：${meta.target}` : '分卷大纲',
          text: full
        })
      } catch {
        /* 这卷读不到就跳过 */
      }
    }

    items.value = out
    // 选中项还活着就留着，否则落到第一份（通常是全书大纲）
    if (!out.some((i) => i.key === sel.value)) sel.value = out[0]?.key || ''
  } finally {
    loading.value = false
  }
}

async function reload() {
  await refresh(false)
  await load()
}

// 两条触发线：换作品、大纲文件变化（导入 / 大纲面板写入后 assets 会整个换）
watch([() => state.ref?.id, bookAsset, () => state.volumes], () => void load(), { immediate: true })
onMounted(() => void load())
</script>

<template>
  <WinBox title="大纲" :width="860" :height="560" store-key="outline-view" @close="emit('close')">
    <template #extra>
      <button class="text small" title="重新读一遍磁盘上的大纲" @click="reload">刷新</button>
      <button class="text small" @click="emit('import-outline')">导入大纲</button>
    </template>

    <!-- 空态：一句话说清现状，一个按钮去该去的地方 -->
    <div v-if="!items.length && !loading" class="empty col">
      <p class="dim">这部书还没有可看的大纲。</p>
      <p class="small dim">
        在「导入大纲」里把 Word / md 大纲导进来（或粘进去），这里就会列出
        <b>全书大纲</b> 与 <b>各卷的分卷大纲</b>，点哪份读哪份。
      </p>
      <div class="row">
        <button class="primary" @click="emit('import-outline')">去导入大纲</button>
      </div>
    </div>
    <div v-else-if="loading" class="dim small">读取中…</div>

    <template v-else>
      <!-- 左：清单；右：阅读区。窗口拉窄时清单折到上面，不会把阅读区挤没 -->
      <div class="split">
        <nav class="list">
          <button
            v-for="it in items"
            :key="it.key"
            class="li"
            :class="{ on: current?.key === it.key }"
            @click="sel = it.key"
          >
            <span class="ic">{{ it.icon }}</span>
            <span class="tx">
              <b>{{ it.label }}</b>
              <span class="small dim sub">{{ it.sub }}</span>
            </span>
          </button>
        </nav>
        <article class="reader">
          <div class="rd-head spread">
            <b class="small">{{ current?.label || '' }}</b>
            <span class="small dim">{{ current?.sub }}</span>
          </div>
          <div class="md" v-html="html"></div>
          <div class="small dim rd-foot">只读 —— 要改内容，去「导入大纲」里改完写入，或直接编辑 md 文件</div>
        </article>
      </div>
    </template>
  </WinBox>
</template>

<style scoped>
/* WinBox 的 body 是纵向 flex 容器，这里让主体部分把它撑满 */
.split {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 320px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 216px;
  flex: 0 0 216px;
  overflow: auto;
  max-height: 60vh;
}
.li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  text-align: left;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
}
.li:hover {
  background: var(--bg-hover);
}
.li.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.li .tx {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.li b {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.li .sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ic {
  flex: 0 0 auto;
}
.reader {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-panel);
  overflow: hidden;
}
.rd-head {
  padding: 7px 11px;
  border-bottom: 1px solid var(--line-soft);
}
.md {
  flex: 1;
  overflow: auto;
  padding: 10px 13px;
  font-size: 13.5px;
  line-height: 1.75;
}
.md :deep(h1) {
  font-size: 16px;
  margin: 0 0 8px;
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
.md :deep(code) {
  background: var(--line-soft);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
}
.rd-foot {
  padding: 6px 11px;
  border-top: 1px solid var(--line-soft);
}
.empty {
  gap: 6px;
  padding: 22px 12px;
  align-items: flex-start;
}
.empty p {
  margin: 0;
  line-height: 1.7;
}
/* 手机：清单改横排滚动，别占掉半屏 */
@media (max-width: 640px) {
  .split {
    flex-direction: column;
  }
  .list {
    width: auto;
    flex: 0 0 auto;
    flex-direction: row;
    max-height: none;
    overflow-x: auto;
  }
  .li {
    flex: 0 0 auto;
  }
}
</style>
