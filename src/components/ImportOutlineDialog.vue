<script setup lang="ts">
/**
 * 导入大纲 —— 大纲相关功能的汇总窗（窗口名保持「导入大纲」，入口不变）。
 *
 * 四个页签：
 *  ① 导入        —— 原有本职：选 Word / md / txt 或粘贴 → 认出卷章层级 → 预览 → 落盘。
 *  ② 生成新骨架  —— 原「大纲」窗口的规模三件套（卷数 / 章数 / 每章字数）+ 写入大纲文件 + 建章。
 *  ③ 用现有大纲  —— 原「大纲」窗口的 textarea：直接编辑 大纲/剧情大纲.md，规模按大纲自动填。
 *  ④ AI 推荐     —— 原「大纲」窗口的 AI 部分：标签 / 想法 / 材料 → 推荐故事线（进候选区）。
 *
 * 合并的缘由（作者原话）：「将现在大纲处的功能合并进导入大纲里面，AI大纲部分也一齐移入」——
 * 作者只想在一个地方把大纲这件事办完，不想在两个入口之间猜「哪边才是干这个的」。
 * 「查看已导入的内容」是另一个窗口（顶栏「大纲」）的活，所以这里给一个跳过去的按钮。
 *
 * 两条底线（导入侧原样保留）：
 * 1. **看清楚再写**：导入前一定给预览，写进哪个文件也写在按钮旁边。
 * 2. **只追加**：目标文件已存在时默认追加在后面，覆盖要作者自己勾。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import fs from '@/platform'
import { docxToMarkdown } from '@/core/docxRead'
import { applyOutline, parseOutlineText, treeStats, type OutlineMode } from '@/core/importOutline'
import { cleanOutlineNoise } from '@/core/textClean'
import { decodeText } from '@/core/importDoc'
import { createVolume, DIRS } from '@/core/workspace'
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
import { rememberTags } from '@/core/worldbuild'
import { newChapter, refresh, state } from '@/stores/workspace'
import { aiEnabled } from '@/core/settings'
import { generate } from '@/stores/ai'
import { setDockTab } from '@/stores/editor'
import WinBox from './WinBox.vue'

const emit = defineEmits<{ (e: 'close'): void; (e: 'view-outline'): void }>()

/** 四个页签：导入（默认）+ 原「大纲」窗口的三页原样搬入 */
const tab = ref<'import' | 'new' | 'existing' | 'recommend'>('import')
const busy = ref(false)
const msg = ref('')
const err = ref('')

