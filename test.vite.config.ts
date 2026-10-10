import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

/** 核心层离线自检：把 scripts/selfcheck.ts 打成 node 可跑的包，用内存文件系统验证全链路 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    ssr: 'scripts/selfcheck.ts',
    outDir: 'test-dist',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { external: ['docx', 'fflate'] }
  }
})
