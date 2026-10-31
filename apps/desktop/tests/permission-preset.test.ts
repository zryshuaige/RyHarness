/**
 * 权限档位的界面逻辑：换档、认档，以及**回包不可信时的容错**。
 *
 * 容错那几条不是防御性编程洁癖：测试替身与旧服务端都可能没有这个接口，
 * 崩掉的话整个「新建 agent」表单都开不了——而档位只是可选功能。
 */

import { describe, expect, it } from 'vitest'
import type { PermissionPresetView } from '../renderer/src/api.ts'
import { applyPreset, coreToolNames, detectPreset } from '../renderer/src/lib/permission.ts'

const PRESETS: PermissionPresetView[] = [
  { id: 'read-only', name: '只读', summary: '只能看', tools: ['fs_read', 'fs_glob'] },
  { id: 'workspace-write', name: '工作区可写', summary: '能读能写', tools: ['fs_read', 'fs_glob', 'fs_write'] },
  { id: 'full-access', name: '全权', summary: '还能执行命令', tools: ['fs_read', 'fs_glob', 'fs_write', 'shell_exec'] },
]

describe('界面侧的权限档位', () => {
  it('换档：内置工具整组替换，插件工具保留', () => {
    const tools = applyPreset(PRESETS, 'read-only', ['fs_read', 'fs_write', 'shell_exec', 'todo'])
    expect(tools).toContain('fs_read')
    expect(tools).toContain('todo')
    expect(tools).not.toContain('fs_write')
    expect(tools).not.toContain('shell_exec')
  })

  it('认出当前落在哪一档', () => {
    expect(detectPreset(PRESETS, ['fs_read', 'fs_glob'])).toBe('read-only')
    expect(detectPreset(PRESETS, ['fs_read', 'fs_glob', 'fs_write'])).toBe('workspace-write')
    expect(detectPreset(PRESETS, ['fs_read'])).toBeUndefined()
  })

  it('清单缺了时当作没有（回包形状不可信不该让表单崩）', () => {
    expect(coreToolNames(undefined).size).toBe(0)
    expect(applyPreset(undefined, 'read-only', ['fs_read'])).toEqual(['fs_read'])
    expect(detectPreset(undefined, ['fs_read'])).toBeUndefined()
  })

  it('档位 id 不认识时不动工具清单', () => {
    expect(applyPreset(PRESETS, 'nope', ['fs_read', 'todo'])).toEqual(['fs_read', 'todo'])
  })
})
