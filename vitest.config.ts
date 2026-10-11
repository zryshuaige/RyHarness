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
  plugins: [standardDecoratorPlugin()],
  resolve: {
    // Resolve @ryagent/* through tsconfig.json paths (source-level), so tests
    // exercise the TypeScript sources without a prior build.
    tsconfigPaths: true,
  },
  test: {
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts', 'packages/*/*/tests/**/*.test.ts'],
  },
})
