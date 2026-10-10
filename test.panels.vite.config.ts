import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/** 把 scripts/panelsmoke.ts 打包成 node 可 import 的 ESM，供 jsdom 冒烟使用 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
  },
  build: {
    lib: { entry: 'scripts/panelsmoke.ts', formats: ['es'], fileName: 'panelsmoke' },
    outDir: 'test-panels',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: { external: ['docx', 'fflate'] }
  }
})
