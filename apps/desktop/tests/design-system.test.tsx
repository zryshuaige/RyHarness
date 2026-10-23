// @vitest-environment jsdom
/**
 * 视觉设计系统的验收网：把几条约定钉成断言，防止回退。
 *
 *   1. 轻提示必须浮在弹窗遮罩之上（.toast-host > .modal-mask），否则弹窗里
 *      新建/删除 agent 的报错被整块吃掉，只剩一个不动的弹窗。
 *   2. token 是唯一真源：不允许 var(--x, fallback) 这类「就地兜底」把同一个值
 *      抄成第二份，也不允许引用一个根本没定义的 token。
 *   3. 一个组件的边缘只在 styles.css 里定义一次；产品层与扩展层不得各写一套。
 *   4. line-height 一律相对单位：写死 px 会在下级字号上把 CJK 字面压掉。
 *   5. 够不着的东西必须还在：窄窗口下气泡操作条、右栏展开键都不得被裁掉。
 *   6. 暗色用户不被按在浅色上：无存储时跟随系统，启动闪屏也跟主题走。
 *   7. 首屏栅格：消息列与输入卡同宽同缘，两侧 gutter 取同一个 token。
 *   8. 窗口化列表：行进场只在首帧播一次，滚回来的行不重播。
 *   9. Markdown 层级与表格：标题/清单/引用/分隔线/链接各有一档，表格自己横滚。
 *  10. 窄窗口：列表面板先让宽度，且保留一条收起的窄边（折叠键不被裁掉）。
 *
 * 另外两条资产/组件层的约定：品牌猫单源、橘猫是一等头像选项。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// 路径走 fs 而不是 URL：jsdom 环境会把全局 URL 换成 whatwg 实现，import.meta.url
// 在它那儿解析不出 file: 协议（"The URL must be of scheme file"）。
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { loadTheme } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation } from '../renderer/src/api.ts'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AVATAR_STYLE_BY_KEY,
  BRAND_AVATAR,
  parseAvatarSpec,
  randomAvatarSpec,
} from '../renderer/src/components/avatars/avatars.tsx'
import { Cat } from '../renderer/src/components/Cat.tsx'
import { ICONS } from '../renderer/src/components/Icon.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')
const HTML = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html')
const BRAND = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/brand')

type Rgba = [number, number, number, number]

/** '#rgb' / '#rrggbb' / 'rgb(r, g, b)' / 'rgba(r, g, b, a)' / 'transparent' → RGBA。 */
function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return [0, 0, 0, 0]
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1]
  if (hex !== undefined) {
    // 三位写法每半段复制一次；其余长度（含 8 位的 alpha）不是我们要的色
    const wide = hex.length <= 4 ? hex.replace(/./g, '$&$&') : hex
    if (wide.length !== 6) return null
    return [
      Number.parseInt(wide.slice(0, 2), 16),
      Number.parseInt(wide.slice(2, 4), 16),
      Number.parseInt(wide.slice(4, 6), 16),
      1,
    ]
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text)?.[1]
  if (fn === undefined) return null
  const parts = fn.split(/[,/\s]+/).filter((part) => {
    return part !== ''
  })
  if (parts.length < 3) return null
  return [
    Number.parseFloat(parts[0] as string),
    Number.parseFloat(parts[1] as string),
    Number.parseFloat(parts[2] as string),
    parts.length > 3 ? Number.parseFloat(parts[3] as string) : 1,
  ]
}

/** 半透明色压到不透明底上。 */
function flatten(color: Rgba, backdrop: number[]): [number, number, number] {
  const alpha = color[3]
  return [
    color[0] * alpha + backdrop[0] * (1 - alpha),
    color[1] * alpha + backdrop[1] * (1 - alpha),
    color[2] * alpha + backdrop[2] * (1 - alpha),
  ]
}

/** WCAG 2.x 对比度。任一端解析不出来就返回 0——宁可红，也不当它通过。 */
function contrastRatio(fg: Rgba | null, bg: Rgba | null): number {
  if (fg === null || bg === null) return 0
  const white: [number, number, number] = [255, 255, 255]
  const back = flatten(bg, white)
  const front = flatten(fg, back)
  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map((raw) => {
      const channel = raw / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
  }
  const [light, dark] = [luminance(front), luminance(back)].sort((a, b) => {
    return b - a
  })
  return (light as number) / ((dark as number) + 0.05)
}

/**
 * 把四张样式表按 main.tsx 的真实顺序注入 jsdom，var() 全部换成字面值。
 *
 * 为什么值得单起一套：全仓的视觉门禁此前全是 CSS 字符串匹配——看不见层叠（谁盖过谁），
 * 也看不见 token 是否真的解析得出颜色。这里用真的 CSSOM 走一遍级联，
 * 拿到的是「该元素此刻真正生效的声明」。
 *
 * jsdom 不做 var() 替换（getComputedStyle 会把 'var(--text-primary)' 原样吐回来，
 * 背景则直接退回初始值），所以先注入原样式、按当前 data-theme 让 jsdom 把 :root 上
 * 每个 token 解析成字面值，再把这些字面值填回 var() 重新注入一遍。两遍都是真的级联，
 * 变的只有 token 这一步由谁来解。
 */
function injectSheets(theme: 'light' | 'dark'): { style: HTMLStyleElement } {
  const css = STYLESHEETS.map((name) => {
    return readFileSync(resolve(SRC, name), 'utf8')
  }).join('\n')

  const probe = document.createElement('style')
  probe.textContent = css
  document.head.appendChild(probe)
  document.documentElement.dataset.theme = theme
  const rootStyle = window.getComputedStyle(document.documentElement)
  const tokens = new Map<string, string>()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    const value = rootStyle.getPropertyValue(m[1] as string).trim()
    if (value !== '') tokens.set(m[1] as string, value)
  }
  probe.remove()

  const element = document.createElement('style')
  element.textContent = css.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/g, (whole, name: string) => {
    // token 本身可能还指向另一个 token（--focus-outline: var(--amber-text)），顺着走完
    let value = tokens.get(name) ?? whole
    for (let depth = 0; depth < 5; depth++) {
      const next = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value.trim())?.[1]
      if (next === undefined || !tokens.has(next)) break
      value = tokens.get(next) as string
    }
    return value
  })
  document.head.appendChild(element)
  return { style: element }
}

/** 同 injectSheets，只是外层套一个「白底控件同名壳」的夹具，只问静态声明。 */
function liveStyles(theme: 'light' | 'dark'): {
  declared: (selector: string, prop: string) => string
  color: (selector: string, prop: string) => Rgba | null
  dispose: () => void
} {
  const { style: element } = injectSheets(theme)

  // 每个白底控件挂一个同名壳：只测样式表的层叠结果，不引入真实组件（那会把
  // 组件层的条件分支也搅进来，测到的就不是「这条 CSS 画出来什么样」）
  const fixture = document.createElement('div')
  for (const selector of WHITE_SURFACE_SELECTORS) {
    fixture.appendChild(document.createElement('div')).className = selector.slice(1)
  }
  document.body.appendChild(fixture)

  const styleOf = (selector: string): CSSStyleDeclaration => {
    const target = fixture.querySelector(selector)
    if (target === null) throw new Error(`jsdom 夹具里没有 ${selector}`)
    return window.getComputedStyle(target)
  }
  /**
   * 控件背后真的那层底色。透明的控件（首屏的起步胶囊）自己不画背景，它压的是页面底色
   * `--bg-app`——判对比度必须按那层算。
   *
   * 为什么不能沿用 contrastRatio 里"透明按白底合成"的旧默认：那只在浅色档成立。暗色档
   * 下把透明的浅色字合成到白底上，算出来是 1.15:1，一条其实完全可读的胶囊会被判成不达标。
   * 这不是放宽门禁，是把门禁问的那句"衬在什么上面"问对。
   */
  const backdrop = (): string => {
    return window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()
  }
  return {
    declared: (selector, prop) => {
      return styleOf(selector).getPropertyValue(prop).trim()
    },
    color: (selector, prop) => {
      const value = styleOf(selector).getPropertyValue(prop)
      return parseColor(value.trim() === 'transparent' || value.trim() === '' ? backdrop() : value)
    },
    dispose: () => {
      fixture.remove()
      element.remove()
      delete document.documentElement.dataset.theme
    },
  }
}

