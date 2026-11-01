/**
 * 降级实现：没装浏览器驱动时的如实报错。
 *
 * **不假装成功**是这个模块存在的全部理由。上游 dsh 的 browser-use 是「选一个
 * provider 装上」的注册表，本轮我们不引浏览器驱动（Playwright 要拖几百 MB 的
 * 浏览器二进制，桌面自动化要原生代码），那么「宿主还没接驱动」就是**常态**，
 * 不是异常。
 *
 * 常态就该有一条明确的路径：调用它，得到一句「没装浏览器驱动」的结构化错误，
 * 而不是空截图、空白正文、或者一个看起来成功的空结果。后者更糟——模型会
 * 拿着空白页继续推理，把「没驱动」误当成「页面是空的」。
 * @module @ryharness/browser-use/fallback
 */

import { BrowserUseError } from './errors.ts'
import type { BrowserDriver, BrowserScreenshot } from './types.ts'

/** 没装驱动时统一用的错误码。 */
const NO_DRIVER_CODE = 'NO_DRIVER'

/** 没装驱动时统一用的说明。 */
const NO_DRIVER_MESSAGE = 'browser-use: 没装浏览器驱动，这个包不自带浏览器'

/**
 * 造一个「什么都没做」的驱动。
 *
 * 每个方法都返回结构化错误 `NO_DRIVER`，**没有一个方法假装成功**。
 * @param name - 驱动名（默认 `unavailable`）。
 * @returns 驱动。
 */
export function createUnavailableBrowserDriver(name = 'unavailable'): BrowserDriver {
  const fail = async (): Promise<never> => {
    throw new BrowserUseError(NO_DRIVER_CODE, NO_DRIVER_MESSAGE)
  }
  return {
    name,
    open: fail,
    click: fail,
    type: fail,
    screenshot: fail,
    readText: fail,
    close: fail,
  }
}

/**
 * 造一个总是失败的截图结果。
 *
 * 给「宿主想自己拼一个降级驱动、但截图得有个固定形状」的场景用：拿到的是
 * **空字节 + 明确的 mime**，配合服务层把它变成错误。
 * @returns 空截图。
 */
export function emptyBrowserScreenshot(): BrowserScreenshot {
  return { bytes: new Uint8Array(0), mimeType: 'application/octet-stream' }
}
