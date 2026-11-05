/**
 * CDP 驱动的错误路径：连不上浏览器、页面打不开、找不到元素、元素没有可见区域。
 *
 * 这一族盯的是「失败要说清楚」——模型拿到的是错误结果，所以错误文案与错误码
 * 本身就是产品的一部分。
 */
import { describe, expect, it } from 'vitest'
import { createCdpDriverFactory } from '../src/index.ts'

describe('CDP 驱动的错误路径', () => {
  it(
    '找不到浏览器：报 NO_DRIVER，不是一个含糊的失败',
    async () => {
      const factory = createCdpDriverFactory({ executablePath: 'C:\\definitely\\not\\there.exe' })
      try {
        await expect(factory.driverFactory()).rejects.toMatchObject({ code: 'NO_DRIVER' })
      } finally {
        await factory.close()
      }
    },
    30_000,
  )

  it(
    '浏览器起来了但页面打不开：报 DRIVER_FAILED',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        // 这个协议不是 http/https——CDP 会拒绝导航。
        await expect(driver.open('not-a-valid-url')).rejects.toMatchObject({ code: 'DRIVER_FAILED' })
      } finally {
        await factory.close()
      }
    },
    90_000,
  )

  it(
    '元素没有可见区域（宽高都是 0）：说清楚是尺寸问题，不是「找不到」',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        await driver.open(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent('<html><body><div id="hidden" style="display:none">看不见</div></body></html>'),
        )
        await expect(driver.click('#hidden')).rejects.toThrow(/没有可见区域/)
      } finally {
        await factory.close()
      }
    },
    90_000,
  )

  it(
    '页面加载不完：报 TIMEOUT，不是干等着',
    async () => {
      // 时限给 1 毫秒——页面肯定来不及加载完。
      const factory = createCdpDriverFactory({ navigateTimeoutMs: 1 })
      try {
        const driver = await factory.driverFactory()
        await expect(driver.open('https://example.com')).rejects.toMatchObject({ code: 'TIMEOUT' })
      } finally {
        await factory.close()
      }
    },
    90_000,
  )
})
