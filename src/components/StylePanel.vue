<script setup lang="ts">
/**
 * 文风检查面板（Task #4 · 纯本地，不用 AI）
 * 左半：本章指标 vs 基线（其余章节）；右半（纵向）：命中清单，点一条跳到正文对应位置。
 */
import { computed, ref, watch } from 'vue'
import {
  ISSUE_LABEL,
  analyzeStyle,
  drift,
  driftFromBaseline,
  parseBaseline,
  serializeBaseline,
  toBaseline,
  type StyleBaseline,
  type StyleIssue
} from '@/core/style'
import { settings } from '@/core/settings'
import { readMemoryFile, writeMemoryFile } from '@/core/memory'
import { requestJump } from '@/stores/editor'
import { currentChapter, ensureBodies, orderedChapters, state } from '@/stores/workspace'

const FILE_BASELINE = '文风基线.md'

const bannedText = ref(settings.style.bannedWords.join('\n'))
const showMetrics = ref(true)

const banned = computed(() =>
  bannedText.value
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
)

const result = computed(() => {
  const text = state.content || ''
  const all = analyzeStyle(text, banned.value)
  const issues = settings.style.checkAiTone ? all.issues : all.issues.filter((i) => i.type !== 'ai-cliche' && i.type !== 'summary-tone')
  return { metrics: all.metrics, issues }
})

const baseline = ref<{ label: string; text: string } | null>(null)

/** 已存档基线（记忆/文风基线.md），优先于临时算出的对比样本 */
const archived = ref<StyleBaseline | null>(null)

const baselineMetrics = computed(() => {
  if (!baseline.value?.text) return null
  return analyzeStyle(baseline.value.text).metrics
})

const compare = computed(() => {
  if (archived.value) return driftFromBaseline(archived.value, result.value.metrics)
  if (baselineMetrics.value) return drift(baselineMetrics.value, result.value.metrics)
  return null
})

const compareSource = computed(() => (archived.value ? `已存档基线（${archived.value.chars} 字样本）` : baseline.value?.label || ''))

const grouped = computed(() => {
  const m = new Map<string, StyleIssue[]>()
  for (const i of result.value.issues) {
    const arr = m.get(i.type) || []
    arr.push(i)
    m.set(i.type, arr)
  }
  return [...m.entries()].map(([type, list]) => ({ type, list }))
})

async function buildBaseline() {
  if (!state.ref) return
  await ensureBodies()
  const others = orderedChapters.value.filter((c) => c.id !== state.currentId)
  const useAll = settings.style.baseline === 'all'
  const picked = useAll ? orderedChapters.value : others
  const text = picked.map((c) => state.bodies[c.id] || '').join('\n\n')
  baseline.value = { label: useAll ? '全书' : `其余 ${picked.length} 章`, text }
}

watch([() => state.ref, () => settings.style.baseline], loadAll, { immediate: true })

async function loadAll() {
  if (!state.ref) return
  archived.value = parseBaseline(await readMemoryFile(state.ref, FILE_BASELINE))
  await buildBaseline()
}

/** 用当前全文重算基线并存档到 记忆/文风基线.md（作者可手工改） */
async function archiveBaseline() {
  if (!state.ref) return
  await ensureBodies()
  const text = orderedChapters.value.map((c) => state.bodies[c.id] || '').join('\n\n')
  if (!text.trim()) return
  const b = toBaseline(analyzeStyle(text).metrics)
  await writeMemoryFile(state.ref, FILE_BASELINE, serializeBaseline(b))
  archived.value = b
}

function jump(i: StyleIssue) {
  if (!currentChapter.value) return
  requestJump(currentChapter.value.id, i.pos, i.text)
}
</script>

