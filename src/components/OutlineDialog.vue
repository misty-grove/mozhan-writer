<script setup lang="ts">
/**
 * 大纲与章纲（P1-19）
 * 先把坑位铺好（本地，0 token），再决定要不要让 AI 补每章的目标。
 */
import { computed, onMounted, ref, watch } from 'vue'
import fs from '@/platform'
import { buildSkeleton, outlinePrompt, parseOutlineMarkdown, recommendPrompt, toOutlineMarkdown, type Skeleton } from '@/core/outline'
import { createVolume } from '@/core/workspace'
import { newChapter, refresh, state } from '@/stores/workspace'
import { aiEnabled } from '@/core/settings'
import { generate } from '@/stores/ai'
import { setDockTab } from '@/stores/editor'

const emit = defineEmits<{ (e: 'close'): void; (e: 'import-outline'): void }>()

const targetWords = ref(state.info.targetWords || 200000)
const chapterWords = ref(3000)
const volumes = ref(0)
const busy = ref(false)
const msg = ref('')
const tab = ref<'new' | 'existing' | 'recommend'>('new')
const existing = ref('')

/* ------------------------------------------------------------------ AI 推荐
 * 两种入口：带着世界观/人物设定材料推荐（材料是事实来源），或只给几个题材标签。
 * 产出进候选区，作者点「写入大纲文件」才落盘 —— 和补章纲同一条规矩。
 */
const recTags = ref('')
const recMaterial = ref('')
const settingNames = ref<string[]>([])
/** 常见题材标签：点一下就追加，比让作者凭空想词快得多 */
const TAG_CHIPS = ['同人', '玄幻', '仙侠', '都市', '科幻', '悬疑', '历史', '游戏', '无限流', '种田', '群像', '轻松', '多女主', '单女主', '无敌流', '慢热']

function pickTag(t: string) {
  const set = new Set(
    recTags.value
      .split(/[、,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  )
  if (set.has(t)) set.delete(t)
  else set.add(t)
  recTags.value = [...set].join('、')
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
  if (!recTags.value.trim() && !recMaterial.value.trim() && !state.info.brief.trim()) {
    msg.value = '至少给几个标签或一点设定材料 —— 什么都不给的话，AI 只能凭空编一个故事。'
    return
  }
  busy.value = true
  msg.value = 'AI 正在推荐大纲…'
  try {
    const out = await generate({
      mode: 'outline',
      instruction: recommendPrompt({ info: state.info, s: skeleton.value, tags: recTags.value, material: recMaterial.value }),
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

const skeleton = computed<Skeleton>(() =>
  buildSkeleton({ title: state.info.title || '未命名', targetWords: targetWords.value, chapterWords: chapterWords.value, volumes: volumes.value })
)

/* 卷目标：留白由作者自己填。骨架随字数输入实时变化，这里按卷序号对齐保存已输入的值 */
const volTargets = ref<string[]>([])
watch(
  () => skeleton.value.volumes.length,
  (n) => {
    while (volTargets.value.length < n) volTargets.value.push('')
    volTargets.value.length = n
  },
  { immediate: true }
)

/** 落盘 / 建章 / 喂 AI 用的是「骨架 + 作者填的卷目标」 */
const finalSkeleton = computed<Skeleton>(() => {
  if (tab.value === 'existing' && parsed.value) return parsed.value
  const s = skeleton.value
  return { ...s, volumes: s.volumes.map((v, i) => ({ ...v, target: (volTargets.value[i] || '').trim() })) }
})

const totalChapters = computed(() => skeleton.value.volumes.reduce((n, v) => n + v.chapters.length, 0))

const parsed = computed(() => {
  if (tab.value !== 'existing' || !existing.value.trim()) return null
  const s = parseOutlineMarkdown(existing.value)
  return s.volumes.length ? s : null
})

const active = computed(() => (tab.value === 'existing' && parsed.value ? parsed.value : skeleton.value))

onMounted(async () => {
  try {
    existing.value = await fs().readFile(state.ref!, ['大纲', '大纲.md'])
    if (existing.value.trim()) tab.value = 'existing'
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

async function writeFile() {
  if (!state.ref) return
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

        <div v-if="tab === 'new'" class="grid3">
          <label class="small">目标字数<input v-model.number="targetWords" type="number" step="10000" min="1000" /></label>
          <label class="small">每章字数<input v-model.number="chapterWords" type="number" step="500" min="500" /></label>
          <label class="small">卷数（0=自动）<input v-model.number="volumes" type="number" min="0" max="12" /></label>
        </div>
        <textarea v-else-if="tab === 'existing'" v-model="existing" rows="8" class="md" spellcheck="false" placeholder="粘贴或直接编辑 大纲/大纲.md 的内容"></textarea>

        <template v-else>
          <p class="small dim rec-hint">
            不按现有骨架补目标，而是让 AI 从零推荐一条故事线：可以带着世界观和人物设定（材料是事实来源），也可以只给几个题材标签。
          </p>
          <div class="col small">
            <div class="spread">
              <span class="dim">题材标签（点选，可叠加）</span>
              <span v-if="recTags" class="dim">已选：{{ recTags }}</span>
            </div>
            <div class="chips tags">
              <button
                v-for="t in TAG_CHIPS"
                :key="t"
                class="chip tchip"
                :class="{ on: recTags.split(/[、,，\s]+/).includes(t) }"
                type="button"
                @click="pickTag(t)"
              >
                {{ t }}
              </button>
            </div>
            <input v-model="recTags" placeholder="也可以直接打字：同人、悬疑、双女主……" />
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
            <textarea v-model="recMaterial" rows="6" class="md" spellcheck="false" placeholder="粘贴世界观、人物设定、力量体系……留空则只按标签推荐"></textarea>
            <span v-if="recMaterial" class="dim">{{ recMaterial.length.toLocaleString() }} 字（超过 12000 字会截断）</span>
          </div>
          <p class="small dim">推荐稿进「候选区」，点「写入大纲文件」才落盘 —— 不满意就再点一次推荐，换个思路。</p>
        </template>

        <div class="spread small">
          <span>共 {{ active.volumes.length }} 卷 · {{ tab === 'existing' && parsed ? parsed.volumes.reduce((n, v) => n + v.chapters.length, 0) : totalChapters }} 章</span>
          <span class="dim">每章约 {{ active.chapterWords }} 字</span>
        </div>

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
  max-height: 84vh;
}
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.wrap {
  flex-wrap: wrap;
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
  min-height: 140px;
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
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
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
