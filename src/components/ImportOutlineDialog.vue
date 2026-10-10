<script setup lang="ts">
/**
 * 导入大纲 / 卷纲 / 章纲
 *
 * 作者手里的结构十有八九躺在 Word 里。这里做的是：选文件（.docx / .md / .txt）
 * → 转成 Markdown → 认出卷章层级 → 作者看着预览选目标 → 落盘。
 *
 * 两条底线：
 * 1. **看清楚再写**：导入前一定给预览，写进哪个文件也写在按钮旁边。
 * 2. **只追加**：目标文件已存在时默认追加在后面，覆盖要作者自己勾。
 */
import { computed, ref, watch } from 'vue'
import { docxToMarkdown } from '@/core/docxRead'
import { applyOutline, parseOutlineText, treeStats, type OutlineMode } from '@/core/importOutline'
import { decodeText } from '@/core/importDoc'
import { DIRS } from '@/core/workspace'
import { refresh, state } from '@/stores/workspace'

const emit = defineEmits<{ (e: 'close'): void }>()

const mode = ref<OutlineMode>('volume')
const text = ref('')
const fileName = ref('')
const source = ref('') // 编码 / 转换说明
const warnings = ref<string[]>([])
const createChapters = ref(true)
const overwrite = ref(false)
const busy = ref(false)
const msg = ref('')
const err = ref('')
const picked = ref<boolean[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const tree = computed(() => parseOutlineText(text.value))
const stats = computed(() => treeStats(tree.value))
const ready = computed(() => text.value.trim().length > 0)

watch(
  tree,
  (t) => {
    picked.value = t.volumes.map(() => true)
  },
  { immediate: true }
)

const pickedVolumes = computed(() => tree.value.volumes.filter((_, i) => picked.value[i]))
const pickedChapters = computed(() => pickedVolumes.value.reduce((n, v) => n + v.chapters.length, 0))

const MODE_HINT: Record<OutlineMode, { label: string; where: string; how: string }> = {
  book: {
    label: '全书大纲',
    where: `${DIRS.outline}/剧情大纲.md`,
    how: '整篇写进大纲文件，AI 续写时会当作最高层上下文。'
  },
  volume: {
    label: '卷纲',
    where: '正文/第XX卷/卷纲.md',
    how: '每卷建目录并写卷纲；卷下的章顺带建成空章（正文不动）。'
  },
  chapter: {
    label: '章纲',
    where: '章节文件里的「本章目标」',
    how: '按章号/标题对上已有章节，只填章纲；对不上的按勾选新建空章。'
  }
}

const hint = computed(() => MODE_HINT[mode.value])

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) await loadFile(f, f.name)
  if (fileInput.value) fileInput.value.value = ''
}

async function loadFile(f: File | Blob, name: string) {
  err.value = ''
  msg.value = '正在读取…'
  warnings.value = []
  try {
    const buf = await f.arrayBuffer()
    if (/\.docx$/i.test(name)) {
      const r = docxToMarkdown(buf)
      if (!r.text.trim()) {
        err.value = '这个 Word 文档里没读到文字（可能是扫描件，或内容都在图片 / 文本框里）。'
        msg.value = ''
        return
      }
      text.value = r.text
      source.value = `Word：${r.paragraphs} 段 · ${r.tables} 张表`
      warnings.value = r.warnings
    } else if (/\.doc$/i.test(name)) {
      err.value = '老版 .doc 是二进制格式读不了 —— 请用 Word 另存为 .docx 或 .md 再来。'
      msg.value = ''
      return
    } else {
      const dec = decodeText(buf)
      text.value = dec.text
      source.value = `文本：${dec.encoding}${dec.suspicious ? '（有乱码风险）' : ''}`
      if (dec.suspicious) warnings.value = [`解码时出现 ${dec.suspicious} 个无法识别的字符，建议先另存为 UTF-8。`]
    }
    fileName.value = name
    msg.value = `读好了：${stats.value.volumes} 卷 · ${stats.value.chapters} 章`
  } catch (e2: any) {
    err.value = `读取失败：${e2?.message || e2}`
    msg.value = ''
  }
}

function toggleAll(v: boolean) {
  picked.value = picked.value.map(() => v)
}

