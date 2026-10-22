// @vitest-environment jsdom
/**
 * 图标体系里图标样式之外的那一半：
 *
 *   1. 焦点环 —— 新加的控件默认就有环。样式表用 :where() 的 0 特异度兜底，任何组件
 *      类都不会盖掉它；这条测试钉住兜底本身还在、原生可聚焦控件都列进了那张表、
 *      tabindex="-1" 被排除在外，且没有任何 :focus-visible 规则把 outline 抹成 none
 *      （那正是「加了个按钮却静默没有焦点环」的失败方式）。
 *      兜底「聚焦后还剩什么」那一半在 design-system.test.tsx 里用 jsdom 真级联钉住。
 *   2. 图标按钮命名 —— 纯图标按钮（内容只有一个 <Icon>）必须带 aria-label。title
 *      只在鼠标悬停时出现，键盘与读屏用户拿不到。
 *   3. 界面 chrome 不出现 emoji/装饰符号 —— 纯装饰的符号（⋯ › ‹ ★ ⚠ 以及各类
 *      emoji）要么换成图标要么删掉；注释与中文行文里的箭头不算。
 *
 * 另外顺手钉住「图标不小于 16px」：渲染出来的 .icon 宽度必须落在 16/20/24 上。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Icon } from '../renderer/src/components/Icon.tsx'
import { Modal } from '../renderer/src/components/Modal.tsx'
import { ToastHost } from '../renderer/src/components/ToastHost.tsx'
import { toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(DESKTOP, 'renderer/src')

/** 去注释后的 JS/TS 源码：注释里写的 👍 / ↑↓ 只是说明文字，不是界面 chrome。 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 行注释跳过 URL 里的 "//"，否则 https://… 之后的一整行会被吃掉。
      .split('\n')
      .map((line) => {
        const at = line.indexOf('//')
        return at === -1 || line.includes('://') ? line : line.slice(0, at)
      })
      .join('\n')
  )
}

function filesIn(dir: string, exts: string[]): { file: string; code: string }[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => {
      return join(dir, String(entry))
    })
    .filter((file) => {
      return exts.some((ext) => {
        return file.endsWith(ext)
      })
    })
    .sort()
    .map((file) => {
      // Windows 上 join 出来的是反斜杠；断言里一律用正斜杠，否则 startsWith 永远不成立
      // （过滤条件静默失效，用例变成永远为真）。
      return {
        file: file
          .slice(SRC.length + 1)
          .split(sep)
          .join('/'),
        code: readFileSync(file, 'utf8'),
      }
    })
}

const sources = filesIn(SRC, ['.ts', '.tsx']).map((entry) => {
  return { file: entry.file, code: stripComments(entry.code) }
})
const sheets = filesIn(SRC, ['.css']).map((entry) => {
  return { file: entry.file, css: entry.code.replace(/\/\*[\s\S]*?\*\//g, '') }
})

/**
 * 扫出每个 <button> 的属性串与内容。开标签的结束位置不能靠 /<button([^>]*)>/：
 * onClick={() => …} 里的 "=>" 会被当成标签结束，属性串在半路被截断。
 */