<template>
  <div class="st">
    <div class="spread">
      <b class="tt">文风 / 去 AI 味</b>
      <select v-model="settings.style.baseline">
        <option value="others">基线＝其余章节</option>
        <option value="all">基线＝全书</option>
      </select>
    </div>

    <div v-if="result.metrics.chars" class="metrics">
      <div class="kv small"><span class="dim">字数</span><b>{{ result.metrics.chars }}</b></div>
      <div class="kv small"><span class="dim">平均句长</span><b>{{ result.metrics.avgSentence }} 字</b></div>
      <div class="kv small"><span class="dim">最长句</span><b>{{ result.metrics.maxSentence }} 字</b></div>
      <div class="kv small"><span class="dim">对话占比</span><b>{{ result.metrics.dialogueRatio }}%</b></div>
      <div class="kv small"><span class="dim">段落数</span><b>{{ result.metrics.paragraphCount }}</b></div>
      <div class="kv small"><span class="dim">平均段落</span><b>{{ result.metrics.avgParagraph }} 字</b></div>
    </div>
    <p v-else class="small dim">本章还没有正文。</p>

    <div class="row">
      <button class="text small" @click="archiveBaseline">重算并存档基线</button>
      <span class="small dim">存到 记忆/{{ FILE_BASELINE }}</span>
    </div>

    <div v-if="compare && compare.notes.length" class="drift">
      <div class="spread small">
        <span>与{{ compareSource }}偏离度 <b>{{ compare.score }}</b>/100</span>
      </div>
      <div v-for="(n, i) in compare.notes" :key="i" class="small dim">{{ n }}</div>
    </div>
    <p v-else class="small dim">暂无基线对比（存一份基线，或先写几章）。</p>

    <div v-if="archived" class="detail small">
      <div class="row">
        <span class="tag info">指纹</span>
        <span class="dim">{{ archived.topWords.slice(0, 12).join('、') || '样本不足' }}</span>
      </div>
      <div class="dim">
        基线：句长 {{ archived.avgSentence }} 字 · 对话 {{ archived.dialogueRatio }}% · 段落 {{ archived.avgParagraph }} 字
      </div>
    </div>

    <div v-if="showMetrics && result.metrics.topWords.length" class="detail small">
      <div class="dim">高频词</div>
      <div class="chips">
        <span v-for="w in result.metrics.topWords.slice(0, 14)" :key="w.w" class="tag">{{ w.w }}·{{ w.n }}</span>
      </div>
      <div v-if="result.metrics.idiomHits.length" class="dim">重复四字片段：{{ result.metrics.idiomHits.join(' / ') }}</div>
    </div>

    <hr />

    <div class="spread">
      <b class="small">命中清单（{{ result.issues.length }}）</b>
      <button class="text small" @click="showMetrics = !showMetrics">{{ showMetrics ? '收起指标' : '展开指标' }}</button>
    </div>

    <div v-for="g in grouped" :key="g.type" class="grp">
      <div class="grp-h small">
        <span class="tag" :class="g.type === 'banned' ? 'warn' : 'info'">{{ ISSUE_LABEL[g.type as keyof typeof ISSUE_LABEL] }}</span>
        <span class="dim">{{ g.list.length }} 处</span>
      </div>
      <div v-for="(i, k) in g.list.slice(0, 30)" :key="k" class="hit" @click="jump(i)">
        <div class="hit-t small">{{ i.text }}</div>
        <div class="dim small ctx">{{ i.context }}</div>
        <div class="small dim hint">{{ i.hint }}</div>
      </div>
    </div>
    <p v-if="!result.issues.length" class="small dim">没检出明显的 AI 腔 / 重复结构。</p>

    <details>
      <summary class="small dim">禁用词表（每行一个，作者自定义）</summary>
      <textarea v-model="bannedText" class="banned" rows="5" spellcheck="false" @change="settings.style.bannedWords = banned"></textarea>
    </details>
  </div>
</template>

<style scoped>
.st {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
}
.kv {
  display: flex;
  justify-content: space-between;
}
.drift {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--bg-panel);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 0 6px;
}
.grp {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
}
.hit {
  border-left: 2px solid var(--accent-soft);
  padding: 2px 0 2px 8px;
  cursor: pointer;
}
.hit:hover {
  background: var(--bg-soft);
}
.hit-t {
  color: var(--text);
}
.ctx,
.hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.banned {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  margin-top: 6px;
}
</style>
