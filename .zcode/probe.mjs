import { createServer } from '../node_modules/.pnpm/vite@8.3.4_@types+node@22.20.5_esbuild@0.28.2_tsx@4.23.15/node_modules/vite/dist/node/index.js'
import { writeFileSync } from 'node:fs'
const server = await createServer({ root: 'F:/AgenticResearch/RyAgent', logLevel: 'silent', server: { middlewareMode: true } })
const result = await server.transformRequest('/apps/server/src/seed.ts')
writeFileSync('.zcode/seed.transformed.mjs', result.code)
console.log('written', result.code.length)
await server.close()
