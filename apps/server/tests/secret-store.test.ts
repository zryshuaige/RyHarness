/**
 * 应用内凭据存储：safeStorage 加密 + 向后兼容。
 *
 * 三条必须成立：桌面端写出来的是密文（文件被拷走也解不开）、旧版的明文文件照样读得
 * 出来（升级不能让人重新粘一遍 key）、解不开时明确提示而不是静默当成"没配过"。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureSecretStore, loadApiKeys, type SecretCodec, saveApiKey, secretStoreCipher } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-secrets-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, 'config'), { recursive: true })
  return dir
}

function keysPath(dataDir: string): string {
  return join(dataDir, 'config', 'api-keys.json')
}

function readKeysFile(dataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(keysPath(dataDir), 'utf8')) as Record<string, unknown>
}

/** 假 safeStorage：加一层前缀当"密文"，解不开时抛（模拟换了系统账户）。 */
const fakeSafeStorage: SecretCodec = {
  id: 'safeStorage',
  seal: (plain) => {
    return `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`
  },
  open: (sealed) => {
    if (!sealed.startsWith('sealed:')) throw new Error('not encrypted with this profile')
    return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
  },
}

/** 明文降级路径（无 Electron 的独立进程 / CI / 测试）。 */
const plaintext: SecretCodec = { id: 'plaintext', seal: (plain) => plain, open: (sealed) => sealed }

afterEach(() => {
  configureSecretStore(undefined)
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('凭据落盘：safeStorage 加密', () => {
  it('写出去的是密文，读回来是明文；cipher 如实记成 safeStorage', () => {
    configureSecretStore(fakeSafeStorage)
    const dataDir = tempDataDir()
    expect(saveApiKey(dataDir, 'siliconflow', 'sk-super-secret')).toBe(true)

    const file = readKeysFile(dataDir)
    expect(file.cipher).toBe('safeStorage')
    const keys = file.keys as Record<string, string>
    expect(keys.siliconflow).not.toContain('sk-super-secret')
    expect(readFileSync(keysPath(dataDir), 'utf8')).not.toContain('sk-super-secret')
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-super-secret' })
    expect(secretStoreCipher()).toBe('safeStorage')
  })

  it('旧版明文文件照读，并在下一次写入时升级成加密信封', () => {
    configureSecretStore(fakeSafeStorage)
    const dataDir = tempDataDir()
    writeFileSync(keysPath(dataDir), JSON.stringify({ siliconflow: 'sk-legacy-plaintext' }), 'utf8')
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-legacy-plaintext' })

    saveApiKey(dataDir, 'siliconflow', 'sk-rotated')
    const file = readKeysFile(dataDir)
    expect(file.cipher).toBe('safeStorage')
    expect(readFileSync(keysPath(dataDir), 'utf8')).not.toContain('sk-legacy-plaintext')
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-rotated' })
  })

  it('换系统账户后解不开：不抛、按"没有凭据"起，绝不当成静默成功', () => {
    const dataDir = tempDataDir()
    configureSecretStore(fakeSafeStorage)
    expect(saveApiKey(dataDir, 'siliconflow', 'sk-a')).toBe(true)

    // 另一个"系统账户"的密钥：什么都解不开。
    configureSecretStore({
      id: 'safeStorage',
      seal: (plain) => `other:${plain}`,
      open: (sealed) => {
        if (!sealed.startsWith('other:')) throw new Error('wrong profile')
        return sealed.slice('other:'.length)
      },
    })
    expect(loadApiKeys(dataDir)).toEqual({})
  })

  it('降级路径明文写入时 cipher 如实记 plaintext（不假装已加密）', () => {
    configureSecretStore(plaintext)
    const dataDir = tempDataDir()
    saveApiKey(dataDir, 'siliconflow', 'sk-plain')
    const file = readKeysFile(dataDir)
    expect(file.cipher).toBe('plaintext')
    expect((file.keys as Record<string, string>).siliconflow).toBe('sk-plain')
    expect(loadApiKeys(dataDir)).toEqual({ siliconflow: 'sk-plain' })
  })

  it('无系统密钥库的环境读到 safeStorage 密文时不当成明文用（宁可空着也不递密文）', () => {
    const dataDir = tempDataDir()
    configureSecretStore(fakeSafeStorage)
    saveApiKey(dataDir, 'siliconflow', 'sk-cross-machine')

    // 换到明文降级环境（别的机器 / 无 Electron 的开发进程）：解不开。
    configureSecretStore(plaintext)
    expect(loadApiKeys(dataDir)).toEqual({})
    expect(secretStoreCipher()).toBe('plaintext')
  })

  it('未知供应商不写盘（白名单之外一律拒绝）', () => {
    configureSecretStore(fakeSafeStorage)
    const dataDir = tempDataDir()
    expect(saveApiKey(dataDir, 'not-a-provider', 'sk-x')).toBe(false)
  })
})
