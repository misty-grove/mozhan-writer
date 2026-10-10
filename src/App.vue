<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import WriteView from './views/WriteView.vue'
import HomeView from './views/HomeView.vue'
import AppDialog from '@/components/AppDialog.vue'
import { restoreLastWork, state } from '@/stores/workspace'
import { resumePersisted } from '@/stores/sandbox'
import { degradedMode, detectMobile, syncSystemBar } from '@/platform'
import { isSandboxRefId } from '@/core/degrade'
import { applyAppearance, settings } from '@/core/settings'
import { setSnapshotPolicy } from '@/core/snapshots'

const inWork = computed(() => !!state.ref)

// 快照策略住在设置里，core/ 不直接读 settings（核心层要能在没有 localStorage 的 Node 里跑），
// 由这里把设置灌进去。
function syncSnapshotPolicy() {
  setSnapshotPolicy({
    maxAuto: settings.general.recentSnapshots,
    intervalMs: Math.max(0, settings.general.autoSnapshotIntervalMin) * 60 * 1000
  })
}

onMounted(async () => {
  syncSnapshotPolicy()
  // 移动端：挂上 ua-mobile 让全局样式切到手机版（见 global.css 末尾那段），
  // 并默认把资料面板收起来 —— 手机屏幕就那么宽，一进来就被盖住稿纸没法写。
  const isMobile = await detectMobile()
  applyAll()
  if (isMobile) {
    document.documentElement.classList.add('ua-mobile')
    // 两个侧栏在手机上是**盖在稿纸上**的抽屉（见 global.css 的 .ua-mobile 段），
    // 一进来就摊开等于没法写字 —— 每次启动都从稿纸开始，要目录/资料就点底部条。
    settings.ui.dockOpen = false
    settings.ui.sidebarOpen = false
  }
  // 刷新/重开后直接回到上次的作品，而不是每次都停在首页再点一次
  // 降级模式下先看浏览器里存着的沙盒（它不需要任何授权，也最可能是作者刚才在写的那部）
  if (degradedMode() && isSandboxRefId(settings.recent[0]?.refId || '')) {
    if (await resumePersisted()) return
  }
  await restoreLastWork()
})
// 缩放 / 高对比 / 主题都挂在 <html> 上，改一处就全站生效（含 body 背景与滚动条）
function applyAll() {
  applyAppearance()
  // 安卓开了 edge-to-edge，状态栏是透明的、图标画在我们的顶栏上；
  // 应用主题跟系统深浅色各走各的，所以每次换主题都要跟系统栏说一声。
  syncSystemBar(settings.editor.theme === 'dark')
}
watch([() => settings.ui.scale, () => settings.ui.highContrast, () => settings.editor.theme], applyAll)
watch([() => settings.general.recentSnapshots, () => settings.general.autoSnapshotIntervalMin], syncSnapshotPolicy)
</script>

<template>
  <div class="app-root">
    <WriteView v-if="inWork" />
    <HomeView v-else />
    <!-- 全局只挂一个：所有应用的弹窗都走它，不再是原生 prompt/confirm -->
    <AppDialog />
  </div>
</template>

<style>
.app-root {
  height: 100%;
  background: var(--bg);
  color: var(--text);
}
</style>
