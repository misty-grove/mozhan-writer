<script setup lang="ts">
/**
 * 统计视图（P2-23 / P2-28）
 * 一页看全书结构健康度：总量、节奏、更新曲线、各卷占比。
 */
import { computed, onMounted, ref } from 'vue'
import { loadDaily, recentDays, summarize } from '@/core/stats'
import { applyRule, loadStatRules, type StatResult } from '@/core/plugins'
import { settings } from '@/core/settings'
import { ensureBodies, orderedChapters, refresh, state } from '@/stores/workspace'

const days = ref(30)
const daily = ref(loadDaily())

/* 自定义统计规则（插件/统计.json，作者自己声明「数什么」） */
const rules = ref<Array<{ name: string; type: 'keyword' | 'regex'; words?: string[]; pattern?: string; note?: string }>>([])
const ruleResults = ref<StatResult[]>([])
const bodies = ref<Record<string, string>>({})

const overview = computed(() => summarize(state.volumes, state.rootChapters, daily.value, settings.general.dailyTarget))

const series = computed(() => recentDays(daily.value, days.value))
const maxDay = computed(() => Math.max(1, ...series.value.map((d) => d.words)))

/** 平均每天写了多少（只算有写的日子） */
const avgPerActiveDay = computed(() => {
  const active = daily.value.filter((d) => d.words > 0)
  return active.length ? Math.round(active.reduce((s, d) => s + d.words, 0) / active.length) : 0
})

const statusRows = computed(() => {
  const total = Math.max(1, overview.value.chapterCount)
  return ['待写', '草稿', '待修', '已定稿'].map((s) => ({
    name: s,
    n: overview.value.byStatus[s] || 0,
    pct: Math.round(((overview.value.byStatus[s] || 0) / total) * 100)
  }))
})

const volumeRows = computed(() => {
  const total = Math.max(1, overview.value.totalWords)
  const rows = overview.value.byVolume.map((v) => ({ ...v, pct: Math.round((v.words / total) * 100) }))
  const rootWords = state.rootChapters.reduce((s, c) => s + c.wordCount, 0)
  if (rootWords) rows.push({ name: '未分卷', words: rootWords, chapters: state.rootChapters.length, pct: Math.round((rootWords / total) * 100) })
  return rows
})

/** 结构健康度：4 个能直接改的指标，不做玄学打分 */
const health = computed(() => {
  const o = overview.value
  const doneRate = o.chapterCount ? Math.round(((o.byStatus['已定稿'] || 0) / o.chapterCount) * 100) : 0
  const fixN = o.byStatus['待修'] || 0
  const emptyN = orderedChapters.value.filter((c) => c.wordCount === 0).length
  const idle = daily.value.length ? idleDays(daily.value) : -1
  return [
    { label: '已定稿率', value: `${doneRate}%`, ok: doneRate >= 50, hint: '>= 50% 算健康' },
    { label: '待修章节', value: `${fixN} 章`, ok: fixN === 0, hint: '越少越好' },
    { label: '空章节', value: `${emptyN} 章`, ok: emptyN === 0, hint: '0 章最好' },
    { label: '断更', value: idle < 0 ? '—' : `${idle} 天`, ok: idle <= 3, hint: '<= 3 天算在更' }
  ]
})

function idleDays(list: Array<{ date: string; words: number }>): number {
  const written = list.filter((d) => d.words > 0).map((d) => d.date)
  if (!written.length) return 999
  const last = written[written.length - 1]
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return Math.round((new Date(key + 'T00:00:00').getTime() - new Date(last + 'T00:00:00').getTime()) / 86400000)
}

const barW = computed(() => {
  const n = series.value.length
  return n > 1 ? 100 / n : 100
})

async function loadRules() {
  if (!state.ref) return
  rules.value = await loadStatRules(state.ref)
  if (!rules.value.length) {
    ruleResults.value = []
    return
  }
  bodies.value = await ensureBodies()
  ruleResults.value = rules.value.map((r) => applyRule(orderedChapters.value, bodies.value, r))
}

onMounted(async () => {
  daily.value = loadDaily()
  if (!orderedChapters.value.length) await refresh(false)
  await loadRules()
})
</script>

