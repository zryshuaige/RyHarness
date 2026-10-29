/**
 * 权限档位在界面这一侧的两个动作：按档位收窄工具清单、认出当前落在哪一档。
 *
 * 档位清单来自服务端（`GET /api/permission-presets`），这里**不另存一份**：
 * 档位与它管着的工具名必须一致，界面抄一份就会漂——漂了之后界面上写着
 * 「只读」、实际放行的工具里却还挂着执行命令。
 *
 * 怎么认出「哪些是内置工具」：所有档位里出现过的工具合起来就是内置工具集
 * （每一档管的都是内置工具那一组）。插件给的工具（待办、提问、网页、MCP…）
 * 不在任何一档里，于是换档时原样保留——用户自己装的插件不该被换档卸掉。
 */
import type { PermissionPresetView } from '../api.ts'

/** 所有档位合起来覆盖到的工具 = 受档位管辖的内置工具。 */
export function coreToolNames(presets: readonly PermissionPresetView[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const preset of presets) {
    for (const tool of preset.tools) names.add(tool)
  }
  return names
}

/**
 * 把工具清单套到某一档上：内置工具整组替换，插件工具原样保留。
 * @param presets - 服务端给的档位清单。
 * @param presetId - 目标档位。
 * @param current - 现在的工具清单。
 * @returns 套档之后的清单；档位不认识时原样返回。
 */
export function applyPreset(
  presets: readonly PermissionPresetView[],
  presetId: string,
  current: readonly string[],
): string[] {
  const preset = presets.find((candidate) => {
    return candidate.id === presetId
  })
  if (preset === undefined) return [...current]
  const core = coreToolNames(presets)
  const kept = current.filter((tool) => {
    return !core.has(tool)
  })
  return [...new Set([...kept, ...preset.tools])]
}

/**
 * 当前清单落在哪一档；不是任何一档时返回 undefined（界面显示「自定义」）。
 * @param presets - 服务端给的档位清单。
 * @param current - 现在的工具清单。
 * @returns 档位 id；不是任何一档时是 undefined。
 */
export function detectPreset(presets: readonly PermissionPresetView[], current: readonly string[]): string | undefined {
  const core = coreToolNames(presets)
  const coreTools = current.filter((tool) => {
    return core.has(tool)
  })
  for (const preset of presets) {
    if (preset.tools.length !== coreTools.length) continue
    if (
      preset.tools.every((tool) => {
        return coreTools.includes(tool)
      })
    ) {
      return preset.id
    }
  }
  return undefined
}
