/**
 * 改名那天的兼容层：老用户的东西不能因为改了名字就"消失"。
 *
 * 产品从 RyAgent 改成 RyHarness 时，一批标识跟着换了：凭据文件的 schema 标记、
 * 环境变量名、localStorage 键、数据目录的位置与数据库文件名。
 *
 * 每一样都对应用户**已经攒下的东西**：填过的 API key、写脚本时用的环境变量名、
 * 面板收起态与**没发出去的草稿**、以及整个会话库与长期记忆。任何一样认不出来，
 * 用户看到的都是"我的东西全没了"，而数据其实都还在原处。
 *
 * @module @ryharness/server/tests/rename-compat
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadApiKeys, saveApiKey } from '../src/config.ts'
import { envValue } from '../src/env.ts'

const tmpDirs: string[] = []

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-rename-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

describe('凭据文件：旧 schema 标记也要认', () => {
  it('老安装的 api-keys.json（标记是 ryagent/api-keys@2）读得出来', async () => {
    const dataDir = tempDataDir()
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    // 老文件：明文（没有 safeStorage 的开发环境就是这个形状）。
    writeFileSync(
      join(dataDir, 'config', 'api-keys.json'),
      JSON.stringify({ $schema: 'ryagent/api-keys@2', cipher: 'plaintext', keys: { siliconflow: 'sk-old' } }),
      'utf8',
    )
    // 认不出来的话，这份文件会被当成 v1（扁平明文）读，用户填过的 key 就"全没了"。
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-old' })
  })

  it('新写的文件用新标记，且下次读回还在', () => {
    const dataDir = tempDataDir()
    expect(saveApiKey(dataDir, 'siliconflow', 'sk-new')).toBe(true)
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-new' })
  })
})

describe('环境变量：旧名仍然认', () => {
  it('新名优先', () => {
    expect(envValue({ RYHARNESS_PORT: '1', RYAGENT_PORT: '2' }, 'PORT')).toBe('1')
  })

  it('只有旧名时也认（用户的脚本里写的还是旧名）', () => {
    expect(envValue({ RYAGENT_PORT: '2' }, 'PORT')).toBe('2')
    expect(envValue({ RYAGENT_DATA_DIR: 'D:\\data' }, 'DATA_DIR')).toBe('D:\\data')
  })

  it('两个都没有时是 undefined（不是空串）', () => {
    expect(envValue({}, 'PORT')).toBeUndefined()
    expect(envValue({ RYHARNESS_PORT: '' }, 'PORT')).toBeUndefined()
  })
})
