/**
 * agent 工具白名单的中文名（唯一真源）。
 *
 * 此前 ContactsPage（新建/编辑表单的工具勾选）与 RightPanel（资料卡的工具徽章）
 * 各存一份，改名/加工具必然只改一处，界面上就会出现同一个工具两个叫法。
 * 服务端下发的 tools 是英文标识，界面一律经这里转成中文。
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  fs_read: '读文件',
  fs_write: '写文件',
  shell_exec: '执行命令',
  file_produce: '产出文件',
}

export const ALL_TOOLS: readonly string[] = Object.keys(TOOL_LABELS)

/** 工具的中文名；未知工具原样返回标识（宁可暴露也不显示空白）。 */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}
