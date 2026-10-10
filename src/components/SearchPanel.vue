<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { search, setIndex, hasIndex, clearCache, getIndex } from '@/core/indexCache'
import { orderedChapters, selectChapter, state } from '@/stores/workspace'
import { readAsset, readChapterBody, DIRS } from '@/core/workspace'
import { replaceOccurrences } from '@/core/search'
import { cachedIndex, search as semanticSearch, splitPassages, type Hit, type RetrievalIndex } from '@/core/retrieve'
import { requestJump, requestOpenAsset } from '@/stores/editor'
import { ensureBodies } from '@/stores/workspace'

const q = ref('')
const building = ref(false)
const progress = ref('')
const hits = ref<any[]>([])
const replaceText = ref('')
const replaceMode = ref(false)
const notice = ref('')
const scope = ref('')

/* 语义模式（P1-20）：本地 TF-IDF 召回，不联网、不要 embedding 模型 */
const mode = ref<'exact' | 'semantic'>('exact')
const semHits = ref<Hit[]>([])
const semBusy = ref(false)
let semIndex: RetrievalIndex | null = null
let semKey = ''

async function ensureSemantic() {
  if (!state.ref) return
  const bodies = await ensureBodies()
  if (state.currentId) bodies[state.currentId] = state.content
  const passages = splitPassages(orderedChapters.value, bodies)
  const key = `${state.ref.id}:${passages.length}:${Object.values(bodies).join('').length}`
  if (!semIndex || key !== semKey) {
    semIndex = cachedIndex(key, passages)
    semKey = key
  }
}

/** 命中的是哪一类：正文 / 大纲 / 设定 / 记忆 */
function scopeOf(id: string): string {
  const seg = String(id).split('/')[0]
  return seg || '其它'
}

