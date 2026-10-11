/**
 * 一次性诊断探针 v2：不强求 evaluate，先看窗口长什么样、资源加载到哪一步。
 */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { attachBrowser, sleep } from './cdp.mjs'

const PROJECT = resolve(import.meta.dirname, '../..')
const TMP_BASE = process.env.TMP || process.env.TEMP || PROJECT
const EXE = process.argv[2] || join(process.env.CARGO_TARGET_DIR || join(PROJECT, 'src-tauri/target'), 'release/mozhan.exe')
const PORT = Number(process.env.DESKTOP_PORT || 9447)
const SHOT = join(PROJECT, '.e2e-shots', '_probe.png')

console.log('启动:', EXE, ' 端口:', PORT)
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    // --no-sandbox 必需：少了它 WebView2 的浏览器进程几秒后自杀（详见 desktop.mjs）
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --no-sandbox`,
    WEBVIEW2_USER_DATA_FOLDER: join(TMP_BASE, 'writer-desktop-e2e', 'webview2-profile-probe'),
  },
  stdio: 'ignore',
})
child.on('exit', c => { console.log('!! 应用退出，码 =', c); process.exit(1) })

const { page, target } = await attachBrowser({ port: PORT, match: /tauri\.localhost/, timeoutMs: 45000 })
console.log('附着到:', target.url)

const race = (p, ms, tag) =>
  Promise.race([
    p.then(v => `${tag}: OK`),
    sleep(ms).then(() => `${tag}: TIMEOUT(${ms}ms)`),
  ])

// 截图不需要渲染主线程空闲
const shot = await race(
  page.send('Page.captureScreenshot', { format: 'png' }).then(r => { writeFileSync(SHOT, Buffer.from(r.data, 'base64')); return r.data.length }),
  15000, 'screenshot')
console.log(shot, '->', SHOT)

// 资源树（部分实现也需要渲染线程，试试看）
console.log(await race(page.send('Page.getResourceTree').then(r => JSON.stringify(r).slice(0, 600)), 6000, 'resourceTree'))
console.log(await race(page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }), 5000, 'evaluate'))

child.kill()
process.exit(0)
