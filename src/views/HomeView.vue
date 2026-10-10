<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import fs, { degradedMode, hostInfo, peekHost } from '@/platform'
import type { DirRef, HostInfo } from '@/platform'
import { settings, removeRecent, aiEnabled } from '@/core/settings'
import { clearCache } from '@/core/indexCache'
import { DEGRADE_NOTICE, fsaRequiredHint, isSandboxRefId, visibleRecents } from '@/core/degrade'
import * as wsApi from '@/core/workspace'
import * as store from '@/stores/workspace'
import { discardSandbox, createSandbox, importFolder, persistedHint, resumePersisted, type PersistedHint } from '@/stores/sandbox'
import { askConfirm } from '@/stores/dialog'
import type { WorkInfo } from '@/core/types'
import SettingsDialog from '@/components/SettingsDialog.vue'

const creating = ref(false)
const newName = ref('')
const newAuthor = ref('')
const newTarget = ref(0)
const busy = ref(false)
const notice = ref('')
const err = ref('')

/* 首页也要能进设置 —— 尤其是配 AI：不开作品时这里是唯一入口 */
const showSettings = ref(false)
const settingsTab = ref<'ai' | 'type' | 'general'>('ai')
function openSettings(tab: 'ai' | 'type' | 'general') {
  settingsTab.value = tab
  showSettings.value = true
}

/** 降级模式：拿不到本机目录写权限（Firefox / Safari），或显式要求（?sandbox=1） */
const degraded = degradedMode()
const supported = !degraded

/* ------------------------------------------------------------------ 降级模式 */

const folderInput = ref<HTMLInputElement | null>(null)
const createBox = ref(false)
const sbxName = ref('')
const hint = ref<PersistedHint | null>(null)
/** 这个浏览器里存着、但打不开的作品（它们需要 FSA） */
const lockedRecents = computed(() => (degraded ? settings.recent.filter((r) => !isSandboxRefId(r.refId)) : []))

onMounted(async () => {
  host.value = await hostInfo()
  if (mobile.value) await loadLibrary()
  if (!degraded) return
  hint.value = await persistedHint()
})

function pickFolder() {
  err.value = ''
  folderInput.value?.click()
}

async function onFolderPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const list = input.files
  if (!list || !list.length) return
  busy.value = true
  err.value = ''
  try {
    const r = await importFolder(list)
    if (!r.ok) err.value = r.text
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
    input.value = '' // 同一个文件夹再选一次也要能触发 change
  }
}

