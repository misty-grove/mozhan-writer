/**
 * 一条命令跑完真实浏览器验收：build → 起 vite preview → 跑 browser.mjs → 关服务器。
 *
 * 之所以自己起服务：让 e2e 变成可重复、无人工前置的一步，
 * 否则「你得先手动开着 dev server」这种事迟早会让人跑出假失败。
 *
 * 用法：
 *   npm run e2e
 *   E2E_PORT=9450 npm run e2e          # 换端口
 *   E2E_SKIP_BUILD=1 npm run e2e       # 复用上次产物，快速回归
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const port = Number(process.env.E2E_PORT || 5199)
const url = `http://127.0.0.1:${port}/`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(viteBin)) {
  console.error(`找不到 vite：${viteBin}\n先在工程根目录执行 npm install`)
  process.exit(1)
}

function run(label, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', ...opts })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 退出码 ${code}`))))
  })
}

async function waitServer(timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`预览服务器 ${url} 在 ${timeoutMs}ms 内没起来`)
}

let server = null
let code = 1
try {
  if (!process.env.E2E_SKIP_BUILD) {
    console.log('▶ 构建产物…')
    await run('vite build', [viteBin, 'build'])
  }
  console.log(`▶ 启动预览服务器 ${url}`)
  server = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', () => void 0)
  server.stderr.on('data', (d) => process.stderr.write(d))
  await waitServer()

  console.log('▶ 真实浏览器验收\n')
  await new Promise((resolve) => {
    const t = spawn(process.execPath, [join(here, 'browser.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, E2E_URL: url }
    })
    t.on('exit', (c) => {
      code = c ?? 1
      resolve()
    })
  })
} catch (e) {
  console.error('\n' + (e?.message || e))
  code = 1
} finally {
  if (server) {
    server.kill()
    await sleep(400)
  }
}
process.exit(code)
