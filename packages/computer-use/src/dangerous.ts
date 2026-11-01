/**
 * 危险动作清单：这个家族里哪些动作默认要人点头。
 *
 * **为什么单独一份清单，而不是散在代码里**：宿主要拿它决定「问不问人」，
 * 界面要拿它显示「这一步需要你确认」，测试要拿它断言「这些动作被拦住了」。
 * 三处各写一份 inevitably 会走偏，所以只留这一份。
 *
 * 判定标准只有一条：**这个动作会不会改变屏幕上的东西**。
 * - 移动鼠标、滚动：不会改变什么，鼠标移到哪儿都不算「做了什么」，所以不算危险；
 * - 点击：会。按错地方就按错地方——按到「发送」上就发出去了。
 * - 打字：会。打进对话框里就是内容，按下回车就发出去了。
 * - 按键：会。Ctrl+W 关掉窗口、Ctrl+A 全选后接 Delete 清空——按键的破坏力
 *   一点不比点击小。
 * @module @ryharness/computer-use/dangerous
 */

import type { ComputerActionKind, ComputerApprovalRequest } from './types.ts'

/**
 * 默认要人点头的动作种类。
 *
 * `move` 与 `scroll` 不在里面：它们不改内容。
 */
export const DANGEROUS_COMPUTER_ACTIONS: readonly ComputerActionKind[] = ['click', 'type', 'key']

/**
 * 这个动作是不是高危动作（默认要人点头）。
 * @param kind - 动作种类。
 * @returns 高危返回 true。
 */
export function isDangerousComputerAction(kind: ComputerActionKind): boolean {
  return DANGEROUS_COMPUTER_ACTIONS.includes(kind)
}

/**
 * 把一次动作说成一句人能看懂的中文。
 *
 * 给确认弹窗用：人看到「要在 (800, 600) 点一下」才知道自己批的是什么，
 * 只看到一个「click」是没法判断的。
 * @param request - 动作请求。
 * @returns 一句中文描述。
 */
export function describeComputerAction(request: ComputerApprovalRequest): string {
  switch (request.kind) {
    case 'click':
      return `要在屏幕 (${request.x ?? 0}, ${request.y ?? 0}) 点一下`
    case 'type':
      return `要在屏幕上输入：${request.text ?? ''}`
    case 'key':
      return `要按一下键：${request.key ?? ''}`
    case 'move':
      return `要把鼠标移到 (${request.x ?? 0}, ${request.y ?? 0})`
    case 'scroll':
      return `要滚动 (${request.dx ?? 0}, ${request.dy ?? 0})`
  }
}
