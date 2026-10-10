<script setup lang="ts">
/**
 * 大纲与章纲（P1-19）
 *
 * 两件事分开：
 *  ① 规模 —— **卷数与章数由作者自己定**（导入大纲后按大纲自动填好，仍可改）。
 *     以前是「按目标字数算一个给你看」，那个 4 卷 67 章既没人认领、又总跟作者想的不一样。
 *  ② 内容 —— 卷目标留白由作者填/导入/AI 补；章纲走 表格留白 / 导入 / AI 三条路。
 *
 * AI 推荐（第三个页签）支持三种输入：题材标签、作者自己的想法、世界观材料。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import fs from '@/platform'
import {
  buildSkeleton,
  countChapters,
  outlinePrompt,
  parseOutlineMarkdown,
  recommendPrompt,
  reshapeSkeleton,
  toOutlineMarkdown,
  type Skeleton
} from '@/core/outline'
import { TAG_GROUPS, joinTags, lengthTagOf, parseTags, wordsOfTag, type TagGroup } from '@/core/tags'
import { createVolume } from '@/core/workspace'
import { newChapter, refresh, state } from '@/stores/workspace'
import { aiEnabled } from '@/core/settings'
import { generate } from '@/stores/ai'
import { setDockTab } from '@/stores/editor'

const emit = defineEmits<{ (e: 'close'): void; (e: 'import-outline'): void }>()

const tab = ref<'new' | 'existing' | 'recommend'>('new')
const busy = ref(false)
const msg = ref('')
const existing = ref('')

/* ------------------------------------------------------------------ 规模
 * 卷数 / 章数 / 每章字数：作者自己定。导入大纲后由 syncShape() 按大纲填好。
 * 目标字数不再是输入框 —— 它 = 章数 × 每章字数，跟着算出来就够了。
 */
const shape = reactive({ volumes: 4, chapters: 60, chapterWords: 3000 })
const targetWords = computed(() => Math.max(0, (Number(shape.chapters) || 0) * (Number(shape.chapterWords) || 0)))
const wanWords = computed(() => (Number.isFinite(targetWords.value) ? (targetWords.value / 10000).toFixed(1) : '0'))

function clampShape() {
  shape.chapters = Math.min(5000, Math.max(1, Math.round(Number(shape.chapters) || 1)))
  shape.chapterWords = Math.min(20000, Math.max(500, Math.round(Number(shape.chapterWords) || 3000)))
  // 卷数不可能比章数多：当场把它按回去，别等到预览里出现「第2章-第1章」才让人纳闷
  shape.volumes = Math.min(60, Math.max(1, Math.round(Number(shape.volumes) || 1)), shape.chapters)
}

function syncShape(s: Skeleton) {
  shape.volumes = Math.max(1, s.volumes.length)
  shape.chapters = Math.max(1, countChapters(s))
  if (s.chapterWords >= 500) shape.chapterWords = s.chapterWords
}

/** 篇幅标签的选中态是**算出来的**（总字数落在哪一档），所以不存在两份状态对不上的问题 */
const lengthTag = computed(() => lengthTagOf(targetWords.value))

function pickLength(tag: string) {
  const words = wordsOfTag(tag)
  if (!words) return
  shape.chapterWords = Math.min(20000, Math.max(500, Math.round(Number(shape.chapterWords) || 3000)))
  shape.chapters = Math.max(1, Math.round(words / shape.chapterWords))
}

const skeleton = computed<Skeleton>(() =>
  buildSkeleton({
    title: state.info.title || '未命名',
    chapters: shape.chapters,
    chapterWords: shape.chapterWords,
    volumes: shape.volumes
  })
)

/* 卷目标：留白由作者自己填。骨架随规模输入实时变化，这里按卷序号对齐保存已输入的值 */
const volTargets = ref<string[]>([])
watch(
  () => skeleton.value.volumes.length,
  (n) => {
    while (volTargets.value.length < n) volTargets.value.push('')
    volTargets.value.length = n
  },
  { immediate: true }
)

/* ------------------------------------------------------------------ 用现有大纲
 * 作者粘/导进来的大纲是**事实来源**：一识别出来就把规模数字填成它的样子，
 * 之后作者想改成 5 卷 90 章，改的就是这三个数字（reshaped 负责重排）。
 */
const parsed = computed<Skeleton | null>(() => {
  if (!existing.value.trim()) return null
  const s = parseOutlineMarkdown(existing.value)
  return s.volumes.length ? s : null
})

const reshaped = computed<Skeleton | null>(() => (parsed.value ? reshapeSkeleton(parsed.value, shape.volumes, shape.chapters) : null))