const scopes = computed(() => {
  const m = new Map<string, number>()
  for (const h of hits.value) m.set(scopeOf(h.id), (m.get(scopeOf(h.id)) || 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})

const shown = computed(() => hits.value.filter((h) => !scope.value || scopeOf(h.id) === scope.value))

function isChapterHit(id: string): boolean {
  return id.startsWith(DIRS.body + '/') || orderedChapters.value.some((c) => c.id === id)
}

async function build() {
  if (!state.ref || building.value) return
  building.value = true
  progress.value = '0/0'
  const entries: any[] = []
  const list = orderedChapters.value
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const text = c.id === state.currentId ? state.content : await readChapterBody(state.ref, c.id)
    entries.push({ id: c.id, title: c.title, text, words: c.wordCount })
    progress.value = `${i + 1}/${list.length}`
  }
  for (const a of state.assets) {
    try {
      const t = await readAsset(state.ref!, a.id)
      entries.push({ id: a.id, title: `[${a.group}] ${a.name}`, text: t, words: 0 })
    } catch {
      /* noop */
    }
  }
  setIndex(state.ref.id, entries)
  building.value = false
  run()
}

async function run() {
  if (!state.ref) return
  if (mode.value === 'semantic') {
    semBusy.value = true
    try {
      await ensureSemantic()
      semHits.value = semIndex ? semanticSearch(semIndex, plainQuery.value, 20) : []
      notice.value = semHits.value.length ? '' : plainQuery.value ? '没有语义上相近的段落' : ''
    } finally {
      semBusy.value = false
    }
    return
  }
  // 当前章正在写，索引里是建索引那一刻的快照，先用实时内容顶上
  const entry = getIndex(state.ref.id).find((e) => e.id === state.currentId)
  if (entry) entry.text = state.content
  hits.value = search(state.ref.id, q.value, 200)
  notice.value = hits.value.length ? '' : q.value ? '没有匹配' : ''
}

/** 点到某条结果：正文跳到位置，资料类在「资料」面板里展开 */
function openHit(h: any) {
  if (isChapterHit(h.id)) {
    requestJump(h.id, h.pos, plainQuery.value || '')
    return
  }
  requestOpenAsset(h.id)
}

const plainQuery = computed(() => q.value.replace(/^\/(.*)\/[gimsuy]*$/, '$1'))

onMounted(() => {
  if (state.ref && !hasIndex(state.ref.id) && orderedChapters.value.length) build()
})

watch(
  () => state.ref,
  () => {
    hits.value = []
    scope.value = ''
  }
)

async function replaceAllInFile(id: string) {
  if (!state.ref) return
  const n = await replaceOccurrences(state.ref, id, q.value, replaceText.value)
  notice.value = `已在 ${id} 替换 ${n} 处`
  if (id === state.currentId) await selectChapter(id, true)
  hits.value = []
}

function highlight(text: string, q: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const plain = q.replace(/^\/(.*)\/[gimsuy]*$/, '$1')
  if (!plain) return esc(text)
  try {
    return esc(text).replace(new RegExp('(' + plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'g'), '<mark>$1</mark>')
  } catch {
    return esc(text)
  }
}

const grouped = computed(() => hits.value.length)
</script>

<template>
  <div class="sp">
    <div class="spread">
      <b class="tt">全书搜索</b>
      <button class="text small" @click="build" :disabled="building">{{ building ? `索引中 ${progress}` : hasIndex(state.ref!.id) ? '重建索引' : '建立索引' }}</button>
    </div>
    <div class="row">
      <input v-model="q" placeholder="查找（/正则/ 形式支持正则）" @keydown.enter="run" />
      <button class="text small" @click="run">搜索</button>
    </div>
    <div class="row small">
      <button class="text small" :class="{ on: mode === 'exact' }" @click="mode = 'exact'">精确</button>
      <button class="text small" :class="{ on: mode === 'semantic' }" @click="mode = 'semantic'">语义</button>
      <button v-if="mode === 'exact'" class="text small" @click="replaceMode = !replaceMode">{{ replaceMode ? '关闭替换' : '批量替换' }}</button>
      <button v-if="mode === 'exact'" class="text small" @click="clearCache()">清缓存</button>
      <span class="dim">{{ mode === 'exact' ? shown.length : semHits.length }} 条结果</span>
    </div>
    <p v-if="mode === 'semantic'" class="small dim">
      按词的相近程度排序（本地 TF-IDF，不联网、不装模型）。适合「记得零星几个词、忘了原话怎么说」的情形；
      纯同义改写（写得完全不一样的说法）它找不出来 —— 那需要 embedding 模型，要装几十 MB，没做。
    </p>

    <div v-if="replaceMode" class="row">
      <input v-model="replaceText" placeholder="替换为" />
    </div>

    <div v-if="scopes.length > 1" class="chips">
      <button class="tag" :class="{ on: !scope }" @click="scope = ''">全部 {{ hits.length }}</button>
      <button v-for="[s, n] in scopes" :key="s" class="tag" :class="{ on: scope === s }" @click="scope = s">{{ s }} {{ n }}</button>
    </div>

    <!-- 语义结果：按相关度排序，点一下跳到那一章的对应位置 -->
    <div v-if="mode === 'semantic'" class="hits">
      <div v-if="semBusy" class="small dim">正在找…</div>
      <div
        v-for="h in semHits"
        :key="h.passage.id"
        class="hit"
        @click="requestJump(h.passage.chapterId, h.passage.pos, '')"
      >
        <div class="spread">
          <b class="small">{{ h.passage.chapterTitle }}</b>
          <span class="dim small">相关度 {{ (h.score * 100).toFixed(0) }}</span>
        </div>
        <div class="small snippet">{{ h.snippet }}</div>
      </div>
      <div v-if="notice" class="small dim">{{ notice }}</div>
    </div>

    <div v-else class="hits">
      <div v-for="h in shown" :key="h.id + h.pos" class="hit" @click="openHit(h)">
        <div class="spread">
          <b class="small">{{ h.title }}</b>
          <span class="dim small">{{ scopeOf(h.id) }} · {{ h.count }} 处</span>
        </div>
        <div class="small snippet" v-html="highlight(h.snippet, q)"></div>
        <button v-if="replaceMode && isChapterHit(h.id)" class="text small" @click.stop="replaceAllInFile(h.id)">在本章全部替换</button>
      </div>
      <div v-if="notice" class="small dim">{{ notice }}</div>
    </div>
  </div>
</template>

<style scoped>
.sp {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chips .tag {
  cursor: pointer;
}
button.text.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.chips .tag.on {
  background: var(--accent-soft);
  color: var(--text);
  border-color: var(--accent);
}
.hits {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow: auto;
}
.hit {
  padding: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  cursor: pointer;
}
.hit:hover {
  border-color: var(--accent);
}
.snippet {
  color: var(--text-soft);
  line-height: 1.7;
}
:deep(mark) {
  background: var(--mark);
  color: inherit;
}
</style>
