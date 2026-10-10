import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

/** 规模压测：把 scripts/scalecheck.ts 打成 node 可跑的包（内存宿主，不碰真实磁盘） */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    ssr: 'scripts/scalecheck.ts',
    outDir: 'test-scale',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { external: ['docx', 'fflate'] }
  }
})