/* ================================================================ 导入侧 */
const mode = ref<OutlineMode>('volume')
const text = ref('')
const fileName = ref('')
const source = ref('') // 编码 / 转换说明
const warnings = ref<string[]>([])
const createChapters = ref(false)
const overwrite = ref(false)
const picked = ref<boolean[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

/**
 * 「顺带建章节坑位」的默认值跟着模式走：
 *  - 卷纲模式默认**不建** —— 作者要的是「这卷发生了什么」，章节他自己排；
 *    默认建一堆空章，目录当场被撑爆（用户原话：导入卷纲后目录应该只有
 *    分卷故事梗概和可以新建章节的区域）。
 *  - 章纲模式默认建 —— 那一整份文档就是按章组织的，对不上的建个坑位才接得上。
 */
watch(mode, (m) => {
  createChapters.value = m === 'chapter'
})

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
    how: '整篇写进大纲文件，AI 续写时会当作最高层上下文；之后在顶栏「大纲」处随时翻看。'
  },
  volume: {
    label: '卷纲',
    where: '正文/第XX卷/卷纲.md',
    how: '每卷建目录并写卷纲（分卷故事梗概）；默认不动章节，要连章节坑位一起建再勾下面的框。'
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
    let raw = ''
    if (/\.docx$/i.test(name)) {
      const r = docxToMarkdown(buf)
      if (!r.text.trim()) {
        err.value = '这个 Word 文档里没读到文字（可能是扫描件，或内容都在图片 / 文本框里）。'
        msg.value = ''
        return
      }
      raw = r.text
      source.value = `Word：${r.paragraphs} 段 · ${r.tables} 张表`
      warnings.value = r.warnings
    } else if (/\.doc$/i.test(name)) {
      err.value = '老版 .doc 是二进制格式读不了 —— 请用 Word 另存为 .docx 或 .md 再来。'
      msg.value = ''
      return
    } else {
      const dec = decodeText(buf)
      raw = dec.text
      source.value = `文本：${dec.encoding}${dec.suspicious ? '（有乱码风险）' : ''}`
      if (dec.suspicious) warnings.value = [`解码时出现 ${dec.suspicious} 个无法识别的字符，建议先另存为 UTF-8。`]
    }
    // AI 生成的文档常带零宽字符、起强调作用的引号、emoji —— 落盘前先洗干净
    text.value = cleanOutlineNoise(raw)
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

/* ================================================================ 规模 / 骨架（原大纲窗口） */
/**
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

/* ================================================================ 用现有大纲（原大纲窗口） */
const existing = ref('')

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
    // 全书大纲只有一个家：大纲/剧情大纲.md —— 跟「导入」页的落点一致，
    // 免得作者在目录里看到两份大纲，不知道哪份算数。
    await fs().writeFile(state.ref, ['大纲', '剧情大纲.md'], toOutlineMarkdown(finalSkeleton.value, state.info.brief))
    msg.value = '已写入 大纲/剧情大纲.md —— 顶栏「大纲」里就能看到'
    await refresh(false)
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

/* ================================================================ AI 推荐（原大纲窗口） */
/**
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

/* 标签本身不落盘，但「生成设定」要用它 —— 作者点一次标签，之后开设定面板
   不该再点一遍。这里在标签变化时把最终那串存下来（界面显示的与存的是同一串，
   避免「看到的」和「AI 收到的」不一致）。 */
watch(allTags, (v) => rememberTags(v))

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
    rememberTags(allTags.value)
    msg.value = out.length ? '推荐稿已进「候选」—— 看过、改过，再点「写入大纲文件」落盘' : '没有生成候选'
  } catch (e: any) {
    msg.value = `AI 生成失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    // 老作品的大纲可能还叫 大纲.md：先读新家，没有再读旧的（只读一次，不迁移文件）
    try {
      existing.value = await fs().readFile(state.ref!, ['大纲', '剧情大纲.md'])
    } catch {
      existing.value = await fs().readFile(state.ref!, ['大纲', '大纲.md'])
    }
    if (existing.value.trim() && parsed.value) syncShape(parsed.value)
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
  <WinBox title="导入大纲" :width="780" :height="640" store-key="import-outline" @close="emit('close')">
    <template #extra>
      <button class="text small" title="看这本书已经导入好的全书大纲与各卷卷纲" @click="emit('view-outline')">
        查看本书大纲
      </button>
    </template>

    <!-- 页签：导入是本职，原「大纲」窗口三页原样搬入 -->
    <div class="row small tabs">
      <button class="text small" :class="{ on: tab === 'import' }" :disabled="busy" @click="tab = 'import'">导入</button>
      <button class="text small" :class="{ on: tab === 'new' }" :disabled="busy" @click="tab = 'new'">生成新骨架</button>
      <button class="text small" :class="{ on: tab === 'existing' }" :disabled="busy" @click="tab = 'existing'">用现有大纲</button>
      <button v-if="aiEnabled()" class="text small" :class="{ on: tab === 'recommend' }" :disabled="busy" @click="tab = 'recommend'">
        AI 推荐
      </button>
    </div>

    <!-- 规模：三个输入框跟着「生成新骨架 / 用现有大纲 / AI 推荐」三页走（推荐页点篇幅档改的就是它），
         导入页不显示 —— 那边的卷章数由粘贴的大纲说了算。 -->
    <div v-if="tab !== 'import'" class="shape">
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

    <!-- ============================================================ 导入页 -->
    <template v-if="tab === 'import'">
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
      <p class="small dim">选文件，或者把大纲直接粘到下面这个框里 —— 两种办法读进来之后都一样。</p>

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

      <div class="row act-bar">
        <button class="primary" :disabled="busy || !ready" @click="doImport">
          <template v-if="mode === 'book'">写入全书大纲</template>
          <template v-else-if="mode === 'volume'">导入 {{ pickedVolumes.length }} 卷的卷纲</template>
          <template v-else>导入 {{ pickedChapters }} 条章纲</template>
        </button>
        <button :disabled="busy" @click="emit('close')">关闭</button>
      </div>
    </template>

    <!-- ============================================================ 生成新骨架 / 用现有大纲 -->
    <template v-else-if="tab === 'new' || tab === 'existing'">
      <textarea
        v-if="tab === 'existing'"
        v-model="existing"
        rows="7"
        class="md"
        spellcheck="false"
        placeholder="粘贴或直接编辑 大纲/剧情大纲.md 的内容"
      ></textarea>

      <!-- 只到卷这一层：第×卷（第A章-第B章）+ 卷目标留白。
           章这一层不在这里铺开 —— 逐章罗列几十个「第几章」没有信息量，
           章纲走 表格留白（写入大纲文件）/ 导入 / AI 补 三条路。 -->
      <div class="prev">
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

      <p class="small dim">
        章纲只铺「第x章」坑位、目标留白 —— 自己写、从 Word / md 导入、或让 AI 补，三种都行；写进 大纲/剧情大纲.md 后随时手改。
      </p>
      <div v-if="msg" class="small dim">{{ msg }}</div>

      <div class="row act-bar">
        <button class="primary" :disabled="busy" @click="writeFile">写入大纲文件</button>
        <button :disabled="busy" @click="buildChapters">同时建章节文件</button>
        <button v-if="aiEnabled()" :disabled="busy" @click="askAi">让 AI 补章纲</button>
        <button class="text small" :disabled="busy" @click="tab = 'import'">从 Word / md 文件导入…</button>
      </div>
    </template>

    <!-- ============================================================ AI 推荐 -->
    <template v-else>
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
      <div v-if="msg" class="small dim">{{ msg }}</div>

      <div class="row act-bar">
        <button class="primary" :disabled="busy" @click="askRecommend">{{ busy ? '推荐中…' : '让 AI 推荐大纲' }}</button>
        <button :disabled="busy" @click="writeFile">写入大纲文件</button>
        <button class="text small" :disabled="busy" @click="tab = 'import'">从 Word / md 文件导入…</button>
      </div>
    </template>
  </WinBox>
</template>

<style scoped>
.tabs {
  gap: 2px;
  border-bottom: 1px solid var(--line-soft);
  padding-bottom: 6px;
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
/* 手机上弹窗是底部抽屉：预览区按视口高度收，别把「导入」按钮顶出屏幕 */
html.ua-mobile .prev {
  max-height: 32vh;
}
/* 底部操作条吸底：内容再长也够得着按钮 */
.act-bar {
  position: sticky;
  bottom: 0;
  margin-top: auto;
  padding: 10px 0 2px;
  background: var(--bg-elev);
  border-top: 1px solid var(--line-soft);
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
/* ------------------------------------------------ 规模 / 骨架（原大纲窗口样式） */
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
/* 「想法」是散文，别用等宽字体 */
.idea {
  font-family: inherit;
  font-size: 13px;
  min-height: 66px;
  resize: vertical;
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
.grow {
  flex: 1;
}
</style>
