// @vitest-environment node

/**
 * PDF 内嵌预览的两条腿：主进程的 plugins 开关 + 渲染层的 <object type>。
 *
 * 这一环坏掉时的症状非常具有欺骗性：页面不报错、不白屏，只是安安静静给出一块
 * 空白的框，用户以为文件坏了。所以它只能靠测试钉住——Chromium 把内置 PDF 阅读器
 * 挂在 NPAPI 插件开关后面，而 Electron 默认关掉它；少了 webPreferences.plugins，
 * 渲染层写得再对也只会得到空白。
 *
 * 这里做的是源码断言而不是真机断言：本进程跑不起 Electron。但少掉任何一条腿，
 * 用户面对的都是同一块空白框，所以静态检查足以守住这个决定。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = readFileSync(join(appRoot, 'electron', 'main.ts'), 'utf8')

/** BrowserWindow 的 webPreferences 那一段（含紧邻的注释）。 */
function webPreferencesSource(): string {
  const start = mainSource.indexOf('webPreferences: {')
  expect(start, 'main.ts 里找不到 webPreferences').toBeGreaterThan(-1)
  return mainSource.slice(start, mainSource.indexOf('},', start))
}

describe('PDF 内嵌预览', () => {
  it('主窗口开了 plugins —— Chromium 的 PDF 阅读器就挂在这个开关后面', () => {
    expect(webPreferencesSource()).toMatch(/plugins:\s*true/)
  })

  it('开关旁边写着为什么，否则下一个人会当它没用又删掉', () => {
    expect(webPreferencesSource()).toContain('PDF')
  })
})
