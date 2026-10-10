/**
 * 在 jsdom 里跑面板冒烟：没有浏览器可用时的替代验证。
 * 用法：先 build:\\panel-views，再 node scripts/smoke-panels.mjs
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
const { window } = dom

globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true })

for (const k of [
  'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'Document', 'DocumentFragment',
  'HTMLDocument', 'SVGElement', 'NodeList', 'NodeFilter', 'DOMRect', 'XMLHttpRequest', 'AbortController',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Blob', 'File', 'FileList', 'DOMParser', 'XMLSerializer',
  'CSSStyleSheet', 'ShadowRoot', 'Range', 'Selection', 'FormData'
]) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
globalThis.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
globalThis.performance = globalThis.performance || window.performance
globalThis.TextDecoder = globalThis.TextDecoder || (await import('node:util')).TextDecoder
globalThis.TextEncoder = globalThis.TextEncoder || (await import('node:util')).TextEncoder

const errors = []
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + e))
window.addEventListener('error', (e) => errors.push('window error: ' + e.message))

await import('../test-panels/panelsmoke.js')

if (errors.length) {
  console.log('\n运行期错误：', errors)
}
