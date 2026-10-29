/**
 * 权限档位：换档就是换权限，档位与工具清单必须一致。
 */
import { applyPermissionPreset, detectPermissionPreset, PERMISSION_PRESETS } from '@ryharness/agent'
import { describe, expect, it } from 'vitest'

describe('权限档位', () => {
  it('三档各自放行的内置工具不同，且逐级变宽', () => {
    const [readOnly, writable, full] = PERMISSION_PRESETS
    expect(readOnly?.id).toBe('read-only')
    expect(writable?.id).toBe('workspace-write')
    expect(full?.id).toBe('full-access')
    // 只读档不能带写与执行。
    expect(readOnly?.tools).not.toContain('fs_write')
    expect(readOnly?.tools).not.toContain('shell_exec')
    expect(writable?.tools).toContain('fs_write')
    expect(writable?.tools).not.toContain('shell_exec')
    expect(full?.tools).toContain('shell_exec')
  })

  it('换档整组替换内置工具', () => {
    const tools = applyPermissionPreset(['fs_read', 'fs_write', 'shell_exec', 'todo'], 'read-only')
    expect(tools).toContain('fs_read')
    expect(tools).toContain('todo')
    expect(tools).not.toContain('fs_write')
    expect(tools).not.toContain('shell_exec')
  })

  it('插件给的工具不受档位影响（用户自己装的插件不该被换档卸掉）', () => {
    const tools = applyPermissionPreset(['fs_read', 'todo', 'ask_user', 'mcp__x__y'], 'read-only')
    expect(tools).toContain('todo')
    expect(tools).toContain('ask_user')
    expect(tools).toContain('mcp__x__y')
  })

  it('认得出当前落在哪一档', () => {
    expect(detectPermissionPreset(['fs_read', 'fs_glob', 'fs_grep'])).toBe('read-only')
    expect(detectPermissionPreset(['fs_read', 'fs_glob', 'fs_grep', 'fs_write', 'fs_edit', 'file_produce'])).toBe(
      'workspace-write',
    )
    expect(detectPermissionPreset(['fs_read', 'shell_exec'])).toBeUndefined()
  })

  it('认不出来的清单报「不是任何一档」，不硬套一档', () => {
    // 只给 fs_read 一个工具：每一档都比它多，所以哪一档都不是。
    expect(detectPermissionPreset(['fs_read'])).toBeUndefined()
    expect(detectPermissionPreset([])).toBeUndefined()
  })
})
