/**
 * 降级实现的单元测试：没装桌面驱动时如实报错，不假装成功。
 */
import { describe, expect, it } from 'vitest'
import {
  type ComputerUseError,
  createUnavailableComputerDriver,
  emptyComputerScreenshot,
  isComputerUseError,
} from '../src/index.ts'

describe('降级实现：没装驱动就如实报错', () => {
  it('每个方法都报 NO_DRIVER，没有一个假装成功', async () => {
    const driver = createUnavailableComputerDriver()
    expect(driver.name).toBe('unavailable')
    for (const call of [
      () => driver.screenshot(),
      () => driver.click(1, 2),
      () => driver.type('x'),
      () => driver.key('Enter'),
      () => driver.move(1, 2),
      () => driver.scroll(0, 10),
      () => driver.close(),
    ]) {
      try {
        await call()
        expect.unreachable('降级驱动不该成功')
      } catch (error) {
        expect(isComputerUseError(error, 'NO_DRIVER')).toBe(true)
      }
    }
  })

  it('错误消息说清了是「没装桌面驱动」', async () => {
    const driver = createUnavailableComputerDriver()
    try {
      await driver.screenshot()
      expect.unreachable('降级驱动不该成功')
    } catch (error) {
      expect((error as ComputerUseError).message).toContain('没装桌面驱动')
    }
  })

  it('驱动名可以自己定，便于宿主区分多个降级实现', () => {
    expect(createUnavailableComputerDriver('remote-x').name).toBe('remote-x')
  })

  it('空截图是空字节，不是假装有图的占位数据', () => {
    const shot = emptyComputerScreenshot()
    expect(shot.bytes.byteLength).toBe(0)
    expect(shot.mimeType).toBe('application/octet-stream')
  })
})
