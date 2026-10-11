import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: false,
  minify: false,
  external: [/^@ryagent\//],
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
