import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * 渲染层构建：产物到 renderer/dist，由 Electron 主进程内嵌的本地 HTTP server
 * 以同源 URL（/app）伺服——不再内联进单文件 HTML（内联会丢掉并行加载、
 * HTTP 缓存与 code splitting，产物也从 ~250KB 涨到 1.3MB）。
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // 按依赖域拆包：entry 会为它们注入 <link rel="modulepreload">，
        // 浏览器并行下载（而不是 1.3MB 单 chunk 串行解析执行）。
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('marked')) return 'vendor-marked'
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('@dicebear')) return 'vendor-avatar'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})