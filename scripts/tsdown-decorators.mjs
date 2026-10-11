/**
 * tsdown pre-transform 插件：oxc 不编译标准（TC39）装饰器，会把 `@Remote`
 * 原样留在产物里产生非法 JS。对含装饰器语法的文件先用 TypeScript
 * transpileModule 降级（与 vitest 的 standardDecoratorPlugin 同思路），
 * 再交给 rolldown/oxc 打包。
 *
 * 用法（各包 tsdown.config.mjs）：
 *   import { standardDecorators } from '../../../scripts/tsdown-decorators.mjs'
 *   export default defineConfig({ ..., plugins: [standardDecorators()] })
 */
import ts from 'typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export function standardDecorators() {
  return {
    name: 'ryagent-standard-decorators',
    transform(code, id) {
      const file = String(id).split('?', 1)[0]
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return null
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
