/**
 * 打成果物：安装包 + 免安装版 zip，一次到位。
 *
 * 用法：
 *   pnpm --filter @ryharness/desktop package:release
 *
 * 为什么不在 apps/desktop 直接 electron-builder --win：
 * 正式目录（ryharness-release）里可能残留着上一轮的 win-unpacked/resources/app.asar，
 * 而那个文件常被宿主进程（MiniMax Code 的索引器）攥着句柄——electron-builder 要先
 * unlink 它，于是整轮打包挂在 EBUSY 上。绕法是先打到**工作区之外**的临时目录
 * （宿主只索引工作区里的文件），再把两个成果物拷回正式目录。
 *
 * 拷回来的名字是固定的两个（RyHarness Setup <版本>.exe 与 RyHarness-win-x64.zip），
 * README 与官网都指着这两个名字，electron-builder 默认给的 zip 名（<名>-<版本>-win.zip）
 * 与之不同。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(here, 'ryharness-release')
const staging = mkdtempSync(join(tmpdir(), 'ryharness-pkg-'))
const require = createRequire(import.meta.url)

/**
 * 本机已装好的 Electron 发行目录（dist/）。
 *
 * electron-builder 默认会**自己下载**一份 Electron 发行版再解压——而 GitHub 的
 * release 下载在不少网络环境里是不通的，那一步会一直挂着，既不报错也不动。
 * 既然依赖里已经有同一个版本的 Electron（本仓库的 devDependency），直接把它指
 * 过去（electronDist）就绕开了下载：打包用的还是那个版本，只是不用再下一遍。
 * @returns dist 目录；找不到就返回 undefined（走 electron-builder 自己的下载）。
 */
function localElectronDist() {
  try {
    // electron 的 package.json 旁就是 dist/（dist 内是 electron.exe 与 resources/）。
    const manifest = require.resolve('electron/package.json')
    const dist = join(dirname(manifest), 'dist')
    return existsSync(join(dist, 'electron.exe')) ? dist : undefined
  } catch {
    return undefined
  }
}

/**
 * 打包工具链的下载镜像。
 *
 * electron-builder 还要拉 winCodeSign / NSIS 这些二进制，它们同样来自 GitHub
 * release。默认走国内镜像（淘宝的 electron-builder-binaries 镜像），已经设过
 * 变量的用户环境不受影响。
 */
function mirrorEnv() {
  const env = { ...process.env }
  if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
    env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
  }
  return env
}

/** 跑一条命令，失败即抛（不吞错误：打包失败必须看得见）。 */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: true, env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
  }
}

try {
  /**
   * 先做**全量**构建（整个工作区），再打包。
   *
   * 只重建桌面端是不够的：服务端在 packages/ 里，构建产物（lib/）会被打进包里。
   * 只重建桌面端的话，包里装的是**上一轮的 server**——界面是新的、接口是旧的，
   * 这种包发出去比不发还糟（RyVibe 那一版就踩过：新页面配旧接口，问答记录不显示）。
   */
  const repoRoot = join(here, '..', '..')
  console.log('[package:release] 全量构建整个工作区…')
  const build = spawnSync('pnpm', ['-r', 'run', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: true })
  if (build.status !== 0) {
    throw new Error(`全量构建失败，退出码 ${build.status}`)
  }

  const env = mirrorEnv()
  const electronDist = localElectronDist()
  console.log(`[package:release] 打到工作区之外的暂存目录：${staging}`)
  if (electronDist === undefined) {
    console.log('[package:release] 本机没找到已装的 Electron 发行目录，改由 electron-builder 自己下载')
  } else {
    console.log(`[package:release] 用本机已装的 Electron 发行目录：${electronDist}`)
  }
  run(
    // 绝对路径：cmd 不会去 PATH 里找「当前目录下的相对路径」，必须写全。
    join(here, 'node_modules', '.bin', 'electron-builder.CMD'),
    [
      '--projectDir',
      here,
      '--win',
      'nsis',
      'portable',
      'zip',
      `--config.directories.output=${staging}`,
      ...(electronDist === undefined ? [] : [`--config.electronDist=${electronDist}`]),
    ],
    here,
    env,
  )

  // 版本号直接读文件：起子进程去 require package.json，在 Windows 上会被 shell 的
  // 引号规则吃掉，输出空串，JSON.parse 当场炸。
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  mkdirSync(outDir, { recursive: true })

  const artifacts = [
    {
      from: join(staging, `RyHarness Setup ${pkg.version}.exe`),
      to: join(outDir, `RyHarness Setup ${pkg.version}.exe`),
    },
    { from: join(staging, `RyHarness-${pkg.version}-win.zip`), to: join(outDir, 'RyHarness-win-x64.zip') },
    {
      from: join(staging, 'RyHarness-portable.exe'),
      to: join(outDir, 'RyHarness-portable.exe'),
    },
    {
      from: join(staging, `RyHarness Setup ${pkg.version}.exe.blockmap`),
      to: join(outDir, `RyHarness Setup ${pkg.version}.exe.blockmap`),
    },
  ]

  for (const artifact of artifacts) {
    if (!existsSync(artifact.from)) {
      console.warn(`[package:release] 跳过（没产出）：${basename(artifact.from)}`)
      continue
    }
    copyFileSync(artifact.from, artifact.to)
    const mb = (statSync(artifact.to).size / 1024 / 1024).toFixed(1)
    console.log(`[package:release] ${basename(artifact.to)} = ${mb} MB`)
  }
  console.log(`[package:release] 成果物在 ${outDir}`)
  console.log('[package:release] 接下来跑冒烟：pwsh -File scripts/smoke-packaged.ps1')
} finally {
  rmSync(staging, { recursive: true, force: true, maxRetries: 5 })
}
