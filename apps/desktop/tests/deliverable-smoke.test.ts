import { describe, expect, it, vi } from 'vitest'
import { verifyGeneratedApp } from '../electron/deliverable-smoke.ts'

function windowWith(results: unknown[]) {
  const executeJavaScript = vi.fn()
  for (const result of results) executeJavaScript.mockResolvedValueOnce(result)
  return {
    webContents: {
      session: { clearStorageData: vi.fn(async () => {}) },
      loadFile: vi.fn(async () => {}),
      executeJavaScript,
      reload: vi.fn(),
    },
    hide: vi.fn(),
  }
}

describe('真实产物窗口验收', () => {
  it('点击与刷新都返回 12.5 才通过，并清理独立分区', async () => {
    const window = windowWith(['12.5', '12.5'])
    await verifyGeneratedApp('project/index.html', () => window)
    expect(window.webContents.session.clearStorageData).toHaveBeenCalledWith({ storages: ['localstorage'] })
    expect(window.webContents.loadFile).toHaveBeenCalledWith('project/index.html')
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.hide).toHaveBeenCalledTimes(1)
  })

  it('点击结果不对就失败，不假装产物可用', async () => {
    const window = windowWith(['0'])
    await expect(verifyGeneratedApp('broken.html', () => window)).rejects.toThrow('点击后的汇总不对：0')
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledTimes(1)
  })

  it('刷新后数据丢失也失败', async () => {
    const window = windowWith(['12.5', '0'])
    await expect(verifyGeneratedApp('broken.html', () => window)).rejects.toThrow('刷新后的汇总不对：0')
    expect(window.hide).toHaveBeenCalledTimes(1)
  })
})
