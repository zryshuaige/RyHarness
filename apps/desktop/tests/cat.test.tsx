// @vitest-environment jsdom

/**
 * <Cat> 是位图徽标：一张 gen:icon 从 assets/brand/mark.png 导出的 256 档，
 * 渲染层吃的那份在 renderer/public/cat.png（与 assets/cat.png 逐字节一致，见
 * brand-tiers.test.ts）。
 *
 * 断言钉的是**结构不变量**，不钉像素：
 *   - 徽标真的是一个 <img>，指向那张图（母版同源）；
 *   - size 透传到宽高；shape="circle" 切到满幅圆这一档样式；
 *   - 三态几何 API 已经退场：DOM 里不再有 mood / tier 的钩子，也没有内联 SVG。
 * 「16px 下还认不认得出是猫」是像素层面的判断，由 docs/brand/icon.md 里的实测与逐档
 * 策略承担，不适合用单元测试钉像素。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Cat } from '../renderer/src/components/Cat.tsx'

// 路径走 fs 而不是 URL：jsdom 环境会把全局 URL 换成 whatwg 实现，import.meta.url
// 在它那儿解析不出 file: 协议。
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(DESKTOP, 'renderer/public')
const BRAND = join(DESKTOP, 'assets/brand')
const SRC = join(DESKTOP, 'renderer/src')

/** 渲染层源码全集：收敛类断言要覆盖所有调用点，不能只盯某几个已知文件。 */
function readRendererSources(dir: string = SRC): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...readRendererSources(path))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push({ file: path.slice(DESKTOP.length + 1).replace(/\\/g, '/'), source: readFileSync(path, 'utf8') })
  }
  return out
}

const tiers = JSON.parse(readFileSync(join(BRAND, 'tiers.json'), 'utf8')) as { brand: string }

describe('Cat 位图徽标', () => {
  it('渲染的是一个 <img>，指向 gen:icon 导出的那张图', () => {
    const html = renderToStaticMarkup(<Cat size={40} />)
    expect(html).toContain('<img')
    expect(html).toContain('class="cat"')
    expect(html).toContain(`src="/app/${tiers.brand}"`)
    // 与应用图标同源：文件真实存在，且是 gen-icon 声明过的产物
    expect(existsSync(join(PUBLIC, tiers.brand))).toBe(true)
    expect(existsSync(join(DESKTOP, 'assets', tiers.brand))).toBe(true)
    // 位图徽标没有内联 SVG，也就没有每只猫一个的渐变 id
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<defs')
  })

  it('尺寸透传到宽高，不写死成某一张', () => {
    expect(renderToStaticMarkup(<Cat size={64} />)).toContain('width="64" height="64"')
    expect(renderToStaticMarkup(<Cat size={22} />)).toContain('width="22" height="22"')
    expect(renderToStaticMarkup(<Cat />)).toContain('width="40" height="40"')
  })

  it('shape="circle" 只切样式，不换图：头像位与图标位是同一只猫', () => {
    const squircle = renderToStaticMarkup(<Cat size={40} />)
    const circle = renderToStaticMarkup(<Cat size={40} shape="circle" />)
    expect(squircle).toContain('class="cat"')
    expect(squircle).not.toContain('cat-circle')
    expect(circle).toContain('class="cat cat-circle"')
    // 圆角是画出来的，不是另一张图
    const srcOf = (html: string): string => {
      return /src="([^"]+)"/.exec(html)?.[1] as string
    }
    expect(srcOf(circle)).toBe(srcOf(squircle))
    // 头像位外面已有 role="img" + aria-label 的外壳，徽标自身不再重复播报
    expect(circle).toContain('aria-hidden="true"')
    expect(circle).toContain('alt=""')
  })

  it('圆角规则由 assets/brand/cat.css 定义，且与头像画布同一半径', () => {
    const css = readFileSync(join(DESKTOP, 'renderer/src/assets/brand/cat.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    // 50% = avatars.tsx 的 AVATAR_SPEC.radius：猫 / 风格 / 骨架 / 首字符共用一块画布
    expect(css).toMatch(/\.cat-circle\s*\{[^}]*border-radius:\s*50%/)
    // 行内图片自带基线下方的空隙，头像位与标题栏里会把整行撑高几像素
    expect(css).toMatch(/\.cat\s*\{[^}]*display:\s*block/)
  })

  it('三态几何 API 已退场：DOM 里没有 mood / tier 钩子', () => {
    const html = renderToStaticMarkup(<Cat size={40} />)
    expect(html).not.toContain('data-mood')
    expect(html).not.toContain('data-tier')
    expect(html).not.toContain('Ryen idle')
    // 组件源码里也不再有 SVG 几何、渐变 id，也没有去读那份分级补偿表
    const source = readFileSync(join(DESKTOP, 'renderer/src/components/Cat.tsx'), 'utf8')
    expect(source).not.toContain('<svg')
    expect(source).not.toContain('linearGradient')
    expect(source, '组件不再读 tiers.json 的补偿表').not.toMatch(/from\s+'[^']*tiers\.json'/)
    expect(source).not.toContain('JSON.parse')
  })
})

describe('调用点收敛与矢量时代的死代码', () => {
  it('渲染层不再给 <Cat> 传 mood：三态几何已退场，废弃 API 不许复活', () => {
    const sources = readRendererSources()
    const callSites: { file: string; tag: string }[] = []
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/<Cat\b[^>]*>/g)) {
        callSites.push({ file, tag: match[0] })
      }
    }
    // 非空护栏：先确认扫到了调用点，否则「一个都没匹配」会被正则失效伪装成通过。
    expect(callSites.length, '扫到的 <Cat> 调用点').toBeGreaterThan(5)
    for (const { file, tag } of callSites) {
      expect(tag, `${file} 仍在向 <Cat> 传 mood`).not.toMatch(/\bmood\s*=/)
    }
  })

  it('thinking 落在 TypingDots 上，而不是徽标上', () => {
    // 徽标只剩一张位图，「正在思考」唯一还在动的表达是打字三点；删死代码的人容易
    // 顺手把这条一起清掉，所以把它当不变量钉住。
    const chatView = readFileSync(join(SRC, 'components/ChatView.tsx'), 'utf8')
    expect(chatView, '会话区的 typing 指示器').toContain('<TypingDots />')
    expect(readFileSync(join(SRC, 'components/TypingDots.tsx'), 'utf8')).toContain('typing-dots')
  })

  it('styles.css 里没有矢量猫的墨色与星屑动画', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
    expect(css, '墨色 token 随矢量母版作废').not.toContain('--cat-ink')
    // 只钉 `.cat ` 后缀的图元类名：--skeleton-sheen 是活着的骨架微光，不在射程内。
    expect(css, 'SVG 图元钩子已无消费者').not.toMatch(/\.cat\s+\.(ink|inkf|sheen|star|fast|joy)\b/)
    expect(css, '三态动画的关键帧已无消费者').not.toMatch(/@keyframes\s+(starpulse|starspin|starjoy)\b/)
  })

  it('矢量母版与手绘补偿的描述不再残留在注释里', () => {
    // 「代码与现实脱节」比死代码更难发现：读代码的人会按注释去找一份已经不存在的 SVG。
    for (const { file, source } of readRendererSources()) {
      expect(source, `${file} 仍引用已删除的矢量母版`).not.toContain('cat-face.svg')
    }
    const main = readFileSync(join(DESKTOP, 'electron/main.ts'), 'utf8')
    expect(main).not.toContain('cat-face.svg')
  })
})
