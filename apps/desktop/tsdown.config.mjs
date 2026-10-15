import { defineConfig } from 'tsdown'
import { standardDecorators } from '../../scripts/tsdown-decorators.mjs'

// electron 与 @ryagent/* 全部 external（运行时经 node_modules 解析；
// @ryagent/* 是 workspace 链接，electron 可直接 require）。
const common = () => ({
  dts: false,
  sourcemap: false,
  minify: false,
  external: ['electron', /^@ryagent\//, 'ws', /^node:/],
  plugins: [standardDecorators()],
})

// 主进程与 preload 分两次构建，因为它们的模块格式要求相反：
// 主进程是 ESM（应用 package.json 是 type: module，electron 直接加载 .mjs），
// 而 preload 必须落到 CommonJS——Electron 20 起渲染进程默认 sandbox: true，
// sandbox 下的 preload 只按 CJS 装载，喂 .mjs 会报
// "Cannot use import statement outside a module"，桥（window.ryagentDesktop）
// 整个静默消失，且不报任何渲染层错误。
export default defineConfig([
  {
    ...common(),
    entry: ['electron/main.ts'],
    outDir: 'main',
    format: ['esm'],
    outExtensions: () => ({ js: '.mjs' }),
  },
  {
    ...common(),
    entry: ['electron/preload.ts'],
    outDir: 'main',
    format: ['cjs'],
    outExtensions: () => ({ js: '.cjs' }),
  },
])
