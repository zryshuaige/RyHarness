/**
 * 会话列表新增那批类名的验收网：行尾操作条、搜索分组与行内高亮、行内徽标、
 * 行尾菜单的层级。跑在 node 环境（要读文件），与 jsdom 的渲染测试分开。
 *
 * 钉的是几条具体约定，不是「样式存在」这种空话：亮度两档归样式表管、菜单层级
 * 走 token 不写裸数字、命中词的高亮走 --search-hit-* 且深浅两个主题都有取值。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../renderer/src/', import.meta.url)

/** 去注释后的样式源码：注释里提到的 token / 选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
const base = strip(readFileSync(new URL('styles.css', SRC), 'utf8'))

/** 顶层规则（不在 @media / @keyframes / @container 内）的「选择器组 → 声明块」。 */
function topLevelRules(css: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = []
  let depth = 0
  let ruleStart = 0
  let bodyStart = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth !== 0) continue
      const prelude = css.slice(ruleStart, bodyStart - 1).trim()
      if (!prelude.startsWith('@')) {
        out.push({
          selectors: prelude.split(',').map((sel) => {
            return sel.trim().replace(/\s+/g, ' ')
          }),
          body: css.slice(bodyStart, i),
        })
      }
      ruleStart = i + 1
    }
  }
  return out
}

/** 取某条顶层规则的声明块（找不到返回空串）。 */
function ruleBody(selector: string, from = base): string {
  for (const rule of topLevelRules(from)) {
    if (rule.selectors.includes(selector)) return rule.body
  }
  return ''
}

describe('行尾操作条：常显但压暗，聚焦与悬停才点亮', () => {
  it('默认半透，两档亮度都写在样式表里', () => {
    const actions = ruleBody('.conversation-item-actions')
    expect(actions).toMatch(/opacity:\s*\.\d/)
    expect(actions).not.toContain('opacity: 1')
    // 键盘聚焦要和悬停同权：入口若只在 hover 时出现，键盘用户根本够不着
    const lit = [
      ruleBody('.conversation-item:hover .conversation-item-actions'),
      ruleBody('.conversation-item:focus-within .conversation-item-actions'),
    ].join('\n')
    expect(lit).toContain('opacity: 1')
  })

  it('⋯ 键有自己的悬停/展开态，且不叠描边（抬不起来的控件用底色说话）', () => {
    const more = ruleBody('.conversation-more')
    expect(more).toContain('cursor: pointer')
    expect(more).toContain('border: none')
    expect(more).not.toMatch(/border: (?!none)/)
    const lit = [ruleBody('.conversation-more:hover'), ruleBody(".conversation-more[aria-expanded='true']")].join('\n')
    expect(lit).toContain('background: var(--hover-bg)')
  })
})

describe('搜索结果：分组与行内高亮', () => {
  it('组头与片段各有一处主规则，片段按行数收口', () => {
    expect(ruleBody('.search-group-title')).toContain('font-weight: 600')
    const snippet = ruleBody('.search-hit-snippet')
    expect(snippet).toContain('-webkit-line-clamp: 2')
    // 片段是按钮：复位 + 可点，不能落回 UA 默认按钮
    expect(ruleBody('.search-hit')).toContain('cursor: pointer')
    expect(ruleBody('.search-hit')).toMatch(/background:\s*none/)
  })

  it('命中词的高亮走 token，深浅两个主题都有取值', () => {
    const mark = ruleBody('.search-hit-mark')
    expect(mark).toContain('background: var(--search-hit-bg)')
    expect(mark).toContain('color: var(--search-hit-fg)')
    // 两个主题各定义一次：浅色是浅底深字，暗色反过来
    expect([...base.matchAll(/--search-hit-bg:/g)]).toHaveLength(2)
    expect([...base.matchAll(/--search-hit-fg:/g)]).toHaveLength(2)
    // 组件层不判主题：没有为这条高亮单开一个 dark 选择器
    expect(base).not.toMatch(/:root\[data-theme='dark'\][^{]*\.search-hit/)
  })
})

describe('行尾菜单：浮层档，层级走 token', () => {
  it('绝对定位浮在列表之上，阴影取浮层档', () => {
    const menu = ruleBody('.conversation-item-menu')
    expect(menu).toContain('position: absolute')
    // 行是 position: relative 的定位上下文，菜单才贴得住自己那一行
    expect(ruleBody('.conversation-item')).toContain('position: relative')
    expect(menu).toContain('box-shadow: var(--shadow-3)')
    expect(menu).toMatch(/background:\s*var\(--bg-elevated\)/)
    expect(menu).toContain('border-radius: var(--radius-md)')
    expect(menu).not.toMatch(/border: (?!none)/)
  })

  it('层级取 --z-popover，不写裸数字', () => {
    expect(ruleBody('.conversation-item-menu')).toContain('z-index: var(--z-popover)')
    expect(ruleBody('.conversation-item-menu')).not.toMatch(/z-index:\s*\d/)
    // --z-popover 必须压在 --z-modal 之下，否则菜单会浮到确认弹窗上面
    const popover = Number(/--z-popover:\s*(\d+)/.exec(base)?.[1] ?? '0')
    const modal = Number(/--z-modal:\s*(\d+)/.exec(base)?.[1] ?? '0')
    expect(popover).toBeLessThan(modal)
  })
})

describe('命中落点与键盘焦点', () => {
  it('定位到的那条消息有可见的琥珀标记，不是裸 class', () => {
    expect(ruleBody('.is-search-hit .bubble-bubble')).toContain('var(--amber-')
  })

  it('焦点环跟着真正能聚焦的元素走（行已经是 div，焦点在里面的按钮上）', () => {
    const focusRing = ruleBody('.conversation-item-main:focus-visible')
    expect(focusRing).toContain('outline: 2px solid var(--focus-outline)')
    expect(base).not.toContain('.conversation-item:focus-visible')
  })
})