/** 聚焦之后真正生效的焦点声明。 */
interface FocusSignal {
  outline: string
  boxShadow: string
  /** 有没有可见的焦点信号：outline 与 box-shadow 任一不是「什么都没有」。 */
  visible: boolean
}

/**
 * 渲染级焦点探针：真样式表 + 真元素 + 真 focus()，读的是层叠之后的结果。
 *
 * 为什么字符串匹配测不出焦点环的回归：把兜底写成「:where(button, a[href], [tabindex])」
 * 在文件里依然漂漂亮亮，`grep ':where' styles.css` 照样通过——但键盘 Tab 到的每一个
 * 表单控件都不在兜底里，而且一次编译、一个用例都不会红。同理，`.field input[type="range"]`
 * 那句 `box-shadow: none` 与 `.field input:focus` 同为 0,2,1，靠后的它把焦点环整个吞掉，
 * 文件里两条规则都在、看着都没问题，级联之后滑杆聚焦时 outline 与 box-shadow 双双为空。
 * 这两件事只有真的走一遍级联才看得见。
 *
 * 一条必须知道的限制：jsdom 的 getComputedStyle 只按源码顺序解析级联，完全不看特异度
 * （实测 `.high:focus` 写在前面、`:where(...)` 写在后面，赢的是后面那个）。所以这里能
 * 钉住的是「聚焦后还剩什么」，钉不住「浏览器里两条规则谁赢」——后者只能用 specificity()
 * 算，别拿这里的断言冒充。
 */
function focusProbe(html: string): { focus: (selector: string) => FocusSignal; dispose: () => void } {
  const { style } = injectSheets('dark')
  const fixture = document.createElement('div')
  fixture.innerHTML = html
  document.body.appendChild(fixture)

  return {
    focus: (selector) => {
      const target = fixture.querySelector<HTMLElement>(selector)
      if (target === null) throw new Error(`jsdom 夹具里没有 ${selector}`)
      target.focus()
      const cs = window.getComputedStyle(target)
      const outline = cs.outline.trim()
      const boxShadow = cs.boxShadow.trim()
      const blank = (value: string): boolean => {
        return value === '' || value === 'none'
      }
      return { outline, boxShadow, visible: !blank(outline) || !blank(boxShadow) }
    },
    dispose: () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      fixture.remove()
      style.remove()
      delete document.documentElement.dataset.theme
    },
  }
}

/** 去注释后的样式源码：注释里提到的 token / 选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const STYLESHEETS = ['styles.css', 'styles-product.css', 'styles-provider.css', 'styles-memory.css'] as const

/**
 * 全局焦点环兜底那条选择器。写成一个常量是因为它的每个片段都被单独断言过：原生可聚焦
 * 控件在不在表里、tabindex="-1" 有没有被排除、排除是不是待在 :where() 内部——
 * 少任何一条都是一次静默的键盘可达性回归，而断言散落各处时很容易只改一半。
 */
const FOCUS_FALLBACK =
  ':where(button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])):focus-visible'

/**
 * 白底面的控件。纯白面压在白底上时暖棕阴影只有 1.2:1（离 WCAG 1.4.11 要求的 3:1 还差
 * 2.5 倍），所以它们的边缘只能由 --edge 描边给；这一组曾经整体退化成「只有阴影」，
 * 控件还在、轮廓没了，正是「UI 方方的、糊」的一半来源。
 *
 * 首屏的「待办行」不在这一组里：它已经不再是白面控件，而是一行压在页面底色上的平行
 * （描边与阴影都撤了）。它换来的新保证在下面那条 describe 里单独钉住——不是删掉了不管，
 * 是那个保证的前提已经不成立了。
 */
const WHITE_SURFACES: readonly (readonly [(typeof STYLESHEETS)[number], string])[] = [
  ['styles.css', '.bubble-bubble'],
  ['styles.css', '.btn'],
  ['styles.css', '.me-row'],
  ['styles.css', '.welcome-chip'],
  ['styles.css', '.chat-input-col'],
  ['styles-product.css', '.welcome-compose'],
]
const WHITE_SURFACE_SELECTORS = WHITE_SURFACES.map((entry) => {
  return entry[1]
})
const sheet = (name: (typeof STYLESHEETS)[number]): string => {
  return strip(readFileSync(resolve(SRC, name), 'utf8'))
}

/** :root / :root[data-theme=...] 块里声明的 token（含各主题覆盖）。 */
function themeTokens(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of css.matchAll(/(?:^|[{};])\s*:root[^{]*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.set(decl[1] as string, (decl[2] as string).trim())
    }
  }
  return out
}

/**
 * 按顶层逗号拆选择器组，并压掉多余空白，所以 `.a,\n.b { … }` 里问 `.b` 也问得到。
 * `:where(a, b)` / `:has(a, b)` 里的逗号不是分隔符——全局焦点环那条正是这个形状，
 * 按裸逗号拆会把它切成三个互相不存在的选择器。
 */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of prelude) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((sel) => {
    return sel.trim().replace(/\s+/g, ' ')
  })
}

/**
 * 顶层规则（不在 @media / @keyframes / @container 内）的「选择器组 → 声明块」。
 */
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
        out.push({ selectors: splitSelectors(prelude), body: css.slice(bodyStart, i) })
      }
      ruleStart = i + 1
    }
  }
  return out
}

/** 取某条顶层规则的声明块（找不到返回空串）。 */
function ruleBody(css: string, selector: string): string {
  for (const rule of topLevelRules(css)) {
    if (rule.selectors.includes(selector)) return rule.body
  }
  return ''
}

/**
 * 同一条选择器可能被「规则组」和「逐级覆盖」各写一次，层叠里生效的是靠后的那条。
 * 查具体档位（字号、上边距…）时必须用它，否则会读到规则组那条通用声明。
 */
function effectiveBody(css: string, selector: string): string {
  let found = ''
  for (const rule of topLevelRules(css)) {
    if (rule.selectors.includes(selector)) found = rule.body
  }
  return found
}

/** 某个选择器在所有规则组里的声明块拼起来（一个选择器可能被拆成几组分头写）。 */
function allBodies(css: string, selector: string): string {
  return topLevelRules(css)
    .filter((rule) => {
      return rule.selectors.includes(selector)
    })
    .map((rule) => {
      return rule.body
    })
    .join('\n')
}

