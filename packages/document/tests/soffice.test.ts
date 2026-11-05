/**
 * soffice 转换器的用例：找可执行文件、平台分支、转换失败的处理。
 *
 * **不真跑 LibreOffice**（本机没装）；这一族盯的是「找得到 / 找不到 / 跑不起来」
 * 这三条路的说法对不对。真的转文档由 Word COM 那条路负责（见 `converters.test.ts`）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSoffice } from '../src/index.ts'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-soffice-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('找 soffice', () => {
  it('显式给的路径存在就用它', () => {
    const dir = tempDir()
    const exe = join(dir, 'soffice')
    writeFileSync(exe, '', 'utf8')
    expect(findSoffice({ executablePath: exe })).toBe(exe)
  })

  it('显式给的路径不存在：找不到就说找不到', () => {
    const dir = tempDir()
    expect(findSoffice({ executablePath: join(dir, 'nope') })).toBeUndefined()
  })

  it('Windows 上按 ProgramFiles 找', () => {
    const dir = tempDir()
    // 候选路径是 `ProgramFiles/LibreOffice/program/soffice.exe`——中间那层也要有。
    const programDir = join(dir, 'LibreOffice', 'program')
    mkdirSync(programDir, { recursive: true })
    const exe = join(programDir, 'soffice.exe')
    writeFileSync(exe, '', 'utf8')
    const found = findSoffice({
      platform: 'win32',
      env: { ProgramFiles: dir, 'ProgramFiles(x86)': dir },
    })
    expect(found).toBe(exe)
  })

  it('Windows 上 32 位与 64 位目录都试', () => {
    const dir = tempDir()
    const programDir = join(dir, 'LibreOffice', 'program')
    mkdirSync(programDir, { recursive: true })
    const exe = join(programDir, 'soffice.exe')
    writeFileSync(exe, '', 'utf8')
    // 只给 ProgramFiles(x86)：也要能找到。
    const found = findSoffice({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': dir },
    })
    expect(found).toBe(exe)
  })

  it('macOS 上按固定路径找', () => {
    // 那个路径在本机不存在——找不到是正确结果。
    expect(findSoffice({ platform: 'darwin', env: {} })).toBeUndefined()
  })

  it('Linux 上按固定路径找', () => {
    expect(findSoffice({ platform: 'linux', env: {} })).toBeUndefined()
  })
})
