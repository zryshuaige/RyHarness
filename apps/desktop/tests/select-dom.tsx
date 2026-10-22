// @vitest-environment jsdom
/**
 * 自绘下拉（components/Select.tsx）的测试操作面。
 *
 * 为什么需要这一层：这些下拉不再是原生 `<select>`，于是"选一项"这件事在测试里也不
 * 再是"给 value 赋值 + 派发 change"。它现在真的是一次交互——点开、在弹层里选中、收起，
 * 断言也必须落在看得见的界面上（触发器上的名字、弹层里的分组与标注）。谁把断言改成
 * 直接调组件的 props，那条用例就再也测不到产品行为了。
 *
 * 按 aria-label 定位，不按下标：下拉在一个页面里不止一个，而这几屏的字段顺序会变。
 */
import { act } from 'react'

/** 下拉的触发按钮（role=combobox 或普通按钮，取决于是否可搜索）。 */
export function selectTrigger(scope: ParentNode, ariaLabel: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('.select-trigger')].find((node) => {
    return node.getAttribute('aria-label') === ariaLabel
  })
  if (found === undefined) throw new Error(`找不到下拉：${ariaLabel}`)
  return found
}

/** 点开某个下拉（先给触发器焦点：真实点击会聚焦，jsdom 的 .click() 不会）。 */
export function openSelect(scope: ParentNode, ariaLabel: string): HTMLElement {
  act(() => {
    selectTrigger(scope, ariaLabel).focus()
    selectTrigger(scope, ariaLabel).click()
  })
  const popover = document.querySelector<HTMLElement>('.select-popover')
  if (popover === null) throw new Error(`下拉没有打开：${ariaLabel}`)
  return popover
}

/** 弹层还在不在（用于断言"点外面就收"这类关闭时机）。 */
export function popoverOpen(): boolean {
  return document.querySelector('.select-popover') !== null
}

/** 弹层里的选项行（分组小标题不是选项，不在其中）。 */
export function optionRows(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('.select-option')]
}

/** 弹层里每一项的取值，顺序即渲染顺序。 */
export function optionValues(scope: ParentNode): string[] {
  return optionRows(scope).map((node) => {
    return node.dataset.value ?? ''
  })
}

/** 每一项上显示的字（读 .select-option-label：选中项里还挂着一枚勾图标）。 */
export function optionLabels(scope: ParentNode): string[] {
  return [...scope.querySelectorAll<HTMLElement>('.select-option-label')].map((node) => {
    return node.textContent ?? ''
  })
}

/** 弹层里的分组小标题。 */
export function groupLabels(scope: ParentNode): string[] {
  return [...scope.querySelectorAll<HTMLElement>('.select-group')].map((node) => {
    return node.textContent ?? ''
  })
}

/** 打开 → 读全部取值 → 收起。给"下拉里到底列了什么"这类断言用。 */
export function listedValues(scope: ParentNode, ariaLabel: string): string[] {
  const popover = openSelect(scope, ariaLabel)
  const values = optionValues(popover)
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  return values
}

/** 当前值：打开后看哪一项是选中态（而不是去读组件的 props）。 */
export function currentValue(scope: ParentNode, ariaLabel: string): string | undefined {
  const popover = openSelect(scope, ariaLabel)
  const picked = popover.querySelector<HTMLElement>('.select-option[aria-selected="true"]')?.dataset.value
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  return picked
}

/** 打开 → 选中某一项（真按 mousedown 走，和手指一致）。 */
export function pickOption(scope: ParentNode, ariaLabel: string, value: string): void {
  const popover = openSelect(scope, ariaLabel)
  const row = optionRows(popover).find((node) => {
    return node.dataset.value === value
  })
  if (row === undefined) throw new Error(`下拉「${ariaLabel}」里没有这一项：${value}`)
  act(() => {
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  if (popoverOpen()) throw new Error(`选中之后下拉没收：${ariaLabel}`)
}

/** 取不到就当场报错，并说清找的是什么：断言之前静默拿到 undefined 只会把错报歪。 */
export function must<T>(node: T | null | undefined, what: string): T {
  if (node === null || node === undefined) throw new Error(`找不到：${what}`)
  return node
}

/** 触发按钮上的文字（用户真正看到的那个名字）。 */
export function triggerLabel(scope: ParentNode, ariaLabel: string): string {
  return selectTrigger(scope, ariaLabel).querySelector('.select-value')?.textContent ?? ''
}
