import { BUILTIN_TEMPLATES, forkTemplate, RYEN_TEMPLATE } from '@ryharness/agent'
import { describe, expect, it } from 'vitest'

describe('内置 Ryen 模板的工具白名单', () => {
  it('默认不带 shell_exec（与服务端模板目录一致），但带「找得到、改得动」那三个', () => {
    expect(RYEN_TEMPLATE.tools).toEqual([
      'fs_read',
      'fs_write',
      'fs_glob',
      'fs_grep',
      'fs_edit',
      'file_produce',
      'todo',
    ])
    expect(RYEN_TEMPLATE.tools).not.toContain('shell_exec')
  })

  it('fork 出来的用户 agent 继承同一份白名单（显式勾选才拿得到 shell_exec）', () => {
    const forked = forkTemplate(RYEN_TEMPLATE)
    expect(forked.tools).toEqual(RYEN_TEMPLATE.tools)
    const enabled = forkTemplate(RYEN_TEMPLATE, { tools: [...RYEN_TEMPLATE.tools, 'shell_exec'] })
    expect(enabled.tools).toContain('shell_exec')
    // fork 不共享引用：给 fork 追加工具不会污染内置模板。
    expect(RYEN_TEMPLATE.tools).not.toContain('shell_exec')
    expect(BUILTIN_TEMPLATES.ryen?.tools).toEqual(RYEN_TEMPLATE.tools)
  })
})
