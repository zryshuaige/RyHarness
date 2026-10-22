/**
 * 内置插件：待办清单。
 *
 * 工具与路由都归插件 fiber：关闭插件后模型看不到 `todo` 工具、侧栏请求返回 404；
 * 文件本身留着，重新打开插件原清单还在。存储细节见 {@link TodoStore}。
 * @module @ryharness/server/plugins/todo
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import { createTodoHandlers } from '../routes/todos.ts'
import type { PluginEntry } from './host.ts'
import { TodoError, type TodoGroup, type TodoStore } from './todo-store.ts'

export type { TodoGroup, TodoItem } from './todo-store.ts'
export { TodoError, TodoStore } from './todo-store.ts'

export const TODO_PLUGIN_ID = 'todo'

/** 工具参数 → 对象；非对象按空参数处理，交给 action 校验给出可读错误。 */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** 清单的模型可读文本：带上 id，模型才有办法在下一轮 toggle 指定条目。 */
function renderGroup(group: TodoGroup): string {
  const done = group.items.filter((item) => {
    return item.done
  }).length
  if (group.items.length === 0) return '当前会话还没有待办。'
  const lines = group.items.map((item) => {
    return `- [${item.done ? 'x' : ' '}] ${item.text}（id: ${item.id}）`
  })
  return `当前会话待办（共 ${group.items.length} 项，已完成 ${done} 项）：\n${lines.join('\n')}`
}

function failure(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * `todo` 工具：读写当前会话的清单。
 *
 * 会话 id 来自 ToolContext（协调器在每一轮注入），模型不需要也不可能自己编一个。
 * 没有会话上下文时如实拒绝：把清单写到某个全局桶里，会让两个会话互相看见对方的
 * 待办，而用户完全无从解释。
 */
export function createTodoTool(store: TodoStore): Tool {
  return {
    name: 'todo',
    description:
      '记录、查看、勾选或清空当前会话的待办清单。用户让你记待办、记跟进事项，或问还差什么没做时使用；列表里每条都带 id，勾选时把它传给 toggle。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'toggle', 'clear'],
          description: 'list 查看；add 新增（需要 text）；toggle 勾选/取消（需要 id）；clear 清空。',
        },
        text: { type: 'string', description: 'add 时的待办内容，一句话说清要做什么。' },
        id: { type: 'string', description: 'toggle 时待办的 id（list 的返回里带）。' },
      },
      required: ['action'],
    },
    // 同一批模型调用里的多条待办变更必须串行：并发读改写会把后一条覆盖掉。
    executionMode: 'sequential',
    execute: async (args, context: ToolContext): Promise<ToolResult> => {
      const conversationId = context.conversationId
      if (conversationId === undefined || conversationId.length === 0) {
        return failure('待办只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = argsOf(args)
      const action = stringField(parsed, 'action')
      if (action === 'list') return { content: renderGroup(store.list(conversationId)) }
      if (action === 'add') {
        const text = stringField(parsed, 'text') ?? ''
        try {
          const group = await store.add(conversationId, text)
          return { content: `已记下「${text.trim()}」。\n${renderGroup(group)}` }
        } catch (error) {
          if (error instanceof TodoError) return failure(error.message)
          throw error
        }
      }
      if (action === 'toggle') {
        const id = stringField(parsed, 'id') ?? ''
        try {
          const group = await store.setDone(conversationId, id)
          const item = group.items.find((candidate) => {
            return candidate.id === id
          })
          return {
            content: `${item?.done === true ? '已标记完成' : '已标记未完成'}「${item?.text ?? id}」。\n${renderGroup(group)}`,
          }
        } catch (error) {
          if (error instanceof TodoError) return failure(error.message)
          throw error
        }
      }
      if (action === 'clear') {
        try {
          const group = await store.clear(conversationId)
          return { content: `已清空当前会话的待办。\n${renderGroup(group)}` }
        } catch (error) {
          if (error instanceof TodoError) return failure(error.message)
          throw error
        }
      }
      return failure('action 只能是 list / add / toggle / clear。')
    },
  }
}

/** 待办插件的依赖：会话存在性校验（路由用它拒绝不存在的会话）。 */
export interface TodoPluginDeps {
  /**
   * 待办存储：由组合根创建并持有。
   *
   * 不在插件里 new 的原因：RyVibe 落盘时要把任务清单写进**同一份**清单（用户在
   * 聊天页右侧看到的就是它）。两个实例各写各的内存态，后写的那份会把前一份的改动
   * 整份盖掉——所以这份存储必须只有一个。
   */
  store: TodoStore
  conversationExists(conversationId: string): boolean
}

/** 待办插件入口：工具 + 三条路由，全部随插件 fiber 装卸。 */
export function todoPlugin(deps: TodoPluginDeps): PluginEntry {
  return {
    id: TODO_PLUGIN_ID,
    name: '待办清单',
    description: '让助理把要跟进的事记进当前会话；关闭后工具与侧栏清单一起下线，文件保留。',
    group: 'feature',
    capabilities: {
      tools: ['todo'],
      routes: ['GET /api/todos', 'PATCH /api/todos/:id', 'DELETE /api/todos', 'POST /api/todos/restore'],
    },
    impact: '关闭后助理将无法记录待办，已有的待办记录保留；重新打开后恢复。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      const store = deps.store
      ctx.tools.register(createTodoTool(store))
      const handlers = createTodoHandlers({ store, conversationExists: deps.conversationExists })
      ctx.routes.register('GET', '/api/todos', handlers.list)
      ctx.routes.register('PATCH', '/api/todos/:id', handlers.setDone)
      ctx.routes.register('DELETE', '/api/todos', handlers.clear)
      ctx.routes.register('POST', '/api/todos/restore', handlers.restore)
    },
  }
}
