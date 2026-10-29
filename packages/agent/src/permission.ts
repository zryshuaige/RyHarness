/**
 * 权限档位：这个助理**能碰到什么**的一档说法。
 *
 * 此前只有「工具白名单」这一堆复选框：能勾，但没人说得清「勾了这几个等于给了它
 * 什么权限」，勾错一个 `shell_exec` 就是把整台电脑交出去。上游 dsh 把这件事做成了
 * permission preset——把「能干什么」收成三档，用户先选档，再按需微调。
 *
 * 档位管的是**内置工具**的范围；插件自己提供的工具（待办、提问、网页、MCP…）
 * 不受档位影响——那些是用户自己装的，装了就是装了。
 *
 * 档位与沙箱的关系要说明白：上游那一档还管着**内核级隔离**（bwrap / Landlock /
 * 沙箱 ACL），我们目前没有内核级隔离（见 docs/dsh-parity.md 的 sandbox 行），所以
 * 这里的档位是**工具面**上的收窄，不是文件系统级别的围栏。别把「只读」当成
 * 「模型碰不到工作区外的任何东西」——它只是拿不到写与执行工具而已。
 * @module @ryharness/agent/permission
 */

/** 权限档位。 */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'full-access'

/** 一档权限的定义。 */
export interface PermissionPresetSpec {
  readonly id: PermissionPreset
  /** 界面显示名。 */
  readonly name: string
  /** 一句话说明这一档能干什么。 */
  readonly summary: string
  /** 这一档允许的**内置**工具。 */
  readonly tools: readonly string[]
}

/** 受档位管辖的内置工具（其余是插件工具，档位不管）。 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'fs_read',
  'fs_write',
  'fs_glob',
  'fs_grep',
  'fs_edit',
  'shell_exec',
  'file_produce',
]

/** 三档权限。 */
export const PERMISSION_PRESETS: readonly PermissionPresetSpec[] = [
  {
    id: 'read-only',
    name: '只读',
    summary: '只能看：读文件、按名字找文件、按正则搜内容。不能写、不能改、不能执行命令。',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
  },
  {
    id: 'workspace-write',
    name: '工作区可写',
    summary: '能读能写工作区里的文件，也能把结果落成文件。不能执行命令。',
    tools: ['fs_read', 'fs_glob', 'fs_grep', 'fs_write', 'fs_edit', 'file_produce'],
  },
  {
    id: 'full-access',
    name: '全权',
    summary: '在「工作区可写」之上，还能执行命令（每条命令仍要你点头）。',
    tools: ['fs_read', 'fs_glob', 'fs_grep', 'fs_write', 'fs_edit', 'file_produce', 'shell_exec'],
  },
]

/**
 * 按 id 取档位定义。
 * @param id - 档位 id。
 * @returns 定义；不认识时是 undefined。
 */
export function permissionPreset(id: string): PermissionPresetSpec | undefined {
  return PERMISSION_PRESETS.find((preset) => {
    return preset.id === id
  })
}

/**
 * 把当前工具清单套到某一档上。
 *
 * 内置工具按档位**整组替换**（换档就是换权限，不是往里加）；插件工具原样保留——
 * 用户自己装的插件不该因为换了个档位就被卸掉。
 * @param current - 现在的工具清单。
 * @param preset - 目标档位。
 * @returns 套档之后的工具清单（去重、保持原有顺序，档位工具排在后面）。
 */
export function applyPermissionPreset(current: readonly string[], preset: PermissionPreset): string[] {
  const spec = permissionPreset(preset)
  if (spec === undefined) return [...current]
  const kept = current.filter((tool) => {
    return !CORE_TOOL_NAMES.includes(tool)
  })
  return [...new Set([...kept, ...spec.tools])]
}

/**
 * 当前清单落在哪一档。
 *
 * 用来在界面上显示「现在是哪档」：工具被用户手动改过、跟任何一档都不完全一致时，
 * 返回 undefined（界面显示「自定义」——**不是**报成某一档，那会骗用户）。
 * @param current - 现在的工具清单。
 * @returns 档位 id；不是任何一档时是 undefined。
 */
export function detectPermissionPreset(current: readonly string[]): PermissionPreset | undefined {
  const core = current.filter((tool) => {
    return CORE_TOOL_NAMES.includes(tool)
  })
  for (const preset of PERMISSION_PRESETS) {
    if (preset.tools.length !== core.length) continue
    if (
      preset.tools.every((tool) => {
        return core.includes(tool)
      })
    ) {
      return preset.id
    }
  }
  return undefined
}
