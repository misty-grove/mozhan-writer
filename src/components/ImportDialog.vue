<script setup lang="ts">
/**
 * 导入已有稿件（P3-B）
 *
 * 作者多半不是从空白文档开始写的 —— 手上已经有几十万字的 txt。
 * 这一步负责把它搬进来：认编码 → 切章 → 预览 → 落盘，全程离线、0 token。
 * 导入只往 正文/ 追加，绝不覆盖已有章节。
 */
import { computed, onMounted, ref } from 'vue'
import {
  decodeText,
  importChapters,
  listLooseTxt,
  splitChapters,
  type ImportChapter,
  type SplitMode
} from '@/core/importDoc'
import fs from '@/platform'
import { newChapter, refresh, selectChapter, state } from '@/stores/workspace'

const emit = defineEmits<{ (e: 'close'): void; (e: 'import-outline'): void }>()

const mode = ref<SplitMode>('auto')
const customPattern = ref('')
const volumeName = ref('')
const busy = ref(false)
const msg = ref('')
const err = ref('')

const fileName = ref('')
const encoding = ref('')
const suspicious = ref(0)
const chapters = ref<ImportChapter[]>([])
const picked = ref<boolean[]>([])
const loose = ref<string[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const kept = computed(() => chapters.value.filter((_, i) => picked.value[i]))
const keptWords = computed(() => kept.value.reduce((s, c) => s + c.words, 0))
const totalWords = computed(() => chapters.value.reduce((s, c) => s + c.words, 0))

onMounted(async () => {
  if (!state.ref) return
  try {
    loose.value = await listLooseTxt(state.ref)
  } catch {
    loose.value = []
  }
})

function setPlan(list: ImportChapter[]) {
  chapters.value = list
  picked.value = list.map(() => true)
}

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  await loadFile(f, f.name)
}

async function loadFile(f: File | Blob, name: string) {
  err.value = ''
  msg.value = '正在识别…'
  try {
    // 二进制只解一次：编码判定 → 文本留存 → 切章
    const dec = decodeText(await f.arrayBuffer())
    encoding.value = dec.encoding
    suspicious.value = dec.suspicious
    fileName.value = name
    pendingText.value = dec.text
    setPlan(splitChapters(dec.text, { mode: mode.value, customPattern: customPattern.value, singleTitle: dropExt(name) }))
    msg.value = `识别完成：${chapters.value.length} 章 · ${totalWords.value.toLocaleString()} 字`
  } catch (e: any) {
    err.value = `读取失败：${e?.message || e}`
    msg.value = ''
  }
}

// 保留文本以便切换切章方式时免重新选文件
const pendingText = ref<string | null>(null)

async function loadLoose(rel: string) {
  if (!state.ref) return
  err.value = ''
  try {
    const text = await fs().readFile(state.ref, rel.split('/'))
    fileName.value = rel
    encoding.value = '按宿主解码（目录内文件）'
    suspicious.value = 0
    pendingText.value = text
    setPlan(splitChapters(text, { mode: mode.value, customPattern: customPattern.value, singleTitle: dropExt(rel) }))
    msg.value = `识别完成：${chapters.value.length} 章`
  } catch (e: any) {
    err.value = `读取失败：${e?.message || e}`
  }
}

