import { defineConfig } from 'tsdown'
import { standardDecorators } from '../../scripts/tsdown-decorators.mjs'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: false,
  minify: false,
  external: [/^@ryagent\//],
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  plugins: [standardDecorators()],
})
