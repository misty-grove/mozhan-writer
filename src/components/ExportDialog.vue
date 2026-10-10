<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { currentChapter, orderedChapters, saveNow, state, updateInfo } from '@/stores/workspace'
import { collectChapters, defaultExportOptions, download, toDocxBlob, toMarkdown, toText, type ExportItem, type ExportOptions } from '@/core/exportDoc'
import { buildEpub } from '@/core/exportEpub'
import { listExportTemplates, renderTemplate, unknownPlaceholders, type ExportTemplate } from '@/core/plugins'
import { readChapterBody } from '@/core/workspace'

const emit = defineEmits<{ (e: 'close'): void }>()
const opt = ref<ExportOptions>(defaultExportOptions())
const busy = ref(false)
const err = ref('')

/* 自定义导出模板（插件/导出/*.md，作者自己写的） */
const templates = ref<ExportTemplate[]>([])
const badPlaceholders = ref<string[]>([])

async function loadTemplates() {
  if (!state.ref) return
  templates.value = await listExportTemplates(state.ref)
}

const currentTemplate = computed(() => templates.value.find((t) => t.path === opt.value.templatePath) || null)

watch(
  () => opt.value.templatePath,
  () => {
    badPlaceholders.value = currentTemplate.value ? unknownPlaceholders(currentTemplate.value.raw) : []
  }
)

onMounted(loadTemplates)

function clearTemplate() {
  opt.value.templatePath = ''
}

const all = computed(() => orderedChapters.value)

async function buildItems(): Promise<ExportItem[]> {
  if (!state.ref) return []
  const bodies: Record<string, string> = {}
  for (const c of all.value) bodies[c.id] = c.id === state.currentId ? state.content : await readChapterBody(state.ref, c.id)
  return collectChapters(state.volumes, state.rootChapters, bodies, opt.value)
}

async function run() {
  if (!state.ref) return
  busy.value = true
  err.value = ''
  try {
    await saveNow()
    const items = await buildItems()
    if (!items.length) {
      err.value = '这个范围内没有章节'
      return
    }
    // 自定义模板：作者写在 插件/导出/*.md，占位符替换后直接出文件
    if (currentTemplate.value) {
      const out = renderTemplate(currentTemplate.value.raw, {
        title: state.info.title || '未命名',
        author: state.info.author,
        brief: state.info.brief,
        totalWords: items.reduce((s, i) => s + (i.body || '').length, 0),
        items
      })
      download(new Blob([out], { type: 'text/plain;charset=utf-8' }), `${state.info.title || '未命名'}-${currentTemplate.value.name}.md`)
      return
    }
    const title = state.info.title || '未命名'
    const base = `${title}${opt.value.scope === 'volume' ? '-' + (state.volumes.find((v) => v.id === opt.value.volumeId)?.name || '') : opt.value.scope === 'range' ? `-${opt.value.from}-${opt.value.to}` : ''}`
    if (opt.value.format === 'docx') {
      download(await toDocxBlob(title, state.info.author, items, opt.value), `${base}.docx`)
    } else if (opt.value.format === 'epub') {
      download(buildEpub(items, { title, author: state.info.author, brief: state.info.brief }), `${base}.epub`)
    } else if (opt.value.format === 'md') {
      download(new Blob([toMarkdown(items, opt.value, title)], { type: 'text/markdown;charset=utf-8' }), `${base}.md`)
    } else {
      download(new Blob([toText(items, opt.value)], { type: 'text/plain;charset=utf-8' }), `${base}.txt`)
    }
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>导出作品</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>
      <div class="body col">
        <div class="grid2">
          <label class="small">格式
            <select v-model="opt.format">
              <option value="txt">TXT（合并单文件）</option>
              <option value="md">Markdown（合并单文件）</option>
              <option value="docx">DOCX（可投稿）</option>
              <option value="epub">EPUB（电子书）</option>
            </select>
          </label>
          <label class="small">范围
            <select v-model="opt.scope">
              <option value="all">全书</option>
              <option value="volume">指定卷</option>
              <option value="range">章节区间</option>
            </select>
          </label>
          <label v-if="opt.scope === 'volume'" class="small">卷
            <select v-model="opt.volumeId">
              <option v-for="v in state.volumes" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
          <div v-if="opt.scope === 'range'" class="row small">
            <input v-model.number="opt.from" type="number" min="1" placeholder="起始章" />
            <input v-model.number="opt.to" type="number" min="1" placeholder="结束章" />
          </div>
          <label class="small">标题格式
            <select v-model="opt.headingStyle">
              <option value="第X章">第X章 标题</option>
              <option value="数字">连续数字</option>
              <option value="none">不加标题</option>
            </select>
          </label>
        </div>
        <label v-if="templates.length" class="small">自定义模板（插件/导出/*.md）
          <select v-model="opt.templatePath">
            <option value="">不用模板</option>
            <option v-for="t in templates" :key="t.path" :value="t.path">{{ t.name }}</option>
          </select>
        </label>
        <div v-if="currentTemplate" class="row small">
          <span class="dim">按模板渲染，忽略上面的格式设置</span>
          <button class="text small" @click="clearTemplate">取消模板</button>
        </div>
        <div v-if="badPlaceholders.length" class="small err">
          模板里有不认识的占位符：{{ badPlaceholders.join('、') }}
        </div>
        <p class="small dim">共 {{ all.length }} 章可选。导出在本机完成，不联网。</p>
        <div v-if="err" class="small err">{{ err }}</div>
        <div class="row">
          <button class="primary" :disabled="busy" @click="run">{{ busy ? '导出中…' : '导出' }}</button>
          <button @click="emit('close')">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 480px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
label.small {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-soft);
}
.err {
  color: var(--danger);
}
</style>