function dropExt(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

/** 切章方式变了就地重切，不让作者重新选一次文件 */
function resplit() {
  if (pendingText.value === null) return
  setPlan(splitChapters(pendingText.value, { mode: mode.value, customPattern: customPattern.value, singleTitle: dropExt(fileName.value) }))
  msg.value = `已重新切分：${chapters.value.length} 章`
}

function toggleAll(v: boolean) {
  picked.value = picked.value.map(() => v)
}

async function doImport() {
  if (!state.ref || !kept.value.length) return
  busy.value = true
  err.value = ''
  msg.value = `正在写入 0/${kept.value.length}…`
  try {
    const res = await importChapters(state.ref, kept.value, {
      volumeName: volumeName.value,
      onProgress: (d, t, title) => (msg.value = `正在写入 ${d}/${t}：${title}`)
    })
    await refresh(false)
    msg.value = `已导入 ${res.created.length} 章 · ${res.totalWords.toLocaleString()} 字`
    const first = res.created[0]
    if (first) await selectChapter(first.id)
    chapters.value = []
    picked.value = []
    pendingText.value = null
    fileName.value = ''
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
        <b>导入已有稿件</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="body col">
        <div class="row">
          <button class="primary" :disabled="busy" @click="fileInput?.click()">选择 txt / md 文件</button>
          <input ref="fileInput" type="file" accept=".txt,.md,.markdown,text/plain" class="hidden-file" @change="onFile" />
          <span v-if="fileName" class="small dim">{{ fileName }}</span>
        </div>

        <details v-if="loose.length" class="loose">
          <summary class="small">或从作品根目录里已有的文件导入（{{ loose.length }} 个）</summary>
          <div class="row wrap">
            <button v-for="f in loose" :key="f" class="text small" :disabled="busy" @click="loadLoose(f)">{{ f }}</button>
          </div>
        </details>

        <div class="grid3">
          <label class="small"
            >切章方式
            <select v-model="mode" :disabled="busy" @change="resplit">
              <option value="auto">自动按「第X章」</option>
              <option value="blank">按空行分段</option>
              <option value="single">整篇一章</option>
            </select>
          </label>
          <label class="small">导入到新卷（可留空）<input v-model="volumeName" :disabled="busy" placeholder="例如：旧稿" /></label>
          <label class="small"
            >自定义标题正则（进阶 · 可留空）<input
              v-model="customPattern"
              :disabled="busy"
              placeholder="如 ^第\d+章"
              @change="resplit"
          /></label>
        </div>

        <p class="small dim hint">
          正则不会写就留空（留空时按上面的方式自动切）。<code>^第\d+章</code> 能认出「第123章」：
          <code>^</code> 行首、<code>\d</code> 任意数字、<code>+</code> 一个以上。
        </p>

        <div v-if="encoding" class="row small meta">
          <span class="tag dim">编码 {{ encoding }}</span>
          <span class="tag dim">{{ chapters.length }} 章</span>
          <span class="tag dim">共 {{ totalWords.toLocaleString() }} 字</span>
          <span v-if="kept.length !== chapters.length" class="tag dim">已选 {{ kept.length }} 章 · {{ keptWords.toLocaleString() }} 字</span>
        </div>

        <p v-if="suspicious > 0" class="warn-box small">
          解码时出现 {{ suspicious }} 个无法识别的字符，可能是编码判断有误（或原文件本身有乱码）。
          可以先用记事本另存为 UTF-8 再试一次。
        </p>

        <div v-if="chapters.length" class="prev">
          <div class="spread small dim">
            <span>预览（取消勾选可跳过）</span>
            <span>
              <button class="text small" @click="toggleAll(true)">全选</button>
              <button class="text small" @click="toggleAll(false)">全不选</button>
            </span>
          </div>
          <label v-for="(c, i) in chapters" :key="i" class="ch-row">
            <input v-model="picked[i]" type="checkbox" style="width: auto" />
            <span class="ch-name">{{ c.title || '（无标题）' }}</span>
            <span class="small dim nowrap">{{ c.words.toLocaleString() }} 字</span>
          </label>
        </div>

        <p v-if="chapters.length === 1 && mode === 'auto'" class="small dim">
          没找到「第X章」这类标题行，所以整篇作一章。可以换成「按空行分段」，或填一个自定义正则。
        </p>

        <div v-if="msg" class="small dim">{{ msg }}</div>
        <p v-if="err" class="err-box small">{{ err }}</p>

        <p class="small dim">
          导入只会往 <code>正文/</code> 里追加新章节，已有章节一个都不会动；进来的正文按「草稿」入库。
          也可以把 <code>全稿.txt</code> 直接拖进作品文件夹，在这里同样读得到。
        </p>
        <p class="small dim">
          手里这份是<b>大纲 / 卷纲 / 章纲</b>而不是正文？
          <button class="text small" :disabled="busy" @click="emit('import-outline')">走大纲导入</button>
          <span class="blk">那里认 Word 的标题层级和表格，写进卷纲与章纲。</span>
        </p>

        <div class="row">
          <button class="primary" :disabled="busy || !kept.length" @click="doImport">导入 {{ kept.length }} 章</button>
          <button :disabled="busy" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 620px;
  max-height: 86vh;
}
.hidden-file {
  display: none;
}
.grid3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
  margin-top: 10px;
}
label.small {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-soft);
}
.loose summary {
  cursor: pointer;
  color: var(--text-dim);
  margin-top: 8px;
}
.loose .row {
  margin-top: 6px;
}
.wrap {
  flex-wrap: wrap;
}
.meta {
  margin: 10px 0 4px;
  gap: 6px;
}
.prev {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  max-height: 240px;
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
  /* 代码片段不许在中间断开：「正文/」被拆成两行时，右半边看着像多出一个怪符号 */
  white-space: nowrap;
}
.blk {
  display: block;
  margin-top: 2px;
}
.hint {
  margin: 2px 0 0;
  line-height: 1.6;
}
/* 下拉框不许写死高度。
 *
 * 写死过 26px：13px 的汉字要 17px 行高，减去上下 padding 12px 和边框 2px，
 * 内容盒只剩 12px —— 每个字上下各削掉 2.5px，「第X章」的「章」被削成了「音」，
 * 作者报上来是「导入稿件处有乱码」。而且它比旁边两个 31px 的输入框矮一截，
 * 三个控件对不齐。
 *
 * 这里不猜高度：交给 flex 撑满同一行，旁边输入框多高它就多高。 */
.grid3 select {
  flex: 1 1 auto;
}
</style>
