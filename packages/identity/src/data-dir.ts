/**
 * 应用数据目录：按平台惯例找 RyHarness 的数据放哪儿。
 *
 * 找的是「用户自己的数据目录」，不是程序安装目录——安装版里程序目录是只读的，
 * 而 id 这种要写的东西得落在用户手里。
 *
 * 找法按平台惯例：
 * - Windows：`%APPDATA%\RyHarness`（漫游）。
 * - macOS：`~/Library/Application Support/Ryharness`。
 * - 其它（Linux 等）：`$XDG_DATA_HOME/RyHarness`，没设就用 `~/.local/share/RyHarness`。
 * @module @ryharness/identity/data-dir
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** 数据目录的应用名。 */
export const APP_DIR_NAME = 'RyHarness'

/**
 * 按平台惯例算出应用数据目录。
 *
 * 环境变量与主目录都做成参数：测试里传假的进去，就能把每个平台的形状都验一遍，
 * 不用真的换台机器。分隔符也跟着平台走——在 Windows 上问 Linux 的目录形状，
 * 拿到的就该是 `/` 分隔的那种。
 * @param env - 环境变量。默认 `process.env`。
 * @param home - 用户主目录。默认系统的。
 * @param platform - 平台。默认 `process.platform`。
 * @returns 数据目录的绝对路径。
 */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const appData = env['APPDATA']
    const base = appData !== undefined && appData.length > 0 ? appData : win32.join(home, 'AppData', 'Roaming')
    return win32.join(base, APP_DIR_NAME)
  }
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', APP_DIR_NAME)
  }
  const xdg = env['XDG_DATA_HOME']
  const base = xdg !== undefined && xdg.length > 0 ? xdg : posix.join(home, '.local', 'share')
  return posix.join(base, APP_DIR_NAME)
}