async function doImport() {
  if (!state.ref || !ready.value) return
  busy.value = true
  err.value = ''
  msg.value = '正在写入…'
  try {
    const res = await applyOutline(state.ref, text.value, tree.value, {
      mode: mode.value,
      volumes: state.volumes,
      rootChapters: state.rootChapters,
      createChapters: createChapters.value,
      overwrite: overwrite.value,
      picked: picked.value,
      onProgress: (d, t, label) => (msg.value = `正在写入 ${d}/${t}：${label}`)
    })
    await refresh(false)
    const parts = [`写了 ${res.written.length} 个文件`]
    if (res.volumesCreated) parts.push(`新建 ${res.volumesCreated} 卷`)
    if (res.chaptersCreated) parts.push(`新建 ${res.chaptersCreated} 章`)
    if (res.chaptersUpdated) parts.push(`补了 ${res.chaptersUpdated} 章的章纲`)
    if (res.skipped.length) parts.push(`${res.skipped.length} 项跳过`)
    msg.value = parts.join(' · ')
    if (res.skipped.length) err.value = res.skipped.slice(0, 3).join('；')
  } catch (e: any) {
    err.value = `导入失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>导入大纲 / 卷纲 / 章纲</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="body col">
        <div class="row">
          <button class="primary" :disabled="busy" @click="fileInput?.click()">选择 Word / md 文件</button>
          <input
            ref="fileInput"
            type="file"
            accept=".docx,.md,.markdown,.txt,text/plain"
            class="hidden-file"
            @change="onFile"
          />
          <span v-if="fileName" class="small dim">{{ fileName }}</span>
        </div>
        <p class="small dim">
          选文件，或者把大纲直接粘到下面这个框里 —— 两种办法读进来之后都一样。
        </p>

        <textarea
          v-model="text"
          rows="8"
          class="md"
          spellcheck="false"
          placeholder="把大纲粘在这里，或点上面按钮选 .docx / .md / .txt 文件。&#10;&#10;认层级的方式：# 或「第一卷」= 卷，## 或「第一章」= 章；卷下面的表格（章节 / 目标 / 字数）每行算一章。"
        ></textarea>

        <div v-if="source" class="row small meta">
          <span class="tag dim">{{ source }}</span>
          <span class="tag dim">{{ stats.volumes }} 卷</span>
          <span class="tag dim">{{ stats.chapters }} 章</span>
        </div>

        <div class="row small">
          <span class="nowrap dim">导入为</span>
          <button class="text small" :class="{ on: mode === 'book' }" :disabled="busy" @click="mode = 'book'">全书大纲</button>
          <button class="text small" :class="{ on: mode === 'volume' }" :disabled="busy" @click="mode = 'volume'">卷纲</button>
          <button class="text small" :class="{ on: mode === 'chapter' }" :disabled="busy" @click="mode = 'chapter'">章纲</button>
        </div>
        <p class="small dim">写到：<code>{{ hint.where }}</code> —— {{ hint.how }}</p>

        <div class="row small">
          <label v-if="mode !== 'book'" class="inline">
            <input v-model="createChapters" type="checkbox" :disabled="busy" />
            顺带把章节坑位建出来（只建空章，正文不动）
          </label>
          <label class="inline">
            <input v-model="overwrite" type="checkbox" :disabled="busy" />
            覆盖已有内容（默认追加在后面）
          </label>
        </div>

        <div v-if="ready" class="prev">
          <div class="spread small dim">
            <span v-if="mode === 'book'">预览（整篇写入大纲文件）</span>
            <span v-else>预览（取消勾选可跳过整卷）</span>
            <span v-if="mode !== 'book'">
              <button class="text small" @click="toggleAll(true)">全选</button>
              <button class="text small" @click="toggleAll(false)">全不选</button>
            </span>
          </div>

          <template v-if="mode === 'book'">
            <pre class="plain">{{ text.slice(0, 600) }}{{ text.length > 600 ? '\n…（后面还有）' : '' }}</pre>
          </template>

          <template v-else>
            <label v-for="(v, i) in tree.volumes" :key="i" class="ch-row">
              <input v-model="picked[i]" type="checkbox" style="width: auto" />
              <span class="ch-name">{{ v.name || '（不分卷 → 章节直接进 正文/）' }}</span>
              <span class="small dim nowrap">{{ v.chapters.length }} 章</span>
            </label>
            <div class="tree">
              <div v-for="(v, i) in pickedVolumes" :key="'v' + i" class="vol">
                <b class="small">{{ v.name || '（不分卷）' }}</b>
                <div v-if="mode === 'volume' && v.chapters.length" class="chips">
                  <span v-for="c in v.chapters" :key="c.title" class="chip">{{ c.title }}</span>
                </div>
                <div v-else-if="v.chapters.length" class="chips">
                  <span v-for="c in v.chapters" :key="c.title" class="chip" :title="c.target || c.text">{{
                    c.title
                  }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>

        <p v-for="(w, i) in warnings" :key="i" class="warn-box small">{{ w }}</p>
        <div v-if="msg" class="small dim">{{ msg }}</div>
        <p v-if="err" class="err-box small">{{ err }}</p>

        <div class="row">
          <button class="primary" :disabled="busy || !ready" @click="doImport">
            <template v-if="mode === 'book'">写入全书大纲</template>
            <template v-else-if="mode === 'volume'">导入 {{ pickedVolumes.length }} 卷的卷纲</template>
            <template v-else>导入 {{ pickedChapters }} 条章纲</template>
          </button>
          <button :disabled="busy" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 660px;
  max-height: 86vh;
}
.hidden-file {
  display: none;
}
.md {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  min-height: 150px;
  resize: vertical;
}
label.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-soft);
}
label.inline input {
  width: auto;
}
.meta {
  margin: 8px 0 2px;
  gap: 6px;
}
.prev {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-panel);
  margin: 8px 0;
}
.ch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.ch-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nowrap {
  white-space: nowrap;
}
.tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.chip {
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 1px 6px;
  color: var(--text-dim);
}
.plain {
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
  color: var(--text-soft);
  max-height: 160px;
  overflow: auto;
}
button.text.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.warn-box {
  border: 1px solid var(--note-line);
  background: var(--note-bg);
  color: var(--note-fg);
  padding: 8px 10px;
  border-radius: 4px;
  margin: 6px 0;
}
.err-box {
  border: 1px solid var(--danger-line);
  background: var(--danger-bg);
  color: var(--danger-fg);
  padding: 8px 10px;
  border-radius: 4px;
}
code {
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
