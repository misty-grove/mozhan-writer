<script setup lang="ts">
/**
 * 数据看板（Task #5）
 * 全部来自本地：磁盘上的 Markdown + localStorage 的每日字数。
 */
import { computed, ref, watch } from 'vue'
import { loadDaily, recentDays, summarize } from '@/core/stats'
import { settings } from '@/core/settings'
import { state } from '@/stores/workspace'

const days = ref(30)
const daily = ref(loadDaily())

watch([() => state.ref, () => state.todayWords], () => (daily.value = loadDaily()), { immediate: true })

const target = computed(() => settings.general.dailyTarget || 0)
const overview = computed(() => summarize(state.volumes, state.rootChapters, daily.value, target.value))
const series = computed(() => recentDays(daily.value, days.value))
const peak = computed(() => Math.max(1, ...series.value.map((d) => d.words)))
const maxVolume = computed(() => Math.max(1, ...overview.value.byVolume.map((v) => v.words)))
const statusOrder = ['待写', '草稿', '待修', '已定稿']

function bar(n: number, max: number) {
  return Math.max(0, Math.round((n / max) * 100))
}
</script>

<template>
  <div class="bd">
    <div class="spread">
      <b class="tt">数据看板</b>
      <select v-model.number="days">
        <option :value="14">14 天</option>
        <option :value="30">30 天</option>
        <option :value="60">60 天</option>
      </select>
    </div>

    <div class="grid small">
      <div class="cell">
        <div class="dim">总字数</div>
        <b class="big">{{ overview.totalWords.toLocaleString() }}</b>
      </div>
      <div class="cell">
        <div class="dim">章节 / 卷</div>
        <b class="big">{{ overview.chapterCount }} / {{ overview.volumeCount }}</b>
      </div>
      <div class="cell">
        <div class="dim">今日</div>
        <b class="big">{{ overview.todayWords }}</b>
        <span v-if="target" class="dim small">/{{ target }}</span>
      </div>
      <div class="cell">
        <div class="dim">连续写作</div>
        <b class="big">{{ overview.streak }} 天</b>
        <span class="dim small">最长 {{ overview.bestStreak }}</span>
      </div>
    </div>

    <div v-if="target" class="prog">
      <div class="spread small">
        <span>今日目标进度</span>
        <span>{{ overview.targetProgress }}%</span>
      </div>
      <div class="outer"><div class="inner" :style="{ width: overview.targetProgress + '%' }"></div></div>
    </div>

    <div class="chart">
      <div class="spread small dim">
        <span>近 {{ days }} 天字数</span>
        <span>峰值 {{ peak === 1 && !series.some((s) => s.words) ? 0 : peak }}</span>
      </div>
      <div class="bars">
        <div v-for="d in series" :key="d.date" class="bar-col" :title="d.date + '：' + d.words + ' 字'">
          <div class="bar" :style="{ height: bar(d.words, peak) + '%' }"></div>
        </div>
      </div>
    </div>

    <div v-if="overview.byVolume.length" class="vols small">
      <div class="dim">分卷字数</div>
      <div v-for="v in overview.byVolume" :key="v.name" class="vrow">
        <span class="vname">{{ v.name }}</span>
        <span class="outer grow"><span class="inner" :style="{ width: bar(v.words, maxVolume) + '%' }"></span></span>
        <span class="dim nowrap">{{ v.words }} 字 · {{ v.chapters }}章</span>
      </div>
    </div>

    <div class="status small">
      <span v-for="s in statusOrder" :key="s" class="tag">{{ s }} {{ overview.byStatus[s] || 0 }}</span>
    </div>

    <div v-if="overview.maxChapter" class="small dim">
      最长：{{ overview.maxChapter.title }}（{{ overview.maxChapter.words }} 字）· 最短：{{ overview.minChapter?.title }}（{{ overview.minChapter?.words }} 字）· 均 {{ overview.avgChapter }} 字/章
    </div>
  </div>
</template>

<style scoped>
.bd {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tt {
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.cell {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  padding: 6px 8px;
}
.big {
  font-size: 17px;
  display: block;
}
.prog .outer,
.chart .outer,
.vrow .outer {
  height: 6px;
  background: var(--line-soft);
  border-radius: 3px;
  overflow: hidden;
}
.inner {
  display: block;
  height: 100%;
  background: var(--accent);
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 84px;
  padding-top: 4px;
}
.bar-col {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  min-height: 1px;
  background: var(--accent);
  opacity: 0.75;
  border-radius: 1px;
}
.vols {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.vrow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.vname {
  width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow {
  flex: 1;
}
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
