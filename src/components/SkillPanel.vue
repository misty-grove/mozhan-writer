<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import fs, { hostInfo, peekHost } from '@/platform'
import { aiState, enabled, loadSkills } from '@/stores/ai'
import * as sk from '@/core/skills'
import { settings } from '@/core/settings'
import { download } from '@/core/exportDoc'
import { agentSkillsDir } from '@/platform/aiBridge'
import { state } from '@/stores/workspace'
import { askConfirm } from '@/stores/dialog'
import type { Skill } from '@/core/types'

// 移动端没有目录选择器：靠选文件夹导入技能的入口在那里用不了，直接不显示，
// 而不是让人点完才发现没反应。
const mobile = ref(!!peekHost()?.isMobile)
onMounted(async () => {
  mobile.value = (await hostInfo()).isMobile
})

const editing = ref<Skill | null>(null)
const importing = ref(false)
const notice = ref('')
const filter = ref('')

const list = computed(() => aiState.skills.filter((s) => !filter.value || s.name.includes(filter.value) || s.description.includes(filter.value)))

async function toggle(s: Skill, on: boolean) {
  sk.setSkillEnabled(s.name, on)
  await loadSkills()
}

async function pickLibrary() {
  const d = await fs().pickDir('选择全局技能库目录')
  if (!d) return
  settings.skillLibrary = { id: d.id, name: d.name }
  await loadSkills()
}

/**
 * 一键接入本机 DSH 的技能库（`~/.dsh/skills`）。
 *
 * 为什么值得一个按钮：DSH 那边装了 50 来个技能，其中十多个跟小说写作直接相关
 * （`continuation` 断点续写、`long-memory` 记忆维护、`style-imitation` 文风仿写…）。
 * 这些技能就是纯文本提示词，读进来不联网、不花钱，接上就能喂给应用自己的 API 引擎。
 * 原来的路是「先自己知道 ~/.dsh/skills 在哪，再逐个点选文件夹」—— 对一个
 * 只想写小说的作者来说门槛太高了。
 */
const dshBusy = ref(false)
async function useDshLibrary() {
  dshBusy.value = true
  try {
    const r = await agentSkillsDir()
    if (!r.found || !r.path) {
      notice.value = r.path
        ? `没找到 DSH 技能库（${r.path} 不存在）—— 装过 DSH 再用这个入口`
        : '没找到 DSH 技能库（需要桌面端，且本机装过 DSH）'
      return
    }
    // 直接用绝对路径当 DirRef id：桌面端 DirRef.id 本身就是路径（同 Agent 的 cwd）
    settings.skillLibrary = { id: r.path, name: r.path.split(/[\\/]/).pop() || 'skills' }
    await loadSkills()
    const n = aiState.skills.length
    notice.value = `已接入 DSH 技能库（发现 ${r.count} 个技能，合并后共 ${n} 个）`
  } catch (e: any) {
    notice.value = `接入失败：${e?.message || e}`
  } finally {
    dshBusy.value = false
  }
}

async function importFolder() {
  const d = await fs().pickDir('选择含 SKILL.md 的技能文件夹')
  if (!d || !state.ref) return
  const n = await sk.importFromFolder(d, state.ref)
  notice.value = `导入了 ${n} 个技能`
  await loadSkills()
}

/**
 * 导入散装文件：zip（可以是一整个技能包），或单个 .md/.txt/.markdown。
 *
 * 单文件这条路上原来没有 —— 作者手里最常见的形态恰恰就是一个 SKILL.md
 * （或从别的工具导出的一份提示词），却必须先打成 zip 或摆成目录才能进。
 * 文件名做兜底技能名：frontmatter 里没写 name 的，总不能叫「未命名技能」。
 */
async function importFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files || [])
  ;(e.target as HTMLInputElement).value = ''
  if (!files.length) return
  if (!state.ref) {
    notice.value = '先打开一部作品 —— 导入的技能存进作品的「技能/」目录。'
    return
  }
  importing.value = true
  try {
    let n = 0
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        n += await sk.importFromZip(f, state.ref)
        continue
      }
      const raw = await f.text()
      const parsed = sk.parseSkillFile(raw, 'work', f.name)
      const fallback = f.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '_') || '未命名技能'
      const name = !parsed.name || parsed.name === '未命名技能' || /\.(md|markdown|txt)$/i.test(parsed.name) ? fallback : parsed.name
      await sk.saveWorkSkill(state.ref, { ...parsed, name, content: parsed.content || raw })
      n++
    }
    notice.value = `导入了 ${n} 个技能`
    await loadSkills()
  } catch (err: any) {
    notice.value = `导入失败：${err?.message || err}`
  } finally {
    importing.value = false
  }
}

