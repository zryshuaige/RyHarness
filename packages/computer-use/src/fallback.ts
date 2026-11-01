/**
 * 降级实现：没装桌面驱动时的如实报错。
 *
 * 与 browser-use 的同名模块是同一个道理：**不假装成功**。桌面自动化更不能
 * 假装——模型拿到一张「空截图」会以为屏幕是空的，然后开始编造界面上的东西；
 * 拿到一个「点击成功」会以为按钮按下去了。宁可让它明确知道「没有驱动」。
 * @module @ryharness/computer-use/fallback
 */

import { ComputerUseError } from './errors.ts'
import type { ComputerDriver, ComputerScreenshot } from './types.ts'

/** 没装驱动时统一用的错误码。 */
const NO_DRIVER_CODE = 'NO_DRIVER'

/** 没装驱动时统一用的说明。 */
const NO_DRIVER_MESSAGE = 'computer-use: 没装桌面驱动，这个包不自带桌面自动化'

/**
 * 造一个「什么都没做」的驱动。
 *
 * 每个方法都返回结构化错误 `NO_DRIVER`，**没有一个方法假装成功**。
 * @param name - 驱动名（默认 `unavailable`）。
 * @returns 驱动。
 */
export function createUnavailableComputerDriver(name = 'unavailable'): ComputerDriver {
  const fail = async (): Promise<never> => {
    throw new ComputerUseError(NO_DRIVER_CODE, NO_DRIVER_MESSAGE)
  }
  return {
    name,
    screenshot: fail,
    click: fail,
    type: fail,
    key: fail,
    move: fail,
    scroll: fail,
    close: fail,
  }
}

/**
 * 造一张空截图。
 *
 * 给「宿主想自己拼一个降级驱动、但截图得有个固定形状」的场景用：拿到的是
 * **空字节 + 明确的 mime**。注意它**不该**被当成真的截图回给模型——那正是
 * 「假装成功」的一种。服务层的截图路径会把它变成错误。
 * @returns 空截图。
 */
export function emptyComputerScreenshot(): ComputerScreenshot {
  return { bytes: new Uint8Array(0), mimeType: 'application/octet-stream' }
}
