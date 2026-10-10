/**
 * 用户视角验证：新版首页的 AI 配置入口。
 * 起真窗口（隔离的用户数据目录，等于"第一次打开"）→ CDP 附着 →
 * 点「AI 未配置 · 点击配置」→ 确认设置弹窗弹出 → 选 DeepSeek 预设确认自动填充 → 截图。
 */
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { attachBrowser, sleep } from './cdp.mjs'

const EXE = process.argv[2] || 'F:\\AI\\Write\\离线写作工作台\\offline-novel-writer.exe'
const PORT = 9555
const TMP = 'E:\\Worksplace\\write_formation\\.tmp'
const PROFILE = join(TMP, 'ai-entry-profile')
const SHOT = join(TMP, 'ai-entry-dialog.png')
const SHOT_HOME = join(TMP, 'ai-entry-home.png')

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE
  },
  stdio: 'ignore',
  windowsHide: false
})
console.log('已启动', EXE, 'pid =', child.pid)

const { browser, page } = await attachBrowser({ port: PORT, timeoutMs: 45000 })
await sleep(1200)

// 1. 首页上 AI 入口存在且文案正确
const entryText = await page.evaluate(`return document.querySelector('.ai-entry')?.innerText.trim() || ''`)
console.log('首页 AI 入口文案:', JSON.stringify(entryText))
if (!entryText.includes('AI 未配置')) {
  console.error('★ 首页没看到「AI 未配置 · 点击配置」入口')
  process.exit(1)
}
await page.screenshot(SHOT_HOME)
console.log('首页截图:', SHOT_HOME)

// 2. 点它 → 设置弹窗（AI 页签）
await page.evaluate(`return document.querySelector('.ai-entry').click()`)
await sleep(600)
const dialogOpen = await page.evaluate(`return !!document.querySelector('.dialog')`)
const tabActive = await page.evaluate(`return document.querySelector('.dialog .head button.on')?.innerText.trim() || ''`)
const hasPreset = await page.evaluate(`return !!document.querySelector('.dialog select')`)
console.log('弹窗打开:', dialogOpen, '当前页签:', JSON.stringify(tabActive), '有服务商预设:', hasPreset)

// 3. 选 DeepSeek 预设 → Base URL / 模型名自动填充
await page.evaluate(`
  const sel = document.querySelector('.dialog select')
  sel.value = '0'
  sel.dispatchEvent(new Event('change'))
`)
await sleep(300)
const baseUrl = await page.evaluate(`return document.querySelectorAll('.dialog input')[0]?.value`)
const model = await page.evaluate(`return document.querySelectorAll('.dialog input')[2]?.value`)
console.log('选 DeepSeek 预设后 Base URL =', JSON.stringify(baseUrl), '模型名 =', JSON.stringify(model))

// 4. Key 显示切换
await page.evaluate(`
  Array.from(document.querySelectorAll('.dialog button')).find((b) => b.innerText.trim() === '显示')?.click()
`)
await sleep(200)
const keyType = await page.evaluate(`return document.querySelectorAll('.dialog input')[1]?.type`)
console.log('点「显示」后 Key 输入框类型:', keyType, keyType === 'text' ? '✓' : '★ 应为 text')

await page.screenshot(SHOT)
console.log('弹窗截图:', SHOT)

const ok = dialogOpen && tabActive === 'AI' && hasPreset && baseUrl.includes('deepseek') && model.includes('deepseek') && keyType === 'text'
console.log(ok ? '\nAI 配置入口验证：全部通过 ✅' : '\n★ 有检查未通过')

// 收尾：关掉窗口（先走正常关闭，兜底强杀）
await browser.send('Browser.close').catch(() => {})
await sleep(2000)
if (child.exitCode === null) {
  try { child.kill() } catch {}
}
process.exit(ok ? 0 : 1)