async function doCreateSandbox() {
  busy.value = true
  err.value = ''
  try {
    const r = await createSandbox(sbxName.value)
    if (!r.ok) err.value = r.text
    else createBox.value = false
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function resume() {
  busy.value = true
  err.value = ''
  try {
    const ok = await resumePersisted()
    if (!ok) err.value = '浏览器里那份沙盒读不出来了，请重新导入作品文件夹。'
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function dropHint() {
  const ok = await askConfirm({
    title: '丢弃浏览器里的沙盒副本',
    message: '浏览器里存的那份会删掉。磁盘上原来的文件夹不受影响。',
    detail: [`作品：${hint.value?.name || ''}`, hint.value?.dirty ? `其中 ${hint.value.dirty} 个文件还没导出` : '没有未导出的改动'],
    okText: '丢弃',
    danger: true
  })
  if (!ok) return
  await discardSandbox()
  hint.value = null
}

const recentList = computed(() => visibleRecents(settings.recent, degraded))

/* ------------------------------------------------------------------ 移动端作品库 */

/**
 * 安卓上没有目录选择器（WebView 不给 `showDirectoryPicker`），
 * 所以换成**作品库**：应用自己的文档目录下一个子目录就是一部作品。
 * 根目录由 Rust 侧 `app_host_info` 给出（它保证目录已存在），前端不猜路径。
 */
const host = ref<HostInfo | null>(peekHost())
const mobile = computed(() => !!host.value?.isMobile)

interface LibItem {
  name: string
  title: string
}
const libWorks = ref<LibItem[]>([])
const libBusy = ref(false)
const libCreating = ref(false)
const libName = ref('')
const libAuthor = ref('')

function libRoot(): DirRef | null {
  const h = host.value
  if (!h?.worksRoot) return null
  return { id: h.worksRoot, name: h.worksRootName || '作品库' }
}

async function loadLibrary() {
  const root = libRoot()
  if (!root) return
  libBusy.value = true
  err.value = ''
  try {
    const entries = await fs().listDir(root, [])
    const items: LibItem[] = []
    for (const e of entries) {
      if (e.kind !== 'dir') continue
      let title = e.name
      try {
        const info = await wsApi.readWorkInfo(fs().joinRef(root, e.name))
        if (info.title) title = info.title
      } catch {
        // 读不到作品信息就用目录名 —— 作者手工拷进去的文件夹不该因此打不开
      }
      items.push({ name: e.name, title })
    }
    libWorks.value = items
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    libBusy.value = false
  }
}

async function openLibWork(item: LibItem) {
  const root = libRoot()
  if (!root) return
  busy.value = true
  err.value = ''
  try {
    const ok = await store.openWork(fs().joinRef(root, item.name))
    if (!ok) err.value = '打不开这部作品'
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function createLibWork() {
  const root = libRoot()
  if (!root || !libName.value.trim()) return
  busy.value = true
  err.value = ''
  try {
    const ref = await store.createWork(root, libName.value.trim(), {
      author: libAuthor.value
    } as Partial<WorkInfo>)
    libCreating.value = false
    libName.value = ''
    await store.openWork(ref)
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function removeLibWork(item: LibItem) {
  const root = libRoot()
  if (!root) return
  const ok = await askConfirm({
    title: `删除《${item.title}》`,
    message: '整部作品（正文、大纲、设定、记忆）都会从作品库里删掉，删了找不回来。',
    detail: ['建议先做一次备份再删。'],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  busy.value = true
  err.value = ''
  try {
    await fs().remove(root, [item.name])
    await loadLibrary()
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------------------------ 正常模式 */

async function pickNewWorkFolder() {
  err.value = ''
  const parent = await fs().pickDir('选择新建作品所在的文件夹')
  if (!parent) return
  newName.value = '未命名作品'
  creating.value = true
  pendingParent.value = parent
}

const pendingParent = ref<any>(null)

async function doCreate() {
  if (!pendingParent.value || !newName.value.trim()) return
  busy.value = true
  try {
    const ref = await store.createWork(pendingParent.value, newName.value.trim(), {
      author: newAuthor.value,
      targetWords: Number(newTarget.value) || 0
    } as Partial<WorkInfo>)
    await store.openWork(ref)
    creating.value = false
    pendingParent.value = null
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function openExisting() {
  err.value = ''
  const ref = await fs().pickDir('选择作品根目录（含 大纲 / 设定 / 正文）')
  if (!ref) return
  busy.value = true
  try {
    const ok = await store.openWork(ref)
    if (!ok) err.value = '无法打开该目录'
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function openRecent(r: any) {
  err.value = ''
  busy.value = true
  try {
    const ok = await store.openWork({ id: r.refId, name: r.pathLabel })
    if (!ok) err.value = '目录权限已失效，请重新选择该作品文件夹。'
  } catch (e: any) {
    err.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

function onDrop(e: any) {}

function fmt(ts: string) {
  return ts ? ts.slice(0, 16) : '—'
}
</script>

<template>
  <div class="home">
    <header class="head">
      <div class="row brand">
        <!-- 印章式的产品标记：用 CSS 画的，不引外部图片（离线应用不该有外链资源） -->
        <i class="mark" aria-hidden="true">写</i>
        <div class="col titles">
          <h1>离线写作工作台</h1>
          <p class="muted small">文件目录就是你的书。不联网也能写完一整本。</p>
        </div>
      </div>
      <div class="row">
        <button
          class="tag ai-entry"
          :class="{ ok: aiEnabled() }"
          :title="aiEnabled() ? 'AI 已配置，点这里查看或修改' : '还没配 AI。点这里填 API（不配也能正常写作）'"
          @click="openSettings('ai')"
        >
          {{ aiEnabled() ? 'AI 已就绪' : 'AI 未配置 · 点击配置' }}
        </button>
        <button class="text small" @click="openSettings('general')">设置</button>
        <button class="text small" title="清理本地索引缓存（不影响任何 Markdown 文件）" @click="clearCache()">清理缓存</button>
      </div>
    </header>

    <!-- 降级模式：不再一句「请用 Chrome」把人赶走，而是给一条能走通的路 -->
    <section v-if="degraded" class="degrade-box panel">
      <div class="spread">
        <h3>{{ DEGRADE_NOTICE.title }}</h3>
        <span class="tag warn small">沙盒模式</span>
      </div>
      <p class="small dim">{{ DEGRADE_NOTICE.why }}</p>
      <ol class="small steps">
        <li v-for="(s, i) in DEGRADE_NOTICE.steps" :key="i">{{ s }}</li>
      </ol>
      <div class="row">
        <button class="primary" :disabled="busy" @click="pickFolder">导入作品文件夹</button>
        <button :disabled="busy" @click="createBox = !createBox">新建作品（沙盒）</button>
        <span class="grow"></span>
        <span class="small dim">Chrome / Edge 上不需要这一步，可以直接读写文件夹</span>
      </div>
      <!-- webkitdirectory 只认「选一个目录」，路径信息在 webkitRelativePath 里 -->
      <input
        ref="folderInput"
        class="folder-input"
        type="file"
        webkitdirectory
        directory
        multiple
        @change="onFolderPicked"
      />
      <details class="small">
        <summary>这样做的代价</summary>
        <ul class="dim">
          <li v-for="(l, i) in DEGRADE_NOTICE.limits" :key="i">{{ l }}</li>
        </ul>
      </details>

      <div v-if="createBox" class="create-sbx">
        <label>作品名<input v-model="sbxName" placeholder="例如：我的第一本小说" /></label>
        <button class="primary" :disabled="busy || !sbxName.trim()" @click="doCreateSandbox">创建并开始写</button>
        <span class="small dim">会建出 大纲 / 设定 / 正文 / 记忆 / 技能 五个标准目录</span>
      </div>
    </section>

    <div v-if="degraded && hint" class="panel resume-box">
      <div class="spread">
        <b>浏览器里还存着上次的沙盒作品：{{ hint.name }}</b>
        <span class="tag small" :class="hint.dirty ? 'warn' : 'info'">{{ hint.dirty ? `未导出 ${hint.dirty} 个` : '已同步' }}</span>
      </div>
      <div class="row small muted">
        <span>{{ hint.files }} 个文件</span>
        <span>·</span>
        <span>存于 {{ fmt(hint.savedAt.replace('T', ' ')) }}</span>
        <span class="grow"></span>
        <button class="small" :disabled="busy" @click="resume">继续写</button>
        <button class="btn-icon small" title="丢弃浏览器里的这份" @click="dropHint">×</button>
      </div>
    </div>

    <!-- 移动端：作品库（没有目录选择器，改成直接列出应用文档目录里的作品） -->
    <section v-if="!degraded && mobile" class="library">
      <div class="spread">
        <h3 class="sec-title">作品库</h3>
        <button class="text small" :disabled="busy" @click="libCreating = !libCreating">
          {{ libCreating ? '收起' : '新建作品' }}
        </button>
      </div>
      <p class="small dim lib-tip">
        手机上的作品存在应用自己的文档目录里（<code>{{ host?.worksRoot }}</code>）。
        卸载前记得先做一次备份。
      </p>

      <div v-if="libCreating" class="panel new-box">
        <div class="grid">
          <label>书名<input v-model="libName" placeholder="例如：我的第一本小说" /></label>
          <label>作者（可留空）<input v-model="libAuthor" /></label>
        </div>
        <p class="small dim">会建出 大纲 / 设定 / 正文 / 记忆 / 技能 五个标准目录。</p>
        <div class="row">
          <button class="primary" @click="createLibWork" :disabled="busy || !libName.trim()">创建并打开</button>
        </div>
      </div>

      <div class="recent">
        <div
          v-for="w in libWorks"
          :key="w.name"
          class="recent-item card card-hover"
          role="button"
          tabindex="0"
          :aria-label="`打开作品 ${w.title}`"
          @click="openLibWork(w)"
          @keydown.enter.prevent="openLibWork(w)"
        >
          <i class="cover" aria-hidden="true">{{ (w.title || '书').trim().charAt(0) }}</i>
          <div class="meta">
            <b class="nm">{{ w.title }}</b>
            <span class="tag dim small path">{{ w.name }}</span>
          </div>
          <button class="btn-icon rm" title="删除这部作品" @click.stop="removeLibWork(w)">×</button>
        </div>
      </div>
      <p v-if="!libWorks.length && !libBusy" class="empty-state">作品库还是空的 —— 点右上角「新建作品」开始第一部。</p>
    </section>

    <div v-if="!degraded && !mobile" class="actions">
      <!-- primary 这个类不能丢：端到端验收就是点 .actions button.primary 进新建流程的 -->
      <button class="act lead primary" data-ic="✎" @click="pickNewWorkFolder" :disabled="!supported">
        <b>新建作品</b>
        <span class="small dim">选一个空文件夹，在里面建出五个标准目录</span>
      </button>
      <button class="act" data-ic="⧉" @click="openExisting" :disabled="!supported">
        <b>打开已有作品</b>
        <span class="small dim">指向作品的根目录（含 大纲 / 设定 / 正文）</span>
      </button>
      <span class="muted small aside">作品 = 一个普通文件夹，软件只是它的界面</span>
    </div>

    <div v-if="creating" class="panel new-box">
      <h3>新建作品</h3>
      <div class="grid">
        <label>作品所在文件夹<em>{{ (pendingParent && pendingParent.name) || '' }}</em></label>
        <label>书名<input v-model="newName" placeholder="例如：我的第一本小说" /></label>
        <label>作者（可留空）<input v-model="newAuthor" /></label>
        <label>目标字数（可留空）<input type="number" v-model="newTarget" /></label>
      </div>
      <p class="small dim">将创建：大纲 / 设定 / 正文 / 记忆 / 技能 五个标准目录。</p>
      <div class="row">
        <button class="primary" @click="doCreate" :disabled="busy || !newName.trim()">创建并打开</button>
        <button @click="((creating = false), (pendingParent = null))">取消</button>
      </div>
    </div>

    <section v-if="recentList.length">
      <h3 class="sec-title">{{ degraded ? '沙盒作品' : '最近的作品' }}</h3>
      <div class="recent">
        <div
          v-for="r in recentList"
          :key="r.refId"
          class="recent-item card card-hover"
          tabindex="0"
          role="button"
          :aria-label="`打开作品 ${r.name}`"
          @click="openRecent(r)"
          @keydown.enter.prevent="openRecent(r)"
        >
          <i class="cover" aria-hidden="true">{{ (r.name || '书').trim().charAt(0) }}</i>
          <div class="meta">
            <b class="nm" :title="r.name">{{ r.name }}</b>
            <span class="tag dim small path">{{ r.pathLabel }}</span>
            <div class="row small muted stats">
              <span>{{ r.lastWordCount.toLocaleString() }} 字</span>
              <span>·</span>
              <span>最后打开 {{ fmt(r.lastOpened) }}</span>
            </div>
          </div>
          <button class="btn-icon rm" title="从最近列表移除" @click.stop="removeRecent(r.refId)">×</button>
        </div>
      </div>
    </section>

    <p v-if="degraded && lockedRecents.length" class="small dim locked">
      {{ fsaRequiredHint() }}（{{ lockedRecents.length }} 部：{{ lockedRecents.map((r) => r.name).join('、') }}）在 Chrome / Edge 里打开即可，文件一直都在。
    </p>

    <section class="tips">
      <h3 class="sec-title">这套东西怎么用</h3>
      <ol class="small muted">
        <li>正文存在 <code>正文/</code> 下的 Markdown 文件里，一个文件就是一章，记事本也能改。</li>
        <li>一卷 = 一个文件夹，卷内的 <code>卷纲.md</code> 记录本卷目标与钩子。</li>
        <li>大纲与设定放在 <code>大纲/</code> <code>设定/</code>，AI 续写时会读它们。</li>
        <li>不填 API Key 时，AI 面板完全不会出现；点右上角「AI 未配置 · 点击配置」填好服务商与 Key 即解锁。</li>
        <li>AI 写的东西一律先落在「候选区」，你点采纳才进正文。</li>
      </ol>
    </section>

    <p v-if="err" class="err-box">{{ err }}</p>
    <p v-if="notice" class="muted small">{{ notice }}</p>

    <SettingsDialog v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.home {
  max-width: 880px;
  margin: 0 auto;
  padding: 52px 26px 84px;
  /* 首页掀开时有一层很淡的光落在标题区 —— 纯 CSS 渐变，不引任何外部图片 */
  background-image: radial-gradient(120% 420px at 18% -8%, var(--accent-soft), transparent 70%);
  background-repeat: no-repeat;
  min-height: 100%;
}
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 30px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line-soft);
}
.brand {
  gap: 12px;
  align-items: center;
  min-width: 0;
}
/* 产品标记：一枚手写感的方印，替代「换个 logo 图片」这件事 */
.mark {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-style: normal;
  font-size: 19px;
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  box-shadow: var(--shadow-2);
  letter-spacing: 0;
  user-select: none;
}
.titles {
  gap: 2px;
  min-width: 0;
}
h1 {
  font-size: 23px;
  margin: 0;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1.3;
}
.brand p {
  margin: 0;
}

/* ---- 主操作：做成卡片，说明文字跟着按钮一起被点到 ---- */
.actions {
  display: flex;
  align-items: stretch;
  gap: 12px;
  margin-bottom: 26px;
  flex-wrap: wrap;
}
.act {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 13px 15px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  box-shadow: var(--shadow-1);
  text-align: left;
}
.act b {
  font-size: 14px;
  font-weight: 600;
}
.act:hover:not(:disabled) {
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}
.act:active:not(:disabled) {
  transform: translateY(0);
}
.act::before {
  content: attr(data-ic);
  font-size: 15px;
  line-height: 1;
  opacity: 0.55;
  margin-bottom: 2px;
}
/* 主推的那个：仍然保持卡片的样子（把 primary 的实心填充压回去），只多一道强调色描边。
   写成 button.act.lead 是为了稳稳压过全局 button.primary 的背景色。 */
button.act.lead {
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-elev));
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  color: var(--text);
  box-shadow: var(--shadow-1);
  filter: none;
}
button.act.lead b {
  color: var(--accent);
}
button.act.lead:hover:not(:disabled) {
  background: var(--accent-soft);
  filter: none;
}
.aside {
  flex: 0 0 auto;
  align-self: center;
  max-width: 180px;
  line-height: 1.6;
}

.new-box {
  padding: 16px 18px;
  margin-bottom: 26px;
  border-radius: 9px;
  box-shadow: var(--shadow-1);
}
.new-box h3 {
  margin: 0;
  font-size: 14px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 18px;
  margin: 12px 0;
}
.grid label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-soft);
}
.grid em {
  font-style: normal;
  color: var(--text);
  font-size: 13px;
}
.sec-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin: 28px 0 12px;
}

/* ---- 最近作品：一行一部变成两列卡片，压上去才有反馈 ---- */
.recent {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: 12px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 13px;
  cursor: pointer;
  border-radius: 9px;
}
.recent-item:focus-visible {
  box-shadow: 0 0 0 3px var(--ring);
}
.cover {
  flex: 0 0 auto;
  width: 38px;
  height: 50px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-style: normal;
  font-size: 17px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--line);
  /* 书脊：左边一道竖线，让它像立在架上的一本书而不是一个方块 */
  border-left: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
  user-select: none;
}
.meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
}
.nm {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats {
  gap: 5px;
  font-size: 11px;
}
/* 移除按钮平时藏起来，鼠标压到卡片上才出现 —— 它的危害太大，不能和「打开」一样显眼 */
.rm {
  color: var(--text-dim);
  opacity: 0;
  transition: opacity 0.16s ease, color 0.16s ease, background-color 0.16s ease;
}
.recent-item:hover .rm,
.recent-item:focus-within .rm {
  opacity: 1;
}
.rm:hover {
  color: var(--danger);
  background: var(--danger-bg);
}
.grow {
  flex: 1;
}

/* ---- 首页的 AI 入口：长得像标签，但得让人知道它能点 ---- */
.ai-entry {
  cursor: pointer;
  background: transparent;
  color: var(--text-soft);
  border: 1px solid var(--line);
  transition: border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}
.ai-entry:hover {
  border-color: var(--accent);
  color: var(--text);
  box-shadow: 0 0 0 3px var(--ring);
}
.ai-entry.ok {
  color: var(--ok);
  border-color: var(--tag-ok-line);
  background: var(--tag-ok-bg);
}

/* ---- 下方说明 ---- */
.tips {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-panel);
  padding: 14px 18px 16px;
  margin-top: 26px;
}
.tips .sec-title {
  margin: 0 0 8px;
}
.tips ol {
  padding-left: 20px;
  line-height: 2;
  margin: 0;
}
.tips ol li::marker {
  color: var(--accent);
  font-weight: 600;
}
code {
  background: var(--bg-field);
  border: 1px solid var(--line);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}
.warn-box,
.err-box {
  border: 1px solid var(--note-line);
  background: var(--note-bg);
  color: var(--note-fg);
  padding: 10px 14px;
  border-radius: 7px;
  font-size: 13px;
}
.err-box {
  border-color: var(--danger-line);
  background: var(--danger-bg);
  color: var(--danger);
}

/* ---- 降级模式 ---- */
.degrade-box {
  padding: 16px 18px;
  margin-bottom: 20px;
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  box-shadow: var(--shadow-1);
}
.degrade-box h3 {
  margin: 0;
  font-size: 15px;
}
.steps {
  margin: 8px 0;
  padding-left: 20px;
  line-height: 1.9;
}
.degrade-box details summary {
  cursor: pointer;
  color: var(--text-soft);
}
.degrade-box details ul {
  margin: 6px 0 0;
  padding-left: 20px;
  line-height: 1.8;
}
.folder-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
}
.create-sbx {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.create-sbx label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-soft);
}
.resume-box {
  padding: 12px 14px;
  margin-bottom: 20px;
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  box-shadow: var(--shadow-1);
}
.locked {
  margin-top: 8px;
  line-height: 1.8;
}
</style>
