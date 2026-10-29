/**
 * 能力标识的中文名（唯一真源）：agent 工具白名单与插件挂的接口。
 *
 * 此前 ContactsPage（新建/编辑表单的工具勾选）与 RightPanel（资料卡的工具徽章）
 * 各存一份，改名/加工具必然只改一处，界面上就会出现同一个工具两个叫法。
 * 服务端下发的 tools 是英文标识，界面一律经这里转成中文。
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  fs_read: '读文件',
  fs_write: '写文件',
  fs_glob: '按名字找文件',
  fs_grep: '搜文件内容',
  fs_edit: '改文件内容',
  shell_exec: '执行命令',
  file_produce: '产出文件',
  todo: '待办清单',
}

/**
 * 过程播报里的动作短语（不是名词）。
 *
 * 旧文案「正在使用工具：file_produce…」「工具 file_produce 完成」把内部标识直接
 * 排到了用户眼前（评审截图里的「工具 file_produce 完成」就是这一行）。这里给的是
 * 用户语言：在干什么、干完了什么。
 */
const TOOL_RUNNING: Readonly<Record<string, string>> = {
  fs_read: '正在读文件…',
  fs_write: '正在写文件…',
  fs_glob: '正在找文件…',
  fs_grep: '正在搜内容…',
  fs_edit: '正在改文件…',
  shell_exec: '正在执行命令…',
  file_produce: '正在生成文件…',
  todo: '正在整理待办…',
}

const TOOL_DONE: Readonly<Record<string, string>> = {
  fs_read: '已读文件',
  fs_write: '已写入文件',
  fs_glob: '已找到文件',
  fs_grep: '已搜到内容',
  fs_edit: '已改文件',
  shell_exec: '已执行命令',
  file_produce: '已生成文件',
  todo: '已更新待办',
}

/** 失败态用「动词 + 失败」，不用「已生成文件（失败）」这种自相矛盾的拼接。 */
const TOOL_FAILED: Readonly<Record<string, string>> = {
  fs_read: '读文件失败',
  fs_write: '写文件失败',
  fs_glob: '找文件失败',
  fs_grep: '搜内容失败',
  fs_edit: '改文件失败',
  shell_exec: '命令执行失败',
  file_produce: '生成文件失败',
  todo: '待办更新失败',
}

/** 运行中的动作文案；未知工具也用人话包一层，不裸奔英文标识。 */
export function toolRunningLabel(tool: string): string {
  return TOOL_RUNNING[tool] ?? `正在使用「${tool}」…`
}

/** 完成/失败的动作文案。 */
export function toolDoneLabel(tool: string): string {
  return TOOL_DONE[tool] ?? `「${tool}」已结束`
}

/** 失败的动作文案。 */
export function toolFailedLabel(tool: string): string {
  return TOOL_FAILED[tool] ?? `「${tool}」执行失败`
}

export const ALL_TOOLS: readonly string[] = Object.keys(TOOL_LABELS)

/** 工具的中文名；未知工具原样返回标识（宁可暴露也不显示空白）。 */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

/**
 * 插件挂的接口（`POST /api/voice/speak`）→ 人话。
 *
 * 插件页的展开区里摆的是"这个插件替你做了什么"，`POST /api/voice/speak` 回答不了
 * 这个问题——它是开发者单位。这里按「动词 + 路径段落」拼一句中文，原始路由由调用点
 * 留在 title 上（与 humanMime 同一套做法）。路径参数（`:id`）不上屏。
 */
const ROUTE_VERBS: Readonly<Record<string, string>> = {
  GET: '读取',
  POST: '发起',
  PATCH: '修改',
  PUT: '写入',
  DELETE: '删除',
}

/** 路由路径段 → 人话；只登记 apps/server 真正挂出来的那些（见它的路由清单）。 */
const ROUTE_SEGMENTS: Readonly<Record<string, string>> = {
  'agent-templates': '助理模板',
  'agent-voices': '助理音色',
  agents: '助理',
  affinity: '亲密度',
  memories: '记忆',
  playbook: '经验手册',
  conversations: '会话',
  messages: '消息',
  files: '文件',
  cancel: '中止',
  dispatch: '调度',
  read: '已读',
  'stream-seq': '流序号',
  evolve: '经验',
  consolidate: '整理',
  entries: '条目',
  explain: '溯源',
  stats: '统计',
  feedback: '反馈',
  info: '信息',
  raw: '原文',
  memory: '记忆',
  archived: '归档',
  health: '健康度',
  reembed: '重建索引',
  restore: '恢复',
  status: '状态',
  plugins: '插件',
  proactive: '主动消息',
  'provider-presets': '服务模板',
  providers: '模型服务',
  verify: '测连接',
  discover: '发现模型',
  questions: '提问',
  answer: '回答',
  search: '搜索',
  settings: '设置',
  'api-key': 'API Key',
  telemetry: '运行记录',
  todos: '待办清单',
  usage: '用量',
  voice: '语音',
  engines: '引擎',
  piper: 'Piper',
  catalog: '目录',
  speak: '朗读',
  install: '安装',
  workspace: '工作区',
}

/** 认不全的路由不猜：宁可说"一个接口"，也不把 `PATCH /api/x/:y` 拆开念给用户。 */
export function routeLabel(route: string): string {
  const [method = '', ...rest] = route.trim().split(/\s+/)
  const verb = ROUTE_VERBS[method.toUpperCase()]
  const segments = rest
    .join('/')
    .split('/')
    .filter((segment) => {
      // 开头的 `api` 是接口根，不是这一段接口在做的事；`:id` 是参数，不是能力。
      return segment.length > 0 && segment !== 'api' && !segment.startsWith(':')
    })
  const words = segments.map((segment) => {
    return ROUTE_SEGMENTS[segment]
  })
  if (verb === undefined || words.length === 0 || words.some((word) => word === undefined)) return '这个插件提供的接口'
  return `${verb}${words.join('')}`
}