/** 某个 at-rule（@media / @container）内部的整段文本（含嵌套规则）。 */
function blockAfter(css: string, marker: string): string {
  const start = css.indexOf(marker)
  if (start < 0) return ''
  const open = css.indexOf('{', start + marker.length)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

/** 把 `var(--x)` 链解成它最终指向的数值（只走本文件的 token 图，够用即可）。 */
function resolveValue(value: string, tokens: Map<string, string>): string {
  let current = value.trim()
  for (let depth = 0; depth < 5; depth++) {
    const name = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(current)?.[1]
    if (name === undefined) break
    const next = tokens.get(name)
    if (next === undefined) break
    current = next
  }
  return current
}

/** 某条规则里某个盒模型简写的四边 px 值（padding / margin 通用）。 */
function boxSides(
  body: string,
  prop: string,
  tokens: Map<string, string>,
): { top: number; right: number; bottom: number; left: number } {
  const raw = new RegExp(`${prop}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? ''
  const parts = raw.split(/\s+/).filter((part) => {
    return part !== ''
  })
  const top = parts[0] ?? '0'
  const right = parts[1] ?? top
  const bottom = parts[2] ?? top
  const left = parts[3] ?? right
  return {
    top: Number.parseFloat(resolveValue(top, tokens)),
    right: Number.parseFloat(resolveValue(right, tokens)),
    bottom: Number.parseFloat(resolveValue(bottom, tokens)),
    left: Number.parseFloat(resolveValue(left, tokens)),
  }
}

/** 选择器特异性：id ×1e4 + class/属性/伪类 ×1e2 + 元素。数够这几条规则用。 */
function specificity(selector: string): number {
  // :where() 里的部分按 0 计——这正是它存在的理由。不认它就会把全局焦点环
  // 算得比组件类还重，于是得出「组件盖不掉默认值」这个相反的结论。
  const flat = selector.replace(/:where\([^)]*\)/g, ' ')
  const ids = flat.match(/#[\w-]+/g)?.length ?? 0
  const classes = flat.match(/\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g)?.length ?? 0
  const types = flat.match(/(^|[\s>+~,])([a-zA-Z][\w-]*)/g)?.length ?? 0
  return ids * 10_000 + classes * 100 + types
}

/**
 * 文件顶层（不在 @media / @keyframes 内）的 class 选择器集合。
 * 两个文件同时给出同一个选择器，就是同一个组件被画了两遍边缘。
 */
function topLevelClassSelectors(css: string): Set<string> {
  const found = new Set<string>()
  for (const rule of topLevelRules(css)) {
    for (const sel of rule.selectors) {
      if (!/\.[a-zA-Z]/.test(sel)) continue
      found.add(sel)
    }
  }
  return found
}

describe('层级：轻提示必须高于弹窗遮罩', () => {
  const tokens = themeTokens(sheet('styles.css'))

  it('z 层级走 token，且 --z-toast > --z-modal', () => {
    const sticky = Number(tokens.get('--z-sticky'))
    const popover = Number(tokens.get('--z-popover'))
    const modal = Number(tokens.get('--z-modal'))
    const toast = Number(tokens.get('--z-toast'))
    expect([sticky, popover, modal, toast].every(Number.isFinite)).toBe(true)
    // 本轮修的那个 bug 的核心断言
    expect(toast).toBeGreaterThan(modal)
    // 层级顺序本身也得成立，否则遮罩会盖住 @ 提及菜单
    expect(popover).toBeLessThan(modal)
    expect(sticky).toBeLessThan(popover)
  })

  it('.toast-host 与 .modal-mask 都从 token 取值，不各自写死', () => {
    expect(ruleBody(sheet('styles-product.css'), '.toast-host')).toContain('z-index: var(--z-toast)')
    expect(ruleBody(sheet('styles.css'), '.modal-mask')).toContain('z-index: var(--z-modal)')
    // 宿主整块不吃点击：浮到弹窗之上后只有提示本体与关闭键可点
    expect(ruleBody(sheet('styles-product.css'), '.toast-host')).toContain('pointer-events: none')
    expect(ruleBody(sheet('styles-product.css'), '.toast')).toContain('pointer-events: auto')
    // 全站不再有裸 z-index 数字
    for (const name of STYLESHEETS) {
      expect(sheet(name).match(/z-index:\s*\d/), `${name} 仍有裸 z-index`).toBeNull()
    }
  })
})

describe('token 是唯一真源', () => {
  it('没有 var(--x, fallback) 形式的第二真源', () => {
    // --i 例外：它是组件通过 style={{ '--i': 序号 }} 就地传入的 stagger 序号，
    // 不是设计 token，兜底 0 是语义默认值而不是抄来的样式值。
    for (const name of STYLESHEETS) {
      const hits = sheet(name)
        .replace(/var\(\s*--i\s*,\s*0\s*\)/g, '')
        .match(/var\(\s*--[a-z0-9-]+\s*,/g)
      expect(hits, `${name} 仍有就地兜底: ${hits?.join(' ')}`).toBeNull()
    }
    // --accent 曾是 styles-product.css 里就地兜底出来的幽灵 token，已彻底退场
    expect(readFileSync(resolve(SRC, 'styles-product.css'), 'utf8')).not.toContain('--accent')
  })

  it('用到的 token 都在样式里定义过', () => {
    const defined = new Set<string>(['--i']) // 组件内联传入
    for (const name of STYLESHEETS) {
      for (const m of sheet(name).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1] as string)
    }
    for (const name of STYLESHEETS) {
      for (const m of sheet(name).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const token = m[1] as string
        expect(defined.has(token), `${name} 引用了未定义的 ${token}`).toBe(true)
      }
    }
  })

  it('line-height 不写死像素（px 会在下级字号上压掉 CJK 字面）', () => {
    for (const name of STYLESHEETS) {
      expect(sheet(name).match(/line-height:\s*[\d.]+px/), `${name} 仍有 px line-height`).toBeNull()
    }
  })
})

describe('一个组件的边缘只定义一次', () => {
  it('扩展层不重画 styles.css 的选择器', () => {
    const base = topLevelClassSelectors(sheet('styles.css'))
    for (const name of ['styles-product.css', 'styles-provider.css', 'styles-memory.css'] as const) {
      const overlap = [...topLevelClassSelectors(sheet(name))].filter((sel) => base.has(sel))
      expect(overlap, `${name} 与 styles.css 重复定义: ${overlap.join(' / ')}`).toEqual([])
    }
  })

  it('欢迎页与聊天页的 composer 是同一个长相（同一档阴影 + 同一根 --edge 描边）', () => {
    const inputCol = ruleBody(sheet('styles.css'), '.chat-input-col')
    const welcome = ruleBody(sheet('styles-product.css'), '.welcome-compose')
    expect(inputCol).toContain('box-shadow: var(--shadow-2)')
    expect(welcome).toContain('box-shadow: var(--shadow-2)')
    // 白卡压在白底上时阴影量不出边，所以「边缘归描边、抬升归阴影」两根都要在，
    // 且必须是同一根：少一根两处 composer 就会再次画成两种控件。
    expect(inputCol).toContain('border: 1px solid var(--edge)')
    expect(welcome).toContain('border: 1px solid var(--edge)')
  })

  /**
   * 首屏的"一屏一件事"是有形状的，形状就是这三条。此前它们只是评审意见：改布局的人
   * 看不到自己动了唯一那块抬升面，于是每轮都多长出一张卡。这里把它们变成会红的断言。
   *
   * 允许出现的抬升面只有两处：composer（全页的焦点）与品牌猫的画（它带的是 .cat 这个
   * 别的组件的形状，首屏只是给它一个位置）。其余任何 .welcome* 规则都不许有阴影——
   * 第二块抬升面就是「拼装感」的第一来源。
   */
  const welcomeElevated = (): string[] => {
    const allowed = new Set(['.welcome-compose', '.welcome-cat .cat'])
    /**
     * 「抬升」不等于「有 box-shadow」：`0 0 0 2px` 那种是描边环（叠头像之间互相切开、
     * 圆形头像收边），偏移与模糊都是 0，画出来的东西始终贴在原位。真正的抬升一定带
     * 非零的偏移或模糊。认不出数字的（var(--shadow-2) 这类）一律当抬升，宁可误报。
     */
    const lifts = (value: string): boolean => {
      return value.split(',').some((part) => {
        const parts = part.trim().split(/\s+/)
        if (parts.length < 3) return true
        const [x, y, blur] = parts as [string, string, string]
        return /[1-9]/.test(x) || /[1-9]/.test(y) || /[1-9]/.test(blur)
      })
    }
    const found: string[] = []
    for (const name of ['styles.css', 'styles-product.css'] as const) {
      for (const rule of topLevelRules(sheet(name))) {
        const shadow = /box-shadow:\s*([^;]+);/.exec(rule.body)?.[1]?.trim()
        if (shadow === undefined || shadow === 'none' || shadow === '') continue
        if (!lifts(shadow)) continue
        for (const selector of rule.selectors) {
          if (!selector.startsWith('.welcome') || allowed.has(selector)) continue
          if (selector.includes(':')) continue
          found.push(selector)
        }
      }
    }
    return found
  }

  it('首屏只有 composer 一块抬升面（品牌猫的画除外），第二块就是拼装感', () => {
    expect(welcomeElevated()).toEqual([])
  })

  it('首屏只用两档圆角：交互胶囊是 pill，dock 与待办行是 lg', () => {
    const seen = new Map<string, string>()
    for (const name of ['styles.css', 'styles-product.css'] as const) {
      for (const rule of topLevelRules(sheet(name))) {
        for (const selector of rule.selectors) {
          if (!selector.startsWith('.welcome')) continue
          // 品牌猫的底板沿用 .cat 这个别的组件的形状，不受这条门禁约束。
          if (selector.includes('.cat')) continue
          const radius = /border-radius:\s*([^;]+);/.exec(rule.body)?.[1]?.trim()
          if (radius !== undefined) seen.set(selector, radius)
        }
      }
    }
    const allowed = new Set(['var(--radius-pill)', 'var(--radius-lg)', '50%'])
    const offenders = [...seen].filter((entry) => {
      return !allowed.has(entry[1])
    })
    expect(offenders, `首屏出现了第三档圆角: ${offenders.map((e) => `${e[0]} → ${e[1]}`).join(' / ')}`).toEqual([])
    // 两档各自的归属也要钉住，否则"都用 pill"也算过：dock 必须是 lg，胶囊必须是 pill。
    // 胶囊的圆角落在 .welcome-chip 上（那是它唯一的定义处），.welcome-task 只覆盖布局。
    expect(seen.get('.welcome-compose')).toBe('var(--radius-lg)')
    expect(seen.get('.welcome-chip')).toBe('var(--radius-pill)')
  })

  it('待办行是平的：它复刻左栏的一行，就不能自己再长成一张卡', () => {
    const row = ruleBody(sheet('styles.css'), '.welcome-recent-item')
    // 这条取代它此前在 WHITE_SURFACES 里的位置：白面没了，"边缘归描边"的前提也不成立了，
    // 换成"它不许再有面"——描边与阴影都不得出现，可见性交给悬停底与焦点环。
    expect(row).not.toMatch(/box-shadow:\s*var\(--shadow-[12]\)/)
    expect(row).toMatch(/(?:^|;|\s)border:\s*none/)
    expect(row).toMatch(/background:\s*transparent/)
    // 悬停时仍然浮出一个圆角矩形：平着不等于摸不着。
    expect(ruleBody(sheet('styles.css'), '.welcome-recent-item:hover')).toContain('background: var(--hover-bg)')
  })

  it('.btn 是白底控件，靠那 1px --edge 站住（阴影在纯白底上等于没有）', () => {
    const btn = ruleBody(sheet('styles.css'), '.btn')
    expect(btn).toContain('border: 1px solid var(--edge)')
    expect(btn).toContain('box-shadow: var(--shadow-1)')
  })
})

describe('够不着的东西必须还在：窄窗口下操作条不被裁掉', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('操作条通道随消息列自适应，不再是写死的 118px', () => {
    const gutter = tokens.get('--action-gutter') ?? ''
    expect(gutter.startsWith('clamp(')).toBe(true)
    // 3 枚按钮 + 2 道间隙 + 8px 呼吸 = 通道下限；改了按钮尺寸却不同步改下限，
    // 通道就会短一截，按钮重新被裁——所以这条下限从按钮几何算出来。
    const barWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.bubble-action'))?.[1] ?? 0)
    const barGap = Number(/gap:\s*(\d+)px/.exec(ruleBody(base, '.bubble-actions'))?.[1] ?? 0)
    const [lo, middle, hi] = gutter
      .slice('clamp('.length, -1)
      .split(',')
      .map((part) => {
        return part.trim()
      })
    expect(Number.parseFloat(lo ?? '')).toBe(barWidth * 3 + barGap * 2 + 8)
    // 自变量必须是消息列宽（cqw）：同一窗口下收起右栏与否，列宽能差一倍
    expect(middle).toContain('cqw')
    // 上限仍是当初那条 118px 的通道
    expect(Number.parseFloat(hi ?? '')).toBe(118)
  })

  it('窄列断点就是外置通道排不下的那一条（几何自洽，不是拍脑袋的数）', () => {
    const breakpoint = Number(/@container \(max-width: (\d+)px\)/.exec(base)?.[1])
    expect(Number.isFinite(breakpoint)).toBe(true)
    // 气泡最宽 75% 列宽；agent 行左侧还占 40px 头像 + 8px 间隙 ⇒ 右侧只剩
    // 25%W - 48px，加 8px 呼吸；通道要 100px：100 ≤ 25%W - 40 ⟺ W ≥ 560px。
    expect(breakpoint).toBe((100 + 40) * 4)
  })

  it('窄列里操作条贴气泡下沿内侧并常显（窄栏没有 hover 的余裕）', () => {
    const narrow = blockAfter(base, '@container')
    expect(narrow).toContain('.chat-col .from-agent .bubble-actions')
    expect(narrow).toContain('.chat-col .from-user .bubble-actions')
    expect(narrow).toContain('opacity: 1')
    expect(narrow).toContain('pointer-events: auto')
    // 挂在气泡下沿而不是压在气泡上：正文一个字都不能被盖住
    expect(narrow).toMatch(/top:\s*calc\(100%/)
    // 基线仍是 hover 才显，窄列是唯一一条常显的例外
    expect(ruleBody(base, '.bubble-actions')).toContain('opacity: 0')
  })

  it('.chat-scroll 横向溢出被吃掉，.chat-col 有 min-width 保护', () => {
    const scroll = ruleBody(base, '.chat-scroll')
    expect(scroll).toContain('overflow-x: hidden')
    expect(scroll).not.toContain('overflow-x: clip')
    const col = ruleBody(base, '.chat-col')
    expect(col).toContain('min-width: 0')
    // 通道的 cqw 锚在这里：没有容器，clamp 的自变量无处可解
    expect(col).toContain('container-type: inline-size')
  })
})

describe('右栏：收起之后还展得开', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('收起态留一条够放展开键的窄边，不是 0 宽', () => {
    const collapsed = ruleBody(base, '.right-panel.is-collapsed')
    expect(collapsed).toContain('width: var(--panel-collapsed-w)')
    expect(collapsed).not.toContain('width: 0')
    // 本面板 overflow: hidden：窄边小于展开键宽度，键会被裁掉，右栏就此锁死
    expect(ruleBody(base, '.right-panel')).toContain('overflow: hidden')
    const edge = Number.parseFloat(tokens.get('--panel-collapsed-w') ?? '')
    const btnWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.panel-expand-btn'))?.[1] ?? 0)
    const btnOffset = Number.parseFloat(
      /left:\s*(\d+)px/.exec(ruleBody(base, '.right-panel.is-collapsed .panel-expand-btn'))?.[1] ?? '0',
    )
    expect(edge).toBeGreaterThanOrEqual(btnWidth + btnOffset)
  })

  it('收起时内容退场走 visibility，跟得上 width 过渡', () => {
    expect(ruleBody(base, '.right-panel.is-collapsed .panel-body')).toContain('visibility: hidden')
    expect(ruleBody(base, '.right-panel.is-collapsed .panel-banner')).toContain('visibility: hidden')
    // 延时与宽度过渡等长：内容是滑出去的，不是动画一开始就凭空消失
    expect(ruleBody(base, '.panel-body')).toContain('transition: visibility 0s linear')
    expect(ruleBody(base, '.panel-banner')).toContain('transition: visibility 0s linear')
  })

  it('collapsed 时展开键在，面板本体也还在（否则宽度过渡两向都是硬切）', async () => {
    const agent: AgentDef = {
      id: 'ryen',
      name: 'Ryen',
      systemPrompt: '你是 Ryen。',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
      tools: [],
      isBuiltin: true,
    }
    const conversation: Conversation = {
      id: 'c1',
      kind: 'direct',
      title: '与 Ryen',
      memberAgentIds: ['ryen'],
      lastReadSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <RightPanel
          api={
            {
              conversationDetail: () => {
                return Promise.resolve({
                  conversation,
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 },
                })
              },
            } as unknown as ApiClient
          }
          store={new ChatStore()}
          conversation={conversation}
          agents={[agent]}
          conversations={[conversation]}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
          collapsed={true}
          onToggle={() => {}}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.right-panel')?.className).toBe('right-panel is-collapsed')
    expect(container.querySelector('.panel-expand-btn')).not.toBeNull()
    // 早返回会把 .panel-body 一起带走：收起就成了硬切，展开时内容整块重画
    expect(container.querySelector('.panel-body')).not.toBeNull()
    expect(container.textContent).toContain('Ryen')
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

describe('暗色用户不被按在浅色上', () => {
  const html = readFileSync(HTML, 'utf8')
  const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8')
  /** index.html 里的内联 splash 样式（整份 HTML 当 CSS 解析会被 <script> 里的括号带偏）。 */
  const splashCss = strip(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '')
  /**
   * 主题引导脚本：不再是 index.html 里的内联脚本，而是 public/theme-boot.js
   * （CSP 的 script-src 收回了 'unsafe-inline'，内联脚本过不了）。口径不变：
   * 存储键与 App 一致，并且在 React 挂载之前就把 data-theme 定好。
   */
  const themeBoot = readFileSync(resolve(SRC, '../public/theme-boot.js'), 'utf8')

  /** 假系统偏好：vitest 的 jsdom 环境不装 window.matchMedia。 */
  function stubPrefersDark(dark: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => {
      return { matches: query.includes('dark') && dark } as unknown as MediaQueryList
    })
  }

  it('没有存储时跟随系统深浅色（此前一律硬回浅色）', () => {
    localStorage.removeItem('ryharness-theme')
    try {
      stubPrefersDark(true)
      expect(loadTheme()).toBe('dark')
      stubPrefersDark(false)
      expect(loadTheme()).toBe('light')
    } finally {
      vi.unstubAllGlobals()
      localStorage.removeItem('ryharness-theme')
    }
  })

  it('用户自己选过就听用户的，系统偏好不再插手', () => {
    localStorage.setItem('ryharness-theme', 'light')
    try {
      stubPrefersDark(true)
      expect(loadTheme()).toBe('light')
    } finally {
      vi.unstubAllGlobals()
      localStorage.removeItem('ryharness-theme')
    }
  })

  it('index.html：splash 跟系统深色，不再闪一片奶油色', () => {
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/)
    // 底色改由局部 token 给出：写死 #FAF7F2 的正是深色用户看到的那一下闪屏
    expect(ruleBody(splashCss, '#splash')).toContain('background: var(--splash-bg)')
    expect(html).not.toMatch(/#splash \{[^}]*background: #FAF7F2/)
  })

  it('index.html：挂载前那段引导脚本就把 data-theme 定好，且与 App 同一口径', () => {
    // 主题键在两处（外部引导脚本与 App）必须是同一个。取键的方式有两种：直接读
    // localStorage，或走 lib/storage 的旧键回落层——两种都认。
    const keyOf = (source: string): string | undefined => {
      return /localStorage\.getItem\('([^']+)'\)/.exec(source)?.[1] ?? /readSetting\('([^']+)'\)/.exec(source)?.[1]
    }
    const keyInBoot = keyOf(themeBoot)
    const keyInApp = keyOf(app)
    expect(keyInBoot).toBe(keyInApp)
    expect(keyInBoot).toBe('ryharness-theme')
    expect(themeBoot).toContain('document.documentElement.dataset.theme')
    expect(themeBoot).toContain('(prefers-color-scheme: dark)')
    // 脚本本身在外部文件里，index.html 里的 <script src> 必须排在 </head> 之前，
    // 也排在 React 挂载脚本之前（经典脚本、同步执行，才赶得上第一帧）。
    const tag = /<script src="[^"]*theme-boot\.js"[^>]*>/.exec(html)?.[0] ?? ''
    expect(tag, 'index.html 里没有引用 theme-boot.js').not.toBe('')
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('暗色下品牌方块仍然看得见（moonshot / ollama 的品牌色几乎就是背景色）', () => {
    const provider = sheet('styles-provider.css')
    // 常驻描边：品牌色再深也还有一圈边
    expect(ruleBody(provider, '.provider-logo')).toContain('0 0 0 1px var(--edge-strong)')
    const lifted = topLevelRules(provider).find((rule) => {
      return rule.selectors.includes(":root[data-theme='dark'] .provider-logo svg")
    })
    expect(lifted?.body).toMatch(/filter:\s*brightness\(/)
  })
})

describe('禁用态会说话', () => {
  const base = sheet('styles.css')

  it('输入框禁用态不是静默吞键：禁用即降亮度与 not-allowed', () => {
    const disabled = ruleBody(base, '.chat-input-box textarea:disabled')
    expect(disabled).toContain('cursor: not-allowed')
    expect(disabled).toContain('color: var(--text-disabled)')
    const wrapper = ruleBody(base, '.chat-input-box:has(textarea:disabled)')
    expect(wrapper).toMatch(/opacity:\s*\./)
    expect(wrapper).toContain('cursor: not-allowed')
  })

  it('载入更早的按钮禁用时退到背景里（文案已经变成「载入中…」）', () => {
    expect(ruleBody(base, '.load-earlier:disabled')).toMatch(/opacity:\s*\./)
    expect(ruleBody(base, '.load-earlier:disabled')).toContain('cursor: default')
  })
})

describe('品牌猫单源', () => {
  it('手写的第二只猫已经退场', () => {
    expect(existsSync(resolve(SRC, 'components/AppIcon.tsx'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat-face.svg'))).toBe(false)
    // Lucide 注册表里也不再登记 cat-face / cat：那是几何完全不同的另外两只猫
    const registered: readonly string[] = Object.keys(ICONS)
    expect(registered).not.toContain('cat-face')
    expect(registered).not.toContain('cat')
  })

  it('母版是 assets/brand/mark.png 位图，品牌目录里没有第二份造型', () => {
    // 母版改成位图之后，「三只几何 SVG + 三份派生图标」这套结构整个退场了。品牌目录里
    // 只剩母版与它的分级契约；任何新出现的 svg/png 都是有人又画了一只猫。
    expect(readdirSync(BRAND).sort()).toEqual(['mark.png', 'tiers.json'])
    const master = readFileSync(resolve(BRAND, 'mark.png'))
    // PNG 头：签名 + IHDR。边长与 alpha 是「这份母版是制备好的那一版」的结构不变量
    // （gen-icon.mjs 也校验同一组，换了母版当场失败而不是产出一批带白角的图标）。
    expect(master.subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(master.subarray(12, 16).toString('latin1')).toBe('IHDR')
    const tiers = JSON.parse(readFileSync(resolve(BRAND, 'tiers.json'), 'utf8')) as { masterSize: number }
    expect(master.readUInt32BE(16), '母版宽').toBe(tiers.masterSize)
    expect(master.readUInt32BE(20), '母版高').toBe(tiers.masterSize)
    // 透明像素：母版是调色板量化 + tRNS（RGBA 直存也行），两种编码都带这条块。
    // 少了它，四角就会在深色任务栏上留下一圈白角。
    expect(master.includes(Buffer.from('tRNS')), '母版必须带 alpha（四角抠成透明）').toBe(true)
  })

  it('徽标只由 <Cat> 渲染，且不再有随主题翻色的墨色钩子', () => {
    // 位图母版的颜色是烤进像素里的：此前那套「墨色走 --cat-ink、脸底色按主题翻深」的
    // 机制连同一个可翻的图元都没有了。.cat 规则现在只有盒模型两条（assets/brand/cat.css）。
    const catCss = strip(readFileSync(resolve(SRC, 'assets/brand/cat.css'), 'utf8'))
    expect(catCss).not.toMatch(/--cat-(ink|ear|face)/)
    expect(catCss, '头像位的满幅圆').toMatch(/\.cat-circle\s*\{[^}]*border-radius:\s*50%/)
    const markup = renderToStaticMarkup(<Cat size={40} />)
    expect(markup).toContain('<img')
    expect(markup).toContain('class="cat"')
    expect(markup, '位图徽标不是内联 SVG').not.toContain('<svg')
  })
})

describe('橘猫是一等头像选项', () => {
  it("品牌键是常量 'cat'，由 Avatar 的品牌分支接手而非 DiceBear 白名单", () => {
    expect(BRAND_AVATAR).toBe('cat')
    expect(AVATAR_STYLE_BY_KEY.cat).toBeUndefined()
    expect(parseAvatarSpec(BRAND_AVATAR)).toBeNull()
  })

  it('「换一批」随时能产出品牌橘猫（品牌必须可达，不能只在数据库里）', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      expect(randomAvatarSpec()).toBe('cat')
    } finally {
      random.mockRestore()
    }
  })

  it("avatarKey='cat' 渲染真正的猫，既不是首字母色块也不是骨架", () => {
    const html = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={40} />)
    expect(html).toContain('avatar-cat')
    expect(html).toContain('<img class="cat cat-circle"')
    // 与应用图标同源：渲染层吃的那张图就是 gen:icon 导出的 256 档
    expect(html).toContain('src="/app/cat.png"')
    expect(html).not.toContain('avatar-fallback')
    expect(html).not.toContain('avatar-loading')
  })
})

describe('首屏栅格：消息列与输入卡同宽同缘', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('两侧 gutter 全取同一个 token（此前消息列 32px、输入卡 20px，差出 12px）', () => {
    const gutter = Number.parseFloat(resolveValue('var(--gutter-x)', tokens))
    expect(gutter).toBe(32)
    // 消息列、输入卡、聊天顶栏、断线提示条：四处的左右留白必须是这一个值
    expect(boxSides(ruleBody(base, '.chat-scroll'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.chat-input-wrap'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.chat-header'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.conn-banner'), 'margin', tokens).left).toBe(gutter)
  })

  it('每一处自身左右对称，且没有任何一处再写裸 gutter 值', () => {
    for (const [selector, prop] of [
      ['.chat-scroll', 'padding'],
      ['.chat-input-wrap', 'padding'],
      ['.chat-header', 'padding'],
      ['.conn-banner', 'margin'],
    ] as const) {
      const sides = boxSides(ruleBody(base, selector), prop, tokens)
      expect(sides.left, `${selector} 左右不对称`).toBe(sides.right)
      expect(ruleBody(base, selector), `${selector} 仍在写裸 gutter`).toContain('var(--gutter-x)')
    }
  })

  it('两列宽度上限与居中方式同源，窄窗下也不会差出 24px', () => {
    const col = ruleBody(base, '.chat-col')
    const input = ruleBody(base, '.chat-input-col')
    for (const body of [col, input]) {
      expect(body).toContain('max-width: var(--chat-col)')
      expect(body).toContain('margin: 0 auto')
    }
    // 几何自证：从两个外壳各自的内边距算出两列的宽与左缘，逐个聊天区宽度比对。
    // 未触到 --chat-col 时左缘就等于各自的外壳内边距（32 vs 20 立刻分叉 12px，
    // 宽度差则是两侧各 12px 合计 24px）；触到上限后两边都贴到同一上限，居中后重合。
    const cap = Number.parseFloat(resolveValue('var(--chat-col)', tokens))
    const geometry = (wrapper: string, prop: string) => {
      const gutter = boxSides(ruleBody(base, wrapper), prop, tokens).left
      return (areaWidth: number): { width: number; left: number } => {
        const available = areaWidth - gutter * 2
        const width = Math.min(available, cap)
        return { width, left: gutter + (available - width) / 2 }
      }
    }
    const messageCol = geometry('.chat-scroll', 'padding')
    const composer = geometry('.chat-input-wrap', 'padding')
    for (const areaWidth of [372, 408, 560, 900, 1600]) {
      expect(messageCol(areaWidth), `聊天区 ${areaWidth}px 下两列不同宽`).toEqual(composer(areaWidth))
    }
  })
})

describe('窗口化列表：行进场只在首帧播一次', () => {
  const base = sheet('styles.css')

  it('基线仍给整列错落进场（--i 照旧封顶 8 档）', () => {
    const item = ruleBody(base, '.conversation-item')
    expect(item).toContain('animation: item-in')
    expect(item).toContain('calc(min(var(--i, 0), 8) * 30ms)')
  })

  it('data-windowed="true" 的列表把默认动画关掉，只留 .is-animated 的首帧行', () => {
    const off = `.conversation-list[data-windowed='true'] .conversation-item`
    const on = `${off}.is-animated`
    expect(ruleBody(base, off)).toMatch(/animation:\s*none/)
    expect(ruleBody(base, on)).toContain('animation: item-in')
    expect(ruleBody(base, on)).toContain('calc(min(var(--i, 0), 8) * 30ms)')
  })

  it('恢复动画那条必然赢过关掉它那条，不靠源码顺序', () => {
    const off = `.conversation-list[data-windowed='true'] .conversation-item`
    const on = `${off}.is-animated`
    expect(specificity(on)).toBeGreaterThan(specificity(off))
    expect(specificity(off)).toBeGreaterThan(specificity('.conversation-item'))
  })
})

describe('Markdown 层级与表格', () => {
  const base = sheet('styles.css')

  it('标题层级：越浅越大、离上一段越远（五级往下改用次级色分层）', () => {
    const tokens = themeTokens(base)
    const read = (depth: string, prop: string): number => {
      return Number.parseFloat(
        resolveValue(
          new RegExp(`${prop}:\\s*([^;]+);`).exec(effectiveBody(base, `.bubble-md ${depth}`))?.[1] ?? '0',
          tokens,
        ),
      )
    }
    const fontSizes = ['h1', 'h2', 'h3', 'h4', 'h5'].map((depth) => {
      return read(depth, 'font-size')
    })
    const margins = ['h1', 'h2', 'h3', 'h4', 'h5'].map((depth) => {
      return read(depth, 'margin-top')
    })
    // 一到四级：字号与上边距逐级收。两档撞成同一号，层级就白设了
    for (let i = 1; i < 4; i++) {
      expect(fontSizes[i], `h${i + 1} 没比 h${i} 小`).toBeLessThan(fontSizes[i - 1] as number)
      expect(margins[i], `h${i + 1} 没比 h${i} 收`).toBeLessThanOrEqual(margins[i - 1] as number)
    }
    // 五级往下不再靠字号分层：再降就掉到 --fs-xs 的 CJK 可读下限以下，
    // 改用次级色当「这是小节标签」的唯一信号。
    expect(fontSizes[4]).toBe(fontSizes[3])
    expect(effectiveBody(base, '.bubble-md h5')).toContain('color: var(--text-secondary)')
    expect(effectiveBody(base, '.bubble-md h6')).toContain('color: var(--text-secondary)')
    // 首块不留上边距：标题再浅也不该把气泡顶出一个台阶
    expect(specificity('.bubble-md > :first-child')).toBeGreaterThan(specificity('.bubble-md h1'))
  })

  it('清单逐级缩进，标记压次级色', () => {
    const tokens = themeTokens(base)
    const indent = (selector: string): number => {
      return Number.parseFloat(
        resolveValue(/padding-left:\s*([^;]+);/.exec(effectiveBody(base, selector))?.[1] ?? '0', tokens),
      )
    }
    expect(indent('.bubble-md ul')).toBe(24)
    expect(indent('.bubble-md ol')).toBe(24)
    // 嵌套一档收 8px：浏览器默认一缩就是 40px，在气泡里直接顶到正文上沿
    expect(indent('.bubble-md li ul')).toBe(20)
    expect(indent('.bubble-md li ol')).toBe(20)
    expect(ruleBody(base, '.bubble-md li::marker')).toContain('color: var(--text-tertiary)')
  })

  it('表格自己横向滚：宽表不撑破气泡（外壳是 overflow-x: hidden）', () => {
    const table = ruleBody(base, '.bubble-md table')
    // <table> 自身当滚动容器：没有包装节点可依赖
    expect(table).toContain('display: block')
    expect(table).toContain('overflow-x: auto')
    expect(table).toContain('max-width: 100%')
    expect(ruleBody(base, '.chat-scroll')).toContain('overflow-x: hidden')
  })

  it('表格边框、表头底色、单元格留白各有一档，且都走 token', () => {
    const cell = ruleBody(base, '.bubble-md td')
    expect(cell).toContain('border: 1px solid var(--edge)')
    expect(cell).toContain('text-align: left')
    expect(ruleBody(base, '.bubble-md th')).toContain('border: 1px solid var(--edge)')
    expect(effectiveBody(base, '.bubble-md th')).toContain('background: var(--bg-subtle)')
  })

  it('引用块 / 分隔线 / 链接 / 行内代码都有配套，且无裸色值', () => {
    expect(ruleBody(base, '.bubble-md blockquote')).toContain('border-left: 3px solid var(--amber-text)')
    expect(ruleBody(base, '.bubble-md hr')).toContain('border-top: 1px solid var(--divider)')
    expect(ruleBody(base, '.bubble-md a:hover')).toContain('color: var(--amber-primary-hover)')
    expect(ruleBody(base, '.bubble-md a:focus-visible')).toContain('outline: 2px solid var(--focus-outline)')
    // 行内代码不能顺手把围栏代码也画上底色（围栏那块由 styles-content.css 复位）
    expect(ruleBody(base, '.bubble-md code:not(.md-code *)')).toContain('background: var(--bg-subtle)')
    // 含 .bubble-md 就算，不只是「以 .bubble-md 开头」：翻面规则写成
    // .bubble-row.from-user .bubble-bubble .bubble-md …，前缀匹配全部漏掉，
    // 三处裸 rgba 就这么一路逃过检查。漏进来的正是本该被 token 化的那一档。
    const markdown = topLevelRules(base).filter((rule) => {
      return rule.selectors.some((sel) => {
        return sel.includes('.bubble-md')
      })
    })
    for (const rule of markdown) {
      expect(rule.body.match(/#[0-9A-Fa-f]{3,8}|\brgba?\(/g), `${rule.selectors.join(' ')} 有裸色值`).toBeNull()
    }
  })

  it('自己的琥珀气泡里，引用块与表格的底色/描边跟着翻过来', () => {
    expect(base).toContain('.bubble-row.from-user .bubble-bubble .bubble-md blockquote')
    expect(base).toContain('.bubble-row.from-user .bubble-bubble .bubble-md th')
    // 翻面规则只改底色与描边，不碰字号/间距（否则两条气泡的排版会分叉）
    const flipped = topLevelRules(base).filter((rule) => {
      return rule.selectors.some((sel) => {
        return sel.startsWith('.bubble-row.from-user .bubble-bubble .bubble-md')
      })
    })
    expect(flipped.length).toBeGreaterThan(0)
    for (const rule of flipped) {
      expect(rule.body, rule.selectors.join(' ')).not.toMatch(/font-size|margin-top|padding:/)
    }
    // 翻面用的两档色必须与 .tool-row / .file-card 共用同一个 token，否则同一个值
    // 在三个地方各抄一份，主题一翻就分叉（th 分两组写：底色一组、描边一组）
    const flipTh = allBodies(base, '.bubble-row.from-user .bubble-bubble .bubble-md th')
    expect(flipTh).toContain('var(--on-amber-quiet)')
    expect(flipTh).toContain('var(--on-amber-edge)')
    expect(allBodies(base, '.bubble-row.from-user .bubble-bubble .tool-row')).toContain('var(--on-amber-quiet)')
    expect(allBodies(base, '.bubble-row.from-user .bubble-bubble .file-card')).toContain('var(--on-amber-quiet)')
  })
})

describe('窄窗口：列表面板先让宽度', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('1200px 以下列表让到 280px，1040px 以下让到 200px（1024 窗口的聊天区不再只剩 372px）', () => {
    expect(ruleBody(base, '.list-panel')).toContain('width: var(--list-panel-w)')
    const md = blockAfter(base, '@media (max-width: 1199px)')
    const sm = blockAfter(base, '@media (max-width: 1040px)')
    expect(md).toContain('.list-panel')
    expect(sm).toContain('.list-panel')
    const mdWidth = Number.parseFloat(resolveValue(/width:\s*([^;]+);/.exec(md)?.[1] ?? '0', tokens))
    const smWidth = Number.parseFloat(resolveValue(/width:\s*([^;]+);/.exec(sm)?.[1] ?? '0', tokens))
    const full = Number.parseFloat(resolveValue('var(--list-panel-w)', tokens))
    expect([full, mdWidth, smWidth]).toEqual([300, 280, 200])
    // 1199 档让到 280 而不是 240：右栏在这一档已经是**不占位**的覆盖式抽屉，
    // 没有一列 280px 要躲——再让 60px 只是把会话名挤成四个字（实测列表栏 240px
    // 时标题实得 64px ≈ 4 个汉字，「产品三人组」显示成「产品三…」），聊天区
    // 一点没多。
    expect(mdWidth).toBeGreaterThanOrEqual(280)
    // 1024px 窗口：72(rail) + 200(列表) + 280(右栏) 之外，聊天区还剩 472px
    const rail = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.rail'))?.[1] ?? 0)
    const right = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.right-panel'))?.[1] ?? 0)
    expect(1024 - rail - smWidth - right).toBeGreaterThan(372)
  })

  it('收起态留一条够放折叠键的窄边，不是 0 宽（宽度归零就再也展不开）', () => {
    const collapsed = ruleBody(base, '.list-panel.is-collapsed')
    expect(collapsed).toContain('width: var(--panel-collapsed-w)')
    expect(collapsed).not.toContain('width: 0')
    expect(collapsed).toContain('overflow: hidden')
    const edge = Number.parseFloat(tokens.get('--panel-collapsed-w') ?? '')
    const btnWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.list-panel-toggle'))?.[1] ?? 0)
    const btnOffset = Number.parseFloat(
      /left:\s*(\d+)px/.exec(ruleBody(base, '.list-panel.is-collapsed .list-panel-toggle'))?.[1] ?? '0',
    )
    expect(edge).toBeGreaterThanOrEqual(btnWidth + btnOffset)
    // 内容退场走 visibility，延时跟得上 width 过渡（与右栏同一套降级对）
    expect(ruleBody(base, '.list-panel.is-collapsed .list-panel-header')).toContain('visibility: hidden')
    expect(ruleBody(base, '.list-panel')).toContain('transition: width')
  })

  it('折叠键让开搜索框，且只在真的挂了键时才让', () => {
    expect(ruleBody(base, '.list-panel:has(.list-panel-toggle) .search-box')).toContain('padding-right: 40px')
    expect(specificity('.list-panel:has(.list-panel-toggle) .search-box')).toBeGreaterThan(
      specificity('.search-box.has-icon'),
    )
  })
})

/**
 * 白底控件的边缘：这一组曾经整体退化成「只有阴影」，而暖棕模糊在纯白上只有 1.2:1，
 * 离 WCAG 1.4.11 的 3:1 差着两个数量级——控件还在，轮廓没了，用户看到的就是「糊」。
 * 这一段刻意不只做字符串匹配：注入真 CSSOM 走一遍级叠，再沿 token 链解析，
 * 字符串匹配看不见「谁盖过谁」也看不见「这个 token 到底解不解得出颜色」。
 */
describe('白底控件靠描边站住（阴影只管抬升）', () => {
  it('阴影不再兼任边缘信号：--shadow-1 只表达抬升，边缘一律归 --edge', () => {
    const base = sheet('styles.css')
    // 只看浅色档：themeTokens 是按出现顺序覆盖的，暗色块在后面，取到的是暗色那份
    const light = /--shadow-1:\s*([^;]+);/.exec(blockAfter(base, ":root[data-theme='light']"))?.[1] ?? ''
    expect(light, '浅色档 --shadow-1 不见了').not.toBe('')
    // --shadow-1 的棕 alpha 只表达「抬起来一点」：再高就会在白底上糊成一片脏边，
    // 而它无论多高也到不了 3:1——边缘这件事必须交给描边。
    for (const alpha of [...light.matchAll(/rgba\([^)]*?,\s*\.(\d+)\)/g)]) {
      const value = Number.parseFloat(`.${alpha[1] as string}`)
      expect(value, `--shadow-1 的 alpha ${alpha[0]} 偏高`).toBeLessThanOrEqual(0.1)
    }
    // 暗色档自带内描边（那才是暗色的边缘信号），浅色档不该有——否则白底上又是双份边
    expect(light).not.toContain('inset')
    // 白底控件的边缘必须真的是 --edge，而不是某个更淡的裸色
    for (const [file, selector] of WHITE_SURFACES) {
      const body = ruleBody(sheet(file), selector)
      expect(body, `${selector} 少了边缘`).toMatch(/border:\s*1px solid var\(--edge\)/)
      expect(body, `${selector} 仍在写裸边框宽度`).not.toMatch(/border:\s*2px/)
    }
  })

  it('.btn-mini 撤掉的是抬升档，不是边缘（它与 .btn 同元素，边缘随 .btn 走）', () => {
    const mini = ruleBody(sheet('styles-product.css'), '.btn-mini')
    expect(mini).toContain('box-shadow: none')
    // 若 .btn 的边缘改成 inset ring，这行 box-shadow: none 会把它一并抹掉——
    // 所以这里钉住的是「边缘不靠 box-shadow」
    expect(ruleBody(sheet('styles.css'), '.btn')).toContain('border: 1px solid var(--edge)')
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme} 主题下注入 jsdom：每个白底控件仍有一根可见边缘`, () => {
      const live = liveStyles(theme)
      try {
        for (const [, selector] of WHITE_SURFACES) {
          const border = live.declared(selector, 'border')
          expect(border, `${selector} 层叠之后没有 border 声明`).not.toBe('')
          expect(Number.parseFloat(border), `${selector} 的描边宽度 ${border}`).toBeGreaterThanOrEqual(1)
          // 描边色要能解出真色，否则这根线画出来是透明的
          const color = parseColor(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/.exec(border)?.[1] ?? '')
          expect(color, `${selector} 的描边色 ${border} 解析不出`).not.toBeNull()
          expect(color?.[3], `${selector} 的描边全透明`).toBeGreaterThan(0)
        }
      } finally {
        live.dispose()
      }
    })

    it(`${theme} 主题下 .btn / .welcome-chip 的前景与背景对比度 ≥ 3:1`, () => {
      const live = liveStyles(theme)
      try {
        for (const selector of ['.btn', '.welcome-chip']) {
          const fg = live.color(selector, 'color')
          const bg = live.color(selector, 'background')
          expect(fg, `${selector} 前景 ${live.declared(selector, 'color')} 解析不出`).not.toBeNull()
          expect(bg, `${selector} 背景 ${live.declared(selector, 'background')} 解析不出`).not.toBeNull()
          // 3:1 是 WCAG 1.4.3 对大字的下限，也是这条门禁的底线；这两处实际在 11:1 以上，
          // 留余量是为了不让 token 微调就把门禁推红
          expect(contrastRatio(fg, bg), `${selector} 前景/背景对比度不足`).toBeGreaterThanOrEqual(3)
        }
      } finally {
        live.dispose()
      }
    })
  }

  it('焦点环是全局默认：新增任何可聚焦控件都不会静默失去它', () => {
    const base = sheet('styles.css')
    const global = ruleBody(base, FOCUS_FALLBACK)
    expect(global).toContain('outline: 2px solid var(--focus-outline)')
    expect(global).toContain('outline-offset: 2px')
    // :where() 把整张表（含 tabindex="-1" 的排除）降成 0 特异度：组件类盖不掉这条默认值，
    // 自带焦点环的控件（.search-box / .toast-action）也仍然是「只有一圈」
    expect(specificity(FOCUS_FALLBACK)).toBe(100)
    // 兜底表里必须列全原生可聚焦控件。只列 button/a/[tabindex] 时，键盘 Tab 到的
    // 表单控件落在兜底之外，而且一次编译、一个用例都不会红
    expect(FOCUS_FALLBACK).toMatch(/\binput\b/)
    expect(FOCUS_FALLBACK).toMatch(/\bselect\b/)
    expect(FOCUS_FALLBACK).toMatch(/\btextarea\b/)
    // tabindex="-1" 是刻意留给脚本聚焦的（弹窗容器、role=alert 段落），键盘走不到它；
    // 真给它画环，整只弹窗会镶一圈琥珀
    expect(FOCUS_FALLBACK).toMatch(/\[tabindex\]:not\(\[tabindex="-1"\]\)/)
    // 白名单缩到只剩「焦点环必须落在真正可聚焦的元素上」这一条显式契约
    const whitelist = [...base.matchAll(/^\s*(\.[\w-]+[^\s{]*):focus-visible/gm)].map((m) => {
      return m[1] as string
    })
    expect(whitelist).toEqual(['.conversation-item-main'])
  })

  it('焦点信号由 composer 容器承担，输入框内层不得再画第二道框', () => {
    const base = sheet('styles.css')
    expect(ruleBody(base, '.chat-input-box textarea:focus')).toContain('outline: none')
    // 焦点由外层容器表达：描边染琥珀 + 4px 光晕，在 composer 这个尺度上足够醒目
    const container = ruleBody(base, '.chat-input-col:focus-within')
    expect(container).toContain('border-color: var(--amber-text)')
    expect(container).toMatch(/0 0 0 4px/)
    // 白卡里再套一个硬边矩形＝一个控件两层框，正是"方方的感觉"的来源：内层不许画框
    expect(base).not.toMatch(/\.chat-input-box:focus-within\s*\{[^}]*inset/)
  })

  // ---- 焦点环：渲染级断言 ----
  // 下面每一条都在真级联里问「聚焦后还剩什么」。此前只有一条 grep ':where' 的源码断言，
  // 于是「表单控件漏掉」「tabindex="-1" 被圈进去」两类回归一条都测不出来。
  // 夹具照抄真实 DOM：.field 包文本框与滑杆、.search-box 是 <input>、
  // .conversation-item-main 是会话行的 <button>，都不替样式表留情面。
  const FIXTURE = `
    <button id="btn">按钮</button>
    <a id="link" href="#x">链接</a>
    <input id="search" class="search-box">
    <div class="field"><input id="text" type="text"></div>
    <div class="field"><input id="range" type="range"></div>
    <div class="apikey-row"><input id="apikey" type="password"></div>
    <div class="conversation-item"><button id="row" class="conversation-item-main">行</button></div>
    <div id="modal" class="modal" tabindex="-1"></div>
  `

  it('键盘能到达的控件聚焦后都有可见焦点信号（滑杆与 API Key 输入框曾经两样皆空）', () => {
    const probe = focusProbe(FIXTURE)
    try {
      for (const selector of ['#btn', '#link', '#text', '#range', '#apikey', '#row']) {
        expect(probe.focus(selector).visible, `${selector} 聚焦后没有任何可见焦点信号`).toBe(true)
      }
    } finally {
      probe.dispose()
    }
  })

  it('.field 的焦点环不被后面的 input[type="range"] 规则抹掉', () => {
    const probe = focusProbe(FIXTURE)
    try {
      const ring = probe.focus('#btn').outline
      expect(ring, '连普通按钮都没拿到兜底焦点环，先修兜底').toMatch(/^2px solid /)

      // 文本框：焦点信号由自身那圈 inset + 光晕承担，所以 box-shadow 必须还在。
      // 它与 input[type="range"] 同为 0,2,1，靠后那句 box-shadow: none 曾把它清成 none。
      const text = probe.focus('#text')
      expect(text.boxShadow, '.field 文本框的焦点环被 range 规则吞掉了').not.toBe('none')
      expect(text.boxShadow).toMatch(/inset/)

      // 滑杆不吃输入框皮肤，于是焦点信号落到全局 outline 上——两样皆空才是回归。
      const range = probe.focus('#range')
      expect(range.boxShadow).toBe('none')
      expect(range.outline, '人格四维性格滑杆聚焦后没有任何焦点信号').toBe(ring)
    } finally {
      probe.dispose()
    }

    // 结构上的保证（jsdom 只按源码顺序解析，钉不住「谁后谁赢」，所以这条单独查选择器）：
    // 滑杆从皮肤层就被 :not([type="range"]) 排除，于是两条规则不再竞争同一声明，
    // 顺序不再是焦点环的生死开关。
    const base = sheet('styles.css')
    const skin = ruleBody(base, '.field input:not([type="range"])')
    expect(skin, '输入框皮肤又把滑杆圈回去了').toContain('box-shadow')
    expect(ruleBody(base, '.field input:not([type="range"]):focus')).toContain('var(--focus-ring)')
  })

  it('tabindex="-1" 不被兜底圈进去：弹窗容器聚焦时不会镶一圈琥珀', () => {
    const probe = focusProbe(FIXTURE)
    try {
      const ring = probe.focus('#btn').outline
      // 弹窗容器是刻意编程可达的（打开时把焦点放上去），键盘用户根本 Tab 不到它。
      // 兜底一旦把它圈进去，整只弹窗镶一圈琥珀框。兜底只写 outline，判据就是这一项；
      // box-shadow 不用问——.modal 自带的 --shadow-3 与焦点无关，不是信号。
      expect(probe.focus('#modal').outline, 'tabindex="-1" 拿到了兜底焦点环').not.toBe(ring)
    } finally {
      probe.dispose()
    }
  })

  it('自带焦点环的控件仍然只有一圈（修兜底不许给它们加第二圈）', () => {
    // 特异度只能算，不能靠 jsdom 读出来：jsdom 的 getComputedStyle 只按源码顺序解析，
    // 完全不看特异度（实测把 .high:focus 写在前面、:where(...) 写在后面，赢的是后面那个）。
    // 浏览器里谁赢由特异度决定，所以这条必须用算的。
    expect(specificity('.search-box:focus')).toBeGreaterThan(specificity(FOCUS_FALLBACK))
    const search = ruleBody(sheet('styles.css'), '.search-box:focus')
    expect(search, '.search-box 的焦点规则不见了').toContain('outline: none')
    expect(search).toContain('var(--focus-ring)')

    const probe = focusProbe(FIXTURE)
    try {
      // 搜索框自己那圈「琥珀描边 + 光晕」必须还在（这条与特异度无关，jsdom 读得出来）
      expect(probe.focus('#search').boxShadow, '搜索框自己的焦点环丢了').toMatch(/inset/)

      // 会话行主按钮：全局兜底与显式契约写的是同一条 outline，重复声明不叠出两圈。
      // 这条在 jsdom 里成立是靠源码顺序（显式契约写在兜底之后），而它同时也是更高特异度。
      expect(probe.focus('#row').outline).toBe(probe.focus('#btn').outline)
    } finally {
      probe.dispose()
    }
  })
})