<template>
  <div class="stats">
    <div class="head">
      <b>统计</b>
      <span class="dim small">数据来自本地 Markdown 与本机的每日字数记录，不联网</span>
      <span class="grow"></span>
      <select v-model.number="days">
        <option :value="14">近 14 天</option>
        <option :value="30">近 30 天</option>
        <option :value="90">近 90 天</option>
      </select>
    </div>

    <div class="scroll">
      <div class="cards">
        <div class="kpi"><span class="dim small">总字数</span><b>{{ overview.totalWords.toLocaleString() }}</b></div>
        <div class="kpi"><span class="dim small">章节 / 卷</span><b>{{ overview.chapterCount }} / {{ overview.volumeCount }}</b></div>
        <div class="kpi"><span class="dim small">平均章字数</span><b>{{ overview.avgChapter.toLocaleString() }}</b></div>
        <div class="kpi"><span class="dim small">连续更新</span><b>{{ overview.streak }} 天</b><span class="dim small">最长 {{ overview.bestStreak }} 天</span></div>
        <div class="kpi"><span class="dim small">今日 / 目标</span><b>{{ overview.todayWords.toLocaleString() }}</b><span class="dim small">{{ overview.targetProgress }}%</span></div>
        <div class="kpi"><span class="dim small">活跃日均</span><b>{{ avgPerActiveDay.toLocaleString() }}</b></div>
      </div>

      <section v-if="ruleResults.length">
        <div class="spread">
          <b class="small">自定义统计（插件/统计.json）</b>
          <span class="dim small">声明式规则，不执行任何脚本</span>
        </div>
        <div class="cards">
          <div v-for="r in ruleResults" :key="r.rule.name" class="kpi">
            <span class="dim small">{{ r.rule.name }}</span>
            <b>{{ r.count.toLocaleString() }}</b>
            <span v-if="r.top" class="dim small">最多：{{ r.top.title }}（{{ r.top.count }}）</span>
            <span v-if="r.detail.length" class="dim small">{{ r.detail.slice(0, 3).map((d) => `${d.word} ${d.count}`).join(' · ') }}</span>
          </div>
        </div>
      </section>

      <section>
        <div class="spread"><b class="small">写作曲线</b><span class="dim small">最近 {{ days }} 天，峰值为 {{ maxDay.toLocaleString() }} 字</span></div>
        <div class="chart">
          <div v-for="d in series" :key="d.date" class="bar-col" :title="`${d.date} · ${d.words} 字`" :style="{ width: barW + '%' }">
            <i :style="{ height: Math.max(2, (d.words / maxDay) * 100) + '%' }" :class="{ zero: !d.words }"></i>
          </div>
        </div>
        <div class="spread dim small"><span>{{ series[0]?.date }}</span><span>{{ series[series.length - 1]?.date }}</span></div>
      </section>

      <div class="two">
        <section>
          <b class="small">各卷字数</b>
          <div v-for="v in volumeRows" :key="v.name" class="rowbar">
            <div class="spread small"><span>{{ v.name }}</span><span class="dim">{{ v.words.toLocaleString() }} 字 · {{ v.chapters }} 章</span></div>
            <div class="track"><i :style="{ width: v.pct + '%' }"></i></div>
          </div>
          <div v-if="!volumeRows.length" class="small dim">还没有分卷。</div>
        </section>

        <section>
          <b class="small">章节状态</b>
          <div v-for="s in statusRows" :key="s.name" class="rowbar">
            <div class="spread small"><span>{{ s.name }}</span><span class="dim">{{ s.n }} 章 · {{ s.pct }}%</span></div>
            <div class="track"><i :class="'st-' + s.name" :style="{ width: s.pct + '%' }"></i></div>
          </div>
        </section>
      </div>

      <section>
        <b class="small">结构健康度</b>
        <div class="health">
          <div v-for="h in health" :key="h.label" class="hcard" :class="{ bad: !h.ok }">
            <span class="dim small">{{ h.label }}</span>
            <b>{{ h.value }}</b>
            <span class="dim small">{{ h.hint }}</span>
          </div>
        </div>
      </section>

      <section>
        <b class="small">章节字数分布</b>
        <div class="dist">
          <div v-for="c in orderedChapters" :key="c.id" class="dcol" :title="`${c.title} · ${c.wordCount} 字`">
            <i :style="{ height: Math.max(2, (c.wordCount / Math.max(1, overview.maxChapter?.words || 1)) * 100) + '%' }"></i>
          </div>
        </div>
        <div class="dim small">
          最长：{{ overview.maxChapter?.title }}（{{ overview.maxChapter?.words.toLocaleString() }} 字） ·
          最短：{{ overview.minChapter?.title }}（{{ overview.minChapter?.words.toLocaleString() }} 字）
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stats {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  font-size: 13px;
}
.grow {
  flex: 1;
}
.scroll {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 10px;
}
/* KPI：数字是主角，标签是配角，两者之间的反差要够大才一眼get到 */
.kpi {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-1);
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}
.kpi:hover {
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}
.kpi b {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
section {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
/* 每个小节给个标题条：这不只是一行字，它是这块图表的表头 */
section > b.small,
section > .spread > b.small {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-soft);
}
.chart {
  height: 132px;
  display: flex;
  align-items: flex-end;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 5px 0;
  background: var(--bg-panel);
  /* 三条基准线：没有它们，柱子只剩「高高低低」，读不出量级 */
  background-image: repeating-linear-gradient(
    to top,
    transparent 0,
    transparent calc(25% - 1px),
    var(--line-soft) calc(25% - 1px),
    var(--line-soft) 25%
  );
}
.bar-col {
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.bar-col i {
  display: block;
  width: 100%;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  transition: background-color 0.15s ease, filter 0.15s ease;
}
.bar-col:hover i {
  filter: brightness(1.15);
}
.bar-col i.zero {
  background: var(--line);
  height: 2px !important;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.rowbar {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.track {
  height: 6px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
}
.track i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.st-已定稿 {
  background: var(--ok);
}
.st-待修 {
  background: var(--warn);
}
.st-草稿 {
  background: var(--edge-link);
}
.health {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.hcard {
  border: 1px solid var(--line);
  border-left: 3px solid var(--ok);
  border-radius: 9px;
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-1);
}
.hcard.bad {
  border-left-color: var(--warn);
}
.hcard b {
  font-size: 16px;
  font-weight: 600;
}
.dist {
  height: 96px;
  display: flex;
  align-items: flex-end;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 5px 0;
  background: var(--bg-panel);
  overflow-x: auto;
}
.dcol {
  height: 100%;
  min-width: 4px;
  flex: 1 1 4px;
  display: flex;
  align-items: flex-end;
}
.dcol i {
  display: block;
  width: 100%;
  background: var(--edge-link);
  border-radius: 2px 2px 0 0;
  transition: background-color 0.15s ease;
}
.dcol:hover i {
  background: var(--accent);
}
</style>
