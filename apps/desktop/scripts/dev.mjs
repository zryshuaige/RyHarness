/**
 * 开发模式一键启动：Vite 渲染层 dev server + tsdown 打包主进程 + electron。
 * 零额外依赖，直接 spawn 三个子进程。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const here = fileURLToPath(new URL('..', import.meta.url))

const vite = await createServer({
  root: `${here}/renderer`,
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
await vite.listen()
console.log('[dev] vite renderer at http://localhost:5173')

const buildMain = spawn('pnpm', ['run', 'build:main'], { cwd: here, stdio: 'inherit', shell: true })
await new Promise((resolve, reject) => {
  buildMain.on('exit', (code) => {
    return code === 0 ? resolve() : reject(new Error(`build:main exit ${code}`))
  })
})
console.log('[dev] main process bundled')

const electron = spawn('pnpm', ['run', 'start'], {
  cwd: here,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, RYHARNESS_DEV_SERVER_URL: 'http://localhost:5173' },
})
electron.on('exit', async () => {
  await vite.close()
  process.exit(0)
})
