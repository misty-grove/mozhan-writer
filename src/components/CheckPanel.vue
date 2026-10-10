<script setup lang="ts">
/**
 * 一致性初筛面板（Task #5 · 不调用 AI，只做机器能对账的部分）
 * 断链 / 笔误 / 伏笔超期 / 角色失踪 / 草稿残留 / 未登记名词。
 */
import { computed, ref } from 'vue'
import { ISSUE_KIND_LABEL, checkAll, type ConsistencyIssue, type IssueKind } from '@/core/consistency'
import { readMemoryFile } from '@/core/memory'
import { addEntry, codexState, ensureCodex } from '@/stores/codex'
import { requestJump } from '@/stores/editor'
import { ensureBodies, orderedChapters, state } from '@/stores/workspace'
import * as sensitive from '@/core/sensitive'

const issues = ref<ConsistencyIssue[]>([])
const running = ref(false)
const msg = ref('')
const missingAfter = ref(8)
const done = ref(false)

/* 敏感词：同一份检查里顺带扫一遍，词表归作者管 */
const sensHits = ref<Array<{ id: string; title: string; reports: sensitive.SensitiveReport[]; total: number }>>([])
const sensOpen = ref(false)
const wordText = ref('')
const editingWords = ref(false)
const sensMsg = ref('')

const sensTotal = computed(() => sensHits.value.reduce((s, c) => s + c.total, 0))

async function runSensitive() {
  if (!state.ref) return
  const words = await sensitive.loadWords(state.ref)
  wordText.value = sensitive.serializeWords(words)
  sensHits.value = sensitive.scanWork(orderedChapters.value, await ensureBodies(), words)
}

async function saveWordList() {
  if (!state.ref) return
  const words = sensitive.parseWords(wordText.value)
  await sensitive.saveWords(state.ref, words)
  editingWords.value = false
  sensMsg.value = `词表已存（${words.length} 词）`
  await runSensitive()
}

const counts = computed(() => {
  const m = new Map<IssueKind, number>()
  for (const i of issues.value) {
    if (i.kind === 'unknown-ref' && !i.chapterId) continue
    m.set(i.kind, (m.get(i.kind) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})

const groups = computed(() =>
  [...new Set(issues.value.map((i) => i.kind))].map((k) => ({
    kind: k,
    list: issues.value.filter((i) => i.kind === k)
  }))
)

async function run() {
  if (!state.ref) return
  running.value = true
  msg.value = '正在对账…'
  try {
    await ensureCodex()
    const bodies = await ensureBodies()
    const raw = await readMemoryFile(state.ref, '伏笔台账.md')
    issues.value = checkAll({
      entries: codexState.entries,
      chapters: orderedChapters.value,
      bodies,
      foreshadowRaw: raw,
      currentId: state.currentId,
      missingAfter: missingAfter.value
    })
    done.value = true
    msg.value = issues.value.length ? `共 ${issues.value.length} 项待确认` : '没发现问题'
    await runSensitive()
  } catch (e: any) {
    msg.value = `检查失败：${e?.message || e}`
  } finally {
    running.value = false
  }
}

function jump(i: ConsistencyIssue) {
  if (!i.chapterId) return
  requestJump(i.chapterId, i.pos || 0, '')
}

async function adopt(i: ConsistencyIssue) {
  const name = /「([^」]+)」/.exec(i.message)?.[1]
  if (!name) return
  await addEntry('lore', name)
  msg.value = `已在设定库补一条「${name}」`
}

const filter = ref<IssueKind | ''>('')
const shown = computed(() => issues.value.filter((i) => !filter.value || i.kind === filter.value))
</script>

<template>
  <div class="ck">
    <div class="spread">
      <b class="tt">一致性检查</b>
      <button class="primary small" :disabled="running" @click="run">{{ running ? '检查中…' : '开始检查' }}</button>
    </div>

    <label class="row small dim">
      连续多少章没出场算「失踪」
      <input v-model.number="missingAfter" type="number" min="2" max="60" style="width: 64px" />
    </label>

    <p class="small dim">{{ msg || '点「开始检查」，会在本地全文范围内对账，不联网。' }}</p>

    <div v-if="counts.length" class="chips">
      <button class="tag" :class="{ on: !filter }" @click="filter = ''">全部 {{ issues.length }}</button>
      <button v-for="[k, n] in counts" :key="k" class="tag" :class="{ on: filter === k }" @click="filter = k">
        {{ ISSUE_KIND_LABEL[k] }} {{ n }}
      </button>
    </div>

    <div v-if="done && !issues.length" class="small dim">没有明显问题。</div>

    <div v-for="i in shown" :key="i.message + (i.chapterId || '')" class="item" :class="i.level" @click="jump(i)">
      <div class="row">
        <span class="tag" :class="i.level === 'warn' ? 'warn' : 'info'">{{ ISSUE_KIND_LABEL[i.kind] }}</span>
        <span v-if="i.chapterTitle" class="small dim nowrap">{{ i.chapterTitle }}</span>
      </div>
      <div class="small">{{ i.message }}</div>
      <div v-if="i.suggest" class="small dim">建议：{{ i.suggest }}</div>
      <div v-if="i.kind === 'unknown-ref' || i.kind === 'broken-link'" class="row">
        <button class="text small" @click.stop="adopt(i)">补进设定库</button>
      </div>
    </div>

    <div class="sens">
      <div class="spread">
        <b class="small" @click="sensOpen = !sensOpen" style="cursor: pointer">
          敏感词（本地词表）{{ sensTotal ? ` · ${sensTotal} 处` : '' }}
        </b>
        <button class="text small" @click="editingWords = !editingWords">{{ editingWords ? '收起词表' : '编辑词表' }}</button>
      </div>

      <div v-if="editingWords" class="wordbox">
        <textarea v-model="wordText" rows="8" spellcheck="false"></textarea>
        <div class="row">
          <button class="primary small" @click="saveWordList">存到 记忆/敏感词.txt</button>
          <span class="small dim">一行一个词，# 开头是注释</span>
        </div>
        <div v-if="sensMsg" class="small dim">{{ sensMsg }}</div>
      </div>

      <div v-if="sensOpen">
        <div v-if="!sensHits.length" class="small dim">按当前词表没扫到。</div>
        <div v-for="ch in sensHits" :key="ch.id" class="item warn" @click="requestJump(ch.id, 0, '')">
          <div class="row">
            <span class="tag warn">敏感词</span>
            <span class="small dim nowrap">{{ ch.title }}</span>
            <span class="small dim">{{ ch.total }} 处</span>
          </div>
          <div v-for="r in ch.reports" :key="r.word" class="small">
            「{{ r.word }}」×{{ r.count }}
            <span class="dim">— {{ r.hits[0].context }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ck {
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
.chips .tag.on {
  background: var(--accent-soft);
  color: var(--text);
  border-color: var(--accent);
}
.item {
  border: 1px solid var(--line-soft);
  border-left-width: 2px;
  border-radius: var(--radius);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  cursor: pointer;
}
.item.warn {
  border-left-color: var(--warn);
}
.item.info {
  border-left-color: var(--line);
}
.item:hover {
  background: var(--bg-soft);
}
.sens {
  margin-top: 6px;
  border-top: 1px solid var(--line-soft);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wordbox {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wordbox textarea {
  width: 100%;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px;
  background: var(--bg);
  color: var(--text);
  resize: vertical;
}
</style>