function newSkill() {
  editing.value = {
    id: 'tmp',
    name: '',
    slug: '',
    description: '',
    allowedTools: [],
    source: 'work',
    enabled: true,
    content: '# 技能正文\n\n## 何时使用\n\n## 流程\n\n## 输出格式\n'
  }
}

async function saveSkill() {
  if (!editing.value || !state.ref) return
  const s = editing.value
  if (!s.name.trim()) {
    notice.value = '技能名不能为空'
    return
  }
  await sk.saveWorkSkill(state.ref, { ...s, name: s.name.trim() })
  editing.value = null
  await loadSkills()
}

async function remove(s: Skill) {
  if (s.source !== 'work' || !state.ref) return
  const ok = await askConfirm({
    title: `删除作品内技能「${s.name}」`,
    message: '该技能会从作品的「技能」目录里移除。',
    detail: ['内置技能不受影响，需要时随时能再装回来'],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  await sk.deleteWorkSkill(state.ref, s)
  await loadSkills()
}

function exportOne(s: Skill) {
  sk.exportSkillZip(s).then((b) => download(b, `${s.name}.zip`))
}

const sample = computed(() => (!editing.value ? '' : ''))
</script>

<template>
  <div class="sk">
    <div class="spread">
      <b class="tt">技能</b>
      <div class="row">
        <button class="text small" @click="newSkill">＋新建</button>
        <button v-if="!mobile" class="text small" @click="pickLibrary">指定技能库目录</button>
      </div>
    </div>
    <p v-if="!enabled" class="small dim">技能随 AI 层启用；配置 API 后才能调用。</p>
    <p class="small dim">加载优先级：作品内 <code>技能/</code> &gt; 全局技能库 &gt; 内置技能（同名覆盖）。</p>

    <div class="row small">
      <input v-model="filter" placeholder="搜索技能" />
      <button v-if="!mobile" class="text small" @click="importFolder">导入文件夹</button>
      <label class="text small" style="cursor: pointer">
        导入文件（zip / md）
        <input type="file" accept=".zip,.md,.markdown,.txt" multiple style="display: none" @change="importFiles" />
      </label>
    </div>
    <div v-if="!mobile" class="row small">
      <button class="text small" :disabled="dshBusy" @click="useDshLibrary">
        {{ dshBusy ? '查找中…' : '一键接入 DSH 技能库' }}
      </button>
      <span class="dim">把本机 DSH 装的写作技能直接读进来，不用手动找目录</span>
    </div>
    <div v-if="settings.skillLibrary" class="small dim">全局技能库：{{ settings.skillLibrary.name }}</div>
    <div v-if="notice" class="small dim">{{ notice }}</div>

    <div v-if="editing" class="panel edit">
      <div class="row">
        <input v-model="editing.name" placeholder="技能名（唯一标识）" />
      </div>
      <div class="row">
        <input
          v-model="editing.slug"
          placeholder="英文标识 slug（可留空，自动生成）—— 外部 Agent 用它认这个技能"
        />
      </div>
      <textarea v-model="editing.description" rows="2" placeholder="description：决定 AI 何时自动加载它，写清楚触发场景"></textarea>
      <textarea v-model="editing.content" rows="16" placeholder="技能正文：流程 / 规范 / 输出格式"></textarea>
      <div class="row">
        <button class="primary" @click="saveSkill">保存到 作品/技能/</button>
        <button @click="editing = null">取消</button>
        <span class="small dim">allowed-tools 由正文决定，脚本默认不执行</span>
      </div>
    </div>

    <div class="list">
      <div v-for="s in list" :key="s.id" class="item">
        <div class="spread">
          <div class="row">
            <input type="checkbox" :checked="s.enabled" style="width: auto" @change="toggle(s, ($event.target as any).checked)" />
            <b class="nm">{{ s.name }}</b>
            <span class="tag small">{{ s.source === 'builtin' ? '内置' : s.source === 'work' ? '作品内' : '全局' }}</span>
            <span v-if="s.slug" class="tag small mono" :title="`给外部 Agent（DSH）用的英文标识：投递时目录名是 mozhan-${s.slug}-*`">{{ s.slug }}</span>
          </div>
          <div class="row">
            <button v-if="s.source === 'work'" class="text small" @click="editing = { ...s }">编辑</button>
            <button class="text small" @click="exportOne(s)">导出</button>
            <button v-if="s.source === 'work'" class="text small" @click="remove(s)">删除</button>
          </div>
        </div>
        <div class="small dim">{{ s.description || '（无描述：AI 不会自动判断何时用它）' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sk {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.code,
code {
  font-family: Consolas, monospace;
  font-size: 11px;
  background: var(--line-soft);
  padding: 0 4px;
  border-radius: 3px;
}
.edit {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit textarea {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 56vh;
  overflow: auto;
}
.item {
  border-bottom: 1px dashed var(--line-soft);
  padding-bottom: 8px;
}
.nm {
  font-size: 13px;
}
</style>
