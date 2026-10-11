import { defineConfig } from 'tsdown'
import { standardDecorators } from '../../scripts/tsdown-decorators.mjs'

// Electron 主进程打包：electron 与 @ryagent/* 全部 external（运行时经
// node_modules 解析；@ryagent/* 是 workspace 链接，electron 可直接 require）。
export default defineConfig({
  entry: ['electron/main.ts', 'electron/preload.ts'],
  outDir: 'main',
  format: ['esm'],
  dts: false,
  sourcemap: false,
  minify: false,
  external: ['electron', /^@ryagent\//, 'ws', /^node:/],
  outExtensions: () => ({ js: '.mjs' }),
  plugins: [standardDecorators()],
})
