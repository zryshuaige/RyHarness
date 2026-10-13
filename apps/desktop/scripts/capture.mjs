/**
 * 截图模式一键运行：构建主进程 + 渲染层产物后，以 RYAGENT_CAPTURE=1
 * 启动 Electron（capture.ts 会造演示数据并截屏到 apps/desktop/capture.png）。
 * 数据目录指向临时文件夹，绝不污染真实用户数据。
 * 用法：pnpm --filter @ryagent/desktop capture
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-capture-'))

const build = spawn('pnpm', ['run', 'build'], { cwd: here, stdio: 'inherit', shell: true })
await new Promise((resolve, reject) => {
  build.on('exit', (code) => {
    return code === 0 ? resolve() : reject(new Error(`build exit ${code}`))
  })
})

const electron = spawn('pnpm', ['run', 'start'], {
  cwd: here,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, RYAGENT_CAPTURE: '1', RYAGENT_DATA_DIR: dataDir },
})
electron.on('exit', (code) => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  process.exit(code ?? 0)
})
