/**
 * 助理能力预设：登记、选中、版本回看。
 */

import { PresetError, PresetRegistry } from '@ryharness/preset'
import { describe, expect, it } from 'vitest'

function registry(): PresetRegistry {
  const presets = new PresetRegistry()
  presets.register({
    id: 'reader',
    name: '只读',
    description: '只能看',
    tools: ['fs_read', 'fs_glob'],
  })
  presets.register({
    id: 'builder',
    name: '能改',
    description: '能读能写',
    tools: ['fs_read', 'fs_write', 'fs_edit'],
    prompt: '改文件前先读一遍。',
    skills: ['edit-guide'],
  })
  return presets
}

describe('预设注册表', () => {
  it('按 id 排序列出', () => {
    const presets = new PresetRegistry()
    presets.register({ id: 'b', name: 'B', description: 'x', tools: [] })
    presets.register({ id: 'a', name: 'A', description: 'x', tools: [] })
    expect(presets.list().map((preset) => preset.id)).toEqual(['a', 'b'])
  })

  it('id 不合法直接拒', () => {
    const presets = new PresetRegistry()
    expect(() => presets.register({ id: 'A B', name: 'x', description: 'y', tools: [] })).toThrow(PresetError)
  })

  it('同一个 id 登记两次报错', () => {
    const presets = registry()
    try {
      presets.register({ id: 'reader', name: '又一个', description: 'x', tools: [] })
      expect.fail('应该报错')
    } catch (error) {
      expect((error as PresetError).code).toBe('duplicate-id')
    }
  })

  it('选一个不存在的预设报 not-found', () => {
    const presets = registry()
    try {
      presets.select('a1', 'nope')
      expect.fail('应该报错')
    } catch (error) {
      expect((error as PresetError).code).toBe('not-found')
    }
  })
})

describe('选中与版本', () => {
  it('选一次产生第 1 版，带上工具与提示', () => {
    const presets = registry()
    const revision = presets.select('a1', 'builder')
    expect(revision.revision).toBe(1)
    expect(revision.tools).toEqual(['fs_read', 'fs_write', 'fs_edit'])
    expect(revision.prompt).toBe('改文件前先读一遍。')
    expect(revision.skills).toEqual(['edit-guide'])
  })

  it('再选一次版本 +1，旧版留着', () => {
    const presets = registry()
    presets.select('a1', 'reader')
    const second = presets.select('a1', 'builder')
    expect(second.revision).toBe(2)
    expect(presets.revisionsOf('a1')).toHaveLength(2)
    expect(presets.revision('a1', 1)?.presetId).toBe('reader')
  })

  it('不同助理各算各的版本号', () => {
    const presets = registry()
    expect(presets.select('a1', 'reader').revision).toBe(1)
    expect(presets.select('a2', 'reader').revision).toBe(1)
    expect(presets.select('a1', 'reader').revision).toBe(2)
  })

  it('当前版本就是最后选的那个', () => {
    const presets = registry()
    presets.select('a1', 'reader')
    presets.select('a1', 'builder')
    expect(presets.current('a1')?.presetId).toBe('builder')
  })

  it('生效能力取当前版本；没选过就报错，不默默给空的', () => {
    const presets = registry()
    try {
      presets.effective('a1')
      expect.fail('应该报错')
    } catch (error) {
      expect((error as PresetError).code).toBe('no-selection')
    }
    presets.select('a1', 'reader')
    expect(presets.effective('a1').tools).toEqual(['fs_read', 'fs_glob'])
  })

  it('版本里的工具是副本：改它不影响预设本身', () => {
    const presets = registry()
    const revision = presets.select('a1', 'reader')
    const mutable = revision.tools as string[]
    mutable.push('shell_exec')
    expect(presets.get('reader')?.tools).toEqual(['fs_read', 'fs_glob'])
  })
})