function buttonBlocks(code: string): { attrs: string; inner: string }[] {
  const blocks: { attrs: string; inner: string }[] = []
  for (const hit of code.matchAll(/<button\b/g)) {
    const start = hit.index + '<button'.length
    let depth = 0
    let end = start
    for (; end < code.length; end++) {
      const ch = code[end]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    const attrs = code.slice(start, end)
    if (code[end - 1] === '/') continue // 自闭合：没有内容
    const close = code.indexOf('</button>', end)
    blocks.push({ attrs, inner: close === -1 ? '' : code.slice(end + 1, close) })
  }
  return blocks
}

/**
 * 取出全局焦点环兜底那条规则。`:where(...)` 里还套着 `:not(...)`，一层正则切不准
 * （`[^)]*` 会在 :not 的右括号上断掉），所以按括号深度扫。
 */
function focusFallbackRule(css: string): { selector: string; body: string } | null {
  const open = css.indexOf(':where(')
  if (open === -1) return null
  const tableStart = open + ':where('.length
  let depth = 1
  let close = -1
  for (let i = tableStart; i < css.length; i++) {
    if (css[i] === '(') depth += 1
    else if (css[i] === ')') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return null
  const brace = css.indexOf('{', close)
  const end = css.indexOf('}', brace)
  if (brace === -1 || end === -1) return null
  return { selector: css.slice(open, brace).trim(), body: css.slice(brace + 1, end) }
}

describe('图标可达性', () => {
  it('新增控件默认拿到焦点环：全局 :where() 兜底在，且没有任何 focus-visible 抹掉 outline', () => {
    const base = sheets.find((sheet) => {
      return sheet.file === 'styles.css'
    })
    expect(base, 'styles.css 没了').toBeDefined()
    const rule = focusFallbackRule(base?.css ?? '')
    expect(rule, '全局焦点环兜底规则不在了').not.toBeNull()
    const table = rule?.selector ?? ''
    const body = rule?.body ?? ''
    // 用 0 特异度的 :where 兜底：组件类盖不掉它，漏写一条也不会静默失效。
    expect(body).toMatch(/outline:\s*2px solid/)
    expect(body).toMatch(/outline-offset:\s*2px/)
    // 兜底表里必须有原生可聚焦控件。只列 button / a[href] / [tabindex] 时，键盘 Tab 到的
    // 表单控件全部落在兜底之外——人格四维性格滑杆与欢迎页的 API Key 输入框就是这样
    // 静默失去焦点反馈的，而一次编译、一个用例都不会为此变红。
    for (const tag of ['input', 'select', 'textarea']) {
      expect(table, `兜底表里没有 ${tag}，原生表单控件会静默没有焦点环`).toMatch(
        new RegExp(`(^|[\\s,])${tag}([\\s,]|$)`),
      )
    }
    // tabindex="-1" 是刻意留给脚本聚焦的（弹窗容器、role=alert 段落），键盘走不到它。
    // 圈进去会让整只弹窗镶一圈琥珀，所以必须显式排除。
    expect(table, 'tabindex="-1" 没被排除，弹窗会镶一圈琥珀').toMatch(/\[tabindex\]:not\(\[tabindex="-1"\]\)/)
    // 且排除必须待在 :where() 内部：挪到外面会漏掉上面那条匹配（:not([tabindex="-1"]) 里
    // 没有 input），兜底照样漏掉表单控件——排除看着做了，作用却落空了。
    expect(table, '排除被挪出了 :where()，兜底反而匹配不到 input').toMatch(
      /:where\([^)]*\[tabindex\]:not\(\[tabindex="-1"\]\)[^)]*\)\s*:focus-visible\s*$/,
    )
    for (const sheet of sheets) {
      for (const hit of sheet.css.matchAll(/([^{}]*):focus-visible\s*\{([^}]*)\}/g)) {
        expect(hit[2], `${sheet.file} 的 ${hit[1].trim()} 把 outline 抹了`).not.toMatch(/outline:\s*(none|0)\b/)
      }
    }
  })

  it('纯图标按钮都带 aria-label：内容只有一个 <Icon> 的按钮不许只有 title', () => {
    const offenders: string[] = []
    // 扫全部渲染层源码而不是只有 components/：栏 1 那两枚纯图标按钮（换主题 / 设置）
    // 写在 App.tsx 里，此前正好落在管辖范围之外，title 单独挂着读屏只会念出「按钮」。
    for (const { file, code } of sources) {
      for (const { attrs, inner } of buttonBlocks(code)) {
        if (!inner.includes('<Icon')) continue
        if (attrs.includes('aria-label')) continue
        // 去掉所有标签后还留着裸文案或没求值的表达式 → 这是带文字的按钮，不在管辖范围。
        const rest = inner.replace(/<[^>]*>/g, '')
        if (rest.includes('{') || rest.replace(/\s/g, '') !== '') continue
        offenders.push(file)
      }
    }
    expect(offenders, '纯图标按钮缺 aria-label（读屏用户只能听到「按钮」）').toEqual([])
  })

  it('渲染出来的图标不小于 16px，且都在 16/20/24 三档上', () => {
    for (const name of ['x', 'check', 'send', 'crown'] as const) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() => {
        root.render(<Icon name={name} size={4} />)
      })
      const width = Number(host.querySelector('svg')?.getAttribute('width'))
      expect(width, name).toBeGreaterThanOrEqual(16)
      expect([16, 20, 24], name).toContain(width)
      act(() => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('弹窗与 toast 的关闭按钮读得出来（真实渲染，不靠源码正则）', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <>
          <Modal title="删除这条记忆？" onClose={() => {}}>
            内容
          </Modal>
          <ToastHost />
        </>,
      )
    })
    act(() => {
      toast.error('删除失败')
    })
    const labels = [...host.querySelectorAll('button')].map((button) => {
      return button.getAttribute('aria-label')
    })
    expect(labels, '关闭按钮没有可读名称').toContain('关闭')
    expect(labels, 'toast 关闭按钮没有可读名称').toContain('关闭提示')
    act(() => {
      root.unmount()
    })
    host.remove()
  })
})

describe('界面 chrome 里没有 emoji', () => {
  /**
   * 纯装饰符号与 emoji。散文里的箭头（→ ↑↓）、流式光标（▍）不在表里：前者是中文
   * 行文的一部分，后者是字形光标不是图标。
   */
  const CHROME_GLYPHS = /[⋯›‹⬆⇧➜⬛⬜]|[︎⃣]|[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu

  /**
   * 例外清单。渲染层已经清干净（会话列表预览的前缀也从 ⚠️ 换成了纯文字），所以它是空的。
   * 留着这个常量而不是直接删掉，是为了挡住「又出现一处，先挂个例外再说」——
   * 一旦允许往里写，它就会变成什么都往里塞的池子。
   */
  const KNOWN_OUTLIERS: string[] = []

  it('渲染层源码里没有作为 chrome 的 emoji / 装饰符号', () => {
    const hits: string[] = []
    for (const { file, code } of sources) {
      if (KNOWN_OUTLIERS.includes(file)) continue
      for (const match of code.matchAll(CHROME_GLYPHS)) {
        hits.push(`${file}: ${JSON.stringify(match[0])}`)
      }
    }
    expect(hits, '界面 chrome 不该出现 emoji / 装饰符号，换成图标或删掉').toEqual([])
  })

  it('例外清单是空的：出问题就改代码，不许新开例外', () => {
    expect(KNOWN_OUTLIERS, '渲染层的 chrome 符号已经清零，别把这里当成例外池').toEqual([])
  })
})

describe('禁用态有可见反馈', () => {
  it('带图标的按钮被禁用时，样式表里有对应规则（不许只是 disabled 属性裸挂着）', () => {
    const all = sheets
      .map((sheet) => {
        return sheet.css
      })
      .join('\n')
    for (const selector of [
      '.send-btn:disabled',
      '.load-earlier:disabled',
      'button.tool-row:disabled',
      '.memory-delete:disabled',
    ]) {
      expect(all, `${selector} 没有禁用态样式`).toContain(selector)
    }
  })
})