// 大纲原文一变（粘贴 / 手改 / 导入）= 重新声明结构，规模跟着它走
watch(parsed, (p) => {
  if (p && tab.value === 'existing') syncShape(p)
})
watch(tab, (t) => {
  if (t === 'existing' && parsed.value) syncShape(parsed.value)
})

/** 预览用的骨架：用现有大纲时看 reshaped，其余看按数字铺的骨架 */
const active = computed<Skeleton>(() => (tab.value === 'existing' && reshaped.value ? reshaped.value : skeleton.value))

/** 落盘 / 建章 / 喂 AI 用的是「骨架 + 作者填的卷目标」 */
const finalSkeleton = computed<Skeleton>(() => {
  if (tab.value === 'existing' && reshaped.value) return reshaped.value
  const s = skeleton.value
  return { ...s, volumes: s.volumes.map((v, i) => ({ ...v, target: (volTargets.value[i] || '').trim() })) }
})

async function writeFile() {
  if (!state.ref) return
  clampShape()
  busy.value = true
  try {
    await fs().writeFile(state.ref, ['大纲', '大纲.md'], toOutlineMarkdown(finalSkeleton.value, state.info.brief))
    msg.value = '已写入 大纲/大纲.md'
  } catch (e: any) {
    msg.value = `写入失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

async function buildChapters() {
  if (!state.ref) return
  clampShape()
  busy.value = true
  msg.value = '正在建章节…'
  try {
    const s = finalSkeleton.value
    let n = 0
    for (const v of s.volumes) {
      const vol = await createVolume(state.ref, v.name)
      for (const c of v.chapters) {
        await newChapter(vol.id, c.title)
        n++
      }
    }
    await refresh(false)
    msg.value = `已建 ${s.volumes.length} 卷 ${n} 章`
  } catch (e: any) {
    msg.value = `建章节失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

async function askAi() {
  if (!aiEnabled()) return
  clampShape()
  busy.value = true
  msg.value = 'AI 正在补章纲…'
  try {
    const out = await generate({
      mode: 'outline',
      instruction: outlinePrompt(state.info, finalSkeleton.value, ''),
      n: 1
    })
    setDockTab('candidate')
    msg.value = out.length ? `已生成 ${out.length} 个候选，在「候选」里查看并采纳` : '没有生成候选'
  } catch (e: any) {
    msg.value = `AI 生成失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------------------------ AI 推荐
 * 三份输入：点选的标签（含频道/题材/风格/篇幅）、作者自己打的标签、作者写的想法。
 * 三份都会进提示词 —— 界面上直接把「AI 实际会看到的那串」显示出来，免得作者
 * 以为自己写了、其实没进去。
 */
const recChips = ref<string[]>([])
const recCustom = ref('')
const recIdea = ref('')
const recMaterial = ref('')
const settingNames = ref<string[]>([])

const customTags = computed(() => parseTags(recCustom.value))
const allTags = computed(() => joinTags([...recChips.value, ...customTags.value, lengthTag.value]))

function chipOn(t: string, g: TagGroup): boolean {
  return g.key === 'length' ? t === lengthTag.value : recChips.value.includes(t)
}

function onChip(t: string, g: TagGroup) {
  if (g.key === 'length') {
    pickLength(t)
    return
  }
  const on = recChips.value.includes(t)
  let next = recChips.value.filter((x) => x !== t)
  if (!on) {
    // 单选组（频道）：同组里只留一个
    if (g.single) next = next.filter((x) => !g.tags.includes(x))
    next = [...next, t]
  }
  recChips.value = next
}

/** 从作品的 设定/ 目录把 md/txt 带进来 —— 写过的世界观不必再抄一遍 */
async function bringSettings() {
  if (!state.ref) return
  const parts: string[] = []
  for (const name of settingNames.value) {
    try {
      parts.push(`【${name.replace(/\.(md|txt)$/i, '')}】\n` + (await fs().readFile(state.ref, ['设定', name])))
    } catch {
      /* 读不到的跳过 */
    }
  }
  recMaterial.value = parts.join('\n\n')
  msg.value = parts.length ? `已带入 设定/ 里的 ${parts.length} 个文件（超过 12000 字会截断）` : '设定/ 里没有可带入的 md/txt 文件'
}

async function importMaterial(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files || [])
  ;(e.target as HTMLInputElement).value = ''
  if (!files.length) return
  const parts: string[] = recMaterial.value ? [recMaterial.value] : []
  for (const f of files) parts.push(`【${f.name.replace(/\.[^.]+$/, '')}】\n` + (await f.text()))
  recMaterial.value = parts.join('\n\n')
  msg.value = `已带入 ${files.length} 个文件`
}

async function askRecommend() {
  if (!aiEnabled()) return
  clampShape()
  /* 判据看的是「作者真的给了什么」——别拿 allTags 判：篇幅标签是由规模数字算出来的，
     永远非空，拿它当条件等于这道门根本没关。 */
  if (!recChips.value.length && !customTags.value.length && !recIdea.value.trim() && !recMaterial.value.trim() && !state.info.brief.trim()) {
    msg.value = '至少点几个标签、写一句想法、或带一点设定材料 —— 什么都不给的话，AI 只能凭空编一个故事。'
    return
  }
  busy.value = true
  msg.value = 'AI 正在推荐大纲…'
  try {
    const out = await generate({
      mode: 'outline',
      instruction: recommendPrompt({
        info: state.info,
        s: skeleton.value,
        tags: allTags.value,
        idea: recIdea.value,
        material: recMaterial.value
      }),
      n: 1
    })
    setDockTab('candidate')
    msg.value = out.length ? '推荐稿已进「候选」—— 看过、改过，再点「写入大纲文件」落盘' : '没有生成候选'
  } catch (e: any) {
    msg.value = `AI 生成失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    existing.value = await fs().readFile(state.ref!, ['大纲', '大纲.md'])
    if (existing.value.trim() && parsed.value) {
      tab.value = 'existing'
      syncShape(parsed.value)
    }
  } catch {
    /* 还没有大纲文件 */
  }
  try {
    const es = await fs().listDir(state.ref!, ['设定'])
    settingNames.value = es.filter((e) => e.kind === 'file' && /\.(md|txt)$/i.test(e.name)).map((e) => e.name)
  } catch {
    /* 还没有设定目录 */
  }
})
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>大纲与章纲</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="body col">
        <div class="row small">
          <button class="text small" :class="{ on: tab === 'new' }" @click="tab = 'new'">生成新骨架</button>
          <button class="text small" :class="{ on: tab === 'existing' }" @click="tab = 'existing'">用现有大纲</button>
          <button v-if="aiEnabled()" class="text small" :class="{ on: tab === 'recommend' }" @click="tab = 'recommend'">AI 推荐</button>
        </div>

        <!-- 规模：卷数与章数是作者定的（导入大纲后自动按大纲填好，随时可改） -->
        <div class="shape">
          <div class="spread small">
            <span class="dim">规模（自己定）</span>
            <span class="dim">约 {{ wanWords }} 万字</span>
          </div>
          <div class="row">
            <label class="small">卷数<input v-model.number="shape.volumes" type="number" min="1" max="60" @change="clampShape" /></label>
            <label class="small">章数<input v-model.number="shape.chapters" type="number" min="1" max="5000" @change="clampShape" /></label>
            <label class="small">每章字数<input v-model.number="shape.chapterWords" type="number" step="500" min="500" max="20000" @change="clampShape" /></label>
            <span v-if="tab === 'existing' && parsed" class="small dim grow">按大纲自动填的，可改</span>
          </div>
        </div>

        <textarea
          v-if="tab === 'existing'"
          v-model="existing"
          rows="7"
          class="md"
          spellcheck="false"
          placeholder="粘贴或直接编辑 大纲/大纲.md 的内容"
        ></textarea>

        <template v-else-if="tab === 'recommend'">
          <p class="small dim rec-hint">
            不按现有骨架补目标，而是让 AI 从零推荐一条故事线。标签、想法、设定材料可以任意组合 ——
            给得越具体，推荐越贴你的意思。
          </p>
          <div v-for="g in TAG_GROUPS" :key="g.key" class="col small tag-group">
            <span class="dim">{{ g.label }}<span class="g-hint">{{ g.single ? '（单选）' : '（可多选）' }}</span></span>
            <div class="chips tags">
              <button
                v-for="t in g.tags"
                :key="t"
                class="chip tchip"
                :class="{ on: chipOn(t, g) }"
                type="button"
                @click="onChip(t, g)"
              >
                {{ t }}
              </button>
            </div>
          </div>
          <div class="col small">
            <span class="dim">自定义标签 —— 用 <b>、</b> 或空格分隔，自己造词也行；里面含常用题材词（如「男频玄幻」）会自动认出来</span>
            <input v-model="recCustom" placeholder="例如：都市异能、克苏鲁、双男主、赛博修行……" />
          </div>
          <div class="col small">
            <span class="dim">想法 —— 想让 AI 知道的事（可留空）。它比标签更具体，AI 会优先照它写</span>
            <textarea
              v-model="recIdea"
              rows="3"
              class="idea"
              spellcheck="false"
              placeholder="例：主角是个失业的修表匠，金手指是能听见钟表的心跳；想慢热一点，别一上来就无敌。"
            ></textarea>
          </div>
          <div class="col small">
            <div class="spread">
              <span class="dim">世界观 / 人物设定材料（可留空）</span>
              <span class="row">
                <button v-if="settingNames.length" class="text small" :disabled="busy" @click="bringSettings">从 设定/ 带入（{{ settingNames.length }}）</button>
                <label class="text small" style="cursor: pointer">
                  导入 md / txt
                  <input type="file" accept=".md,.markdown,.txt" multiple style="display: none" @change="importMaterial" />
                </label>
                <button v-if="recMaterial" class="text small" @click="recMaterial = ''">清空</button>
              </span>
            </div>
            <textarea v-model="recMaterial" rows="5" class="md" spellcheck="false" placeholder="粘贴世界观、人物设定、力量体系……留空则只按上面的标签与想法推荐"></textarea>
            <span v-if="recMaterial" class="dim">{{ recMaterial.length.toLocaleString() }} 字（超过 12000 字会截断）</span>
          </div>
          <p v-if="allTags" class="small dim seen-tags">AI 会看到这些标签：<b>{{ allTags }}</b></p>
          <p class="small dim">推荐稿进「候选区」，点「写入大纲文件」才落盘 —— 不满意就再点一次推荐，换个思路。</p>
        </template>

        <!-- 只到卷这一层：第×卷（第A章-第B章）+ 卷目标留白。
             章这一层不在这里铺开 —— 逐章罗列几十个「第几章」没有信息量，
             章纲走 表格留白（写入大纲文件）/ 导入 / AI 补 三条路。 -->
        <div class="prev" v-if="tab !== 'recommend'">
          <div v-for="(v, i) in active.volumes" :key="v.name + i" class="vol">
            <div class="spread">
              <b class="small">{{ v.name }}<span v-if="v.start && v.end" class="dim">（第{{ v.start }}章-第{{ v.end }}章）</span></b>
              <span v-if="tab === 'existing' && v.target" class="small dim">{{ v.target }}</span>
            </div>
            <input
              v-if="tab === 'new'"
              v-model="volTargets[i]"
              placeholder="卷目标（可留空）：这一卷要讲什么"
            />
          </div>
          <p v-if="!active.volumes.length" class="small dim">还没有卷 —— 先在上面定好卷数与章数。</p>
        </div>

        <p class="small dim" v-if="tab !== 'recommend'">
          章纲只铺「第x章」坑位、目标留白 —— 自己写、从 Word / md 导入、或让 AI 补，三种都行；写进 大纲/大纲.md 后随时手改。
        </p>
        <div v-if="msg" class="small dim">{{ msg }}</div>

        <div class="row wrap">
          <button class="text small" :disabled="busy" @click="emit('import-outline')">从 Word / md 文件导入…</button>
        </div>

        <div class="row">
          <button class="primary" :class="{ ghost: tab === 'recommend' }" :disabled="busy" @click="writeFile">写入大纲文件</button>
          <button :disabled="busy" @click="buildChapters">同时建章节文件</button>
          <button v-if="aiEnabled() && tab !== 'recommend'" :disabled="busy" @click="askAi">让 AI 补章纲</button>
          <button v-if="aiEnabled() && tab === 'recommend'" class="primary" :disabled="busy" @click="askRecommend">
            {{ busy ? '推荐中…' : '让 AI 推荐大纲' }}
          </button>
          <button @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 560px;
  max-height: 86vh;
}
.wrap {
  flex-wrap: wrap;
}
/* 规模三件套：贴在一起，一眼能看出「这几个数是跟着我走的」 */
.shape {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.shape label.small {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-soft);
  white-space: nowrap;
}
.shape input {
  width: 84px;
}
label.small {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-soft);
}
.md {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  min-height: 120px;
  resize: vertical;
}
/* 「想法」是散文，别用等宽字体 */
.idea {
  font-size: 13px;
  min-height: 66px;
  resize: vertical;
}
.prev {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  max-height: 220px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
}
.prev p {
  margin: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.tag-group {
  gap: 0;
}
.g-hint {
  opacity: 0.65;
}
/* 推荐页的标签是「点选」的，得像按钮；.chip 原本只是个静态小方块 */
.tags {
  margin-top: 0;
}
.tchip {
  cursor: pointer;
  background: var(--bg-field);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  transition: color 0.14s ease, border-color 0.14s ease, background-color 0.14s ease;
}
.tchip:hover {
  color: var(--text);
  border-color: var(--accent);
}
.tchip.on {
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}
.rec-hint {
  margin: 0;
  line-height: 1.7;
}
.seen-tags {
  margin: 0;
  line-height: 1.6;
}
/* 推荐页里主按钮让给「让 AI 推荐大纲」，落盘动作退居次位 */
.primary.ghost {
  background: var(--bg-field);
  color: var(--text);
  border: 1px solid var(--line);
}
.chip {
  font-size: 11px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 1px 6px;
  color: var(--text-dim);
}
button.text.on {
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
