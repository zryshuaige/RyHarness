/**
 * 截图模式一键运行：构建主进程 + 渲染层产物后，以 RYHARNESS_CAPTURE=1
 * 启动 Electron（capture.ts 会造演示数据并截屏到 apps/desktop/capture.png）。
 * 数据目录指向临时文件夹，绝不污染真实用户数据。
 *
 * 顺带一个**交互巡检**模式：RYHARNESS_REVIEW=1 时，capture 跑完还会把"指针移到
 * 头像不同位置""点了哪只动物""选了哪种毛色"这些中间状态实拍一遍（见
 * electron/capture.ts 的 runInteractionReview）。静态截图看不出换脸时主体跳不跳、
 * 缩略图的耳朵被不被裁——这些只能实拍。
 *
 * 用法：
 *   pnpm --filter @ryharness/desktop capture
 *   RYHARNESS_REVIEW=1 pnpm --filter @ryharness/desktop capture
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-capture-'))

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
  env: { ...process.env, RYHARNESS_CAPTURE: '1', RYHARNESS_DATA_DIR: dataDir },
})

/**
 * 收尾：把 electron 整棵树杀掉。
 *
 * 为什么非杀不可：`pnpm run start` → pnpm → electron → 渲染进程，退出时 electron
 * 的**子进程常常留着**（它们持有本地 API 的端口）。下一次跑截图就撞端口，于是
 * 切到暗色那一步卡住——拍出来的还是上一轮的旧图，而且没有任何报错。
 * 杀 pnpm 杀不到孙子进程，所以用 taskkill /T 按进程树杀。
 */
const killTree = () => {
  if (electron.pid === undefined) return
  try {
    spawnSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // taskkill 不可用（非常规 Windows）：退回到直接 kill，端口残留由下次重跑顶掉
    try {
      electron.kill()
    } catch {
      // 已经退出了
    }
  }
}

let cleaned = false
const cleanup = (code) => {
  if (cleaned) return
  cleaned = true
  killTree()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  process.exit(code ?? 0)
}

electron.on('exit', (code) => {
  cleanup(code)
})
// 兜底：electron 要是自己没退（渲染进程卡住之类），90 秒后按树杀掉
setTimeout(() => {
  cleanup(0)
}, 90_000)
