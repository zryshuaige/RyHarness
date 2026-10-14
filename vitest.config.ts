import ts from 'typescript'
import { defineConfig, type Plugin } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Vite's default TS transform leaves standard (TC39) decorators unhandled,
 * which produces invalid JS for `@Remote`-annotated services. Transpile files
 * that use decorator syntax with the TypeScript compiler before Vite sees
 * them. Ported from deepseek-harness' vitest.shared.ts, trimmed to our needs.
 */
function standardDecoratorPlugin(): Plugin {
  return {
    name: 'ryagent-standard-decorators',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?', 1)[0] as string
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  esbuild: {
    // 渲染层 .tsx（React JSX automatic runtime）；对纯 .ts 文件无影响。
    jsx: 'automatic',
  },
  plugins: [standardDecoratorPlugin()],
  resolve: {
    // Resolve @ryagent/* through tsconfig.json paths (source-level), so tests
    // exercise the TypeScript sources without a prior build.
    tsconfigPaths: true,
  },
  test: {
    include: ['apps/*/tests/**/*.test.{ts,tsx}', 'packages/*/tests/**/*.test.ts', 'packages/*/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // v8 提供器按「实际执行的语句」统计；显式列出源码目录，报告里出现的
      // 就只有业务代码，不会混入构建产物与测试自身。
      include: [
        'apps/server/src/**/*.ts',
        'apps/desktop/electron/**/*.ts',
        'apps/desktop/renderer/src/**/*.{ts,tsx}',
        'packages/*/src/**/*.ts',
        'packages/*/*/src/**/*.ts',
      ],
      exclude: ['**/tests/**', '**/*.d.ts', '**/main/**', '**/dist/**', '**/lib/**', '**/vendor/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      // 刻意不设 thresholds：覆盖率先只报告、不拦截，避免「补测试」变成合并的
      // 行政成本；基线稳定后再按实测值收紧。
    },
  },
})
