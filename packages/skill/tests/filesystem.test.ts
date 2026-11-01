/**
 * 文件系统技能来源的用例。
 *
 * 这里跑的是**真的磁盘**：临时目录里摆技能文件，再看发现的结果对不对。
 * mock 掉 readdir 只能证明代码按 mock 的样子跑，证明不了「目录里有 SKILL.md
 * 就能认出来」这件事本身。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSkillRoots, FileSystemSkillProvider } from '../src/index.ts'

const roots: string[] = []

/** 造一个临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-skill-'))
  roots.push(dir)
  return dir
}

/** 写一个技能文件。 */
function writeSkill(file: string, name: string, description = '一段说明', extra = ''): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\n正文内容\n`, 'utf8')
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('文件系统技能来源', () => {
  it('目录里的 SKILL.md 能被发现', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    const catalog = await provider.list()

    expect(catalog.map((item) => item.name)).toEqual(['alpha'])
    expect(catalog[0].source).toBe('project')
    expect(catalog[0].description).toBe('一段说明')
  })

  it('平铺的 <name>.md 也能被发现', async () => {
    const root = tempDir()
    writeSkill(join(root, 'beta.md'), 'beta')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    const catalog = await provider.list()

    expect(catalog.map((item) => item.name)).toEqual(['beta'])
  })

  it('frontmatter 里的 title 与 tags 会被解析出来', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha', '一段说明', 'title: 阿尔法\ntags:\n  - 写作\n  - 校对\n')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    const catalog = await provider.list()

    expect(catalog[0].title).toBe('阿尔法')
    expect(catalog[0].tags).toEqual(['写作', '校对'])
  })

  it('目录里没有 SKILL.md 的子目录被跳过，并留下原因', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'empty'), { recursive: true })
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.list()).toEqual([])
    expect(provider.diagnostics()[0].reason).toContain('SKILL.md')
  })

  it('缺 description 的技能不进目录，但诊断里说得出原因', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'broken'), { recursive: true })
    writeFileSync(join(root, 'broken', 'SKILL.md'), '---\nname: broken\n---\n正文\n', 'utf8')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.list()).toEqual([])
    expect(provider.diagnostics()[0].reason).toContain('description')
  })

  it('名字不合法的技能被跳过', async () => {
    const root = tempDir()
    writeSkill(join(root, 'bad name', 'SKILL.md'), 'bad name')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.list()).toEqual([])
    expect(provider.diagnostics()[0].reason).toContain('不合法')
  })

  it('再往下的嵌套 SKILL.md 不被发现', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'references', 'deep', 'SKILL.md'), 'deep')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.list()).toEqual([])
  })

  it('同名技能：优先级高的根目录赢', async () => {
    const project = tempDir()
    const user = tempDir()
    writeSkill(join(project, 'dup', 'SKILL.md'), 'dup', '项目里的')
    writeSkill(join(user, 'dup', 'SKILL.md'), 'dup', '用户目录的')
    const provider = new FileSystemSkillProvider({
      roots: [
        { path: user, label: 'user', priority: 300 },
        { path: project, label: 'project', priority: 100 },
      ],
    })

    const catalog = await provider.list()

    expect(catalog).toHaveLength(1)
    expect(catalog[0].source).toBe('project')
    expect((await provider.resolve('dup'))?.content).toContain('正文内容')
  })

  it('默认根目录：项目是 .skills，用户是 skills', () => {
    const roots = defaultSkillRoots({ workspaceRoot: '/ws', dataDir: '/data', customDirs: ['/custom'] })

    expect(roots.map((item) => item.path)).toEqual([join('/ws', '.skills'), '/custom', join('/data', 'skills')])
    expect(roots.map((item) => item.label)).toEqual(['project', 'custom', 'user'])
  })

  it('正文每次都重读：改了文件立刻能取到新的', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    await provider.list()

    writeFileSync(
      join(root, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: 一段说明\n---\n改过之后的正文\n',
      'utf8',
    )
    const loaded = await provider.resolve('alpha')

    expect(loaded?.content).toContain('改过之后的正文')
  })

  it('取一个不存在的技能：返回 undefined，不报错', async () => {
    const root = tempDir()
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.resolve('nothing')).toBeUndefined()
  })

  it('refresh 之后新加的技能能被认出来', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    expect(await provider.list()).toHaveLength(1)

    writeSkill(join(root, 'beta', 'SKILL.md'), 'beta')
    await provider.refresh()

    expect((await provider.list()).map((item) => item.name)).toEqual(['alpha', 'beta'])
  })

  it('目录不存在不是故障：目录空着就行', async () => {
    const provider = new FileSystemSkillProvider({
      roots: [{ path: join(tempDir(), 'not-there'), label: 'user' }],
    })

    expect(await provider.list()).toEqual([])
    expect(provider.diagnostics()).toEqual([])
  })

  it('根目录其实是个文件：诊断里说得出原因', async () => {
    const root = tempDir()
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x', 'utf8')
    const provider = new FileSystemSkillProvider({ roots: [{ path: file, label: 'project' }] })

    expect(await provider.list()).toEqual([])
    expect(provider.diagnostics()[0].reason).toContain('目录读不了')
  })

  it('frontmatter 写坏的几种情形都进诊断', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'no-frontmatter'), { recursive: true })
    writeFileSync(join(root, 'no-frontmatter', 'SKILL.md'), '# 就一段正文\n', 'utf8')
    mkdirSync(join(root, 'no-name'), { recursive: true })
    writeFileSync(join(root, 'no-name', 'SKILL.md'), '---\ndescription: 有说明\n---\n正文\n', 'utf8')
    mkdirSync(join(root, 'bad-name'), { recursive: true })
    writeFileSync(join(root, 'bad-name', 'SKILL.md'), '---\nname: 坏名字\ndescription: 有说明\n---\n正文\n', 'utf8')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })

    expect(await provider.list()).toEqual([])
    const reasons = provider.diagnostics().map((item) => item.reason)

    expect(reasons.some((reason) => reason.includes('frontmatter'))).toBe(true)
    expect(reasons.some((reason) => reason.includes('没有 name'))).toBe(true)
    expect(reasons.some((reason) => reason.includes('名字不合法'))).toBe(true)
  })

  it('文件被删了：正文取不到', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    await provider.list()

    rmSync(join(root, 'alpha', 'SKILL.md'))

    expect(await provider.resolve('alpha')).toBeUndefined()
  })

  it('盯着目录：新增的技能会被发现，退订之后不再通知', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    await provider.list()
    let changes = 0
    const off = provider.onChange(() => {
      changes += 1
    })
    provider.startWatching({ debounceMs: 20 })
    try {
      writeSkill(join(root, 'beta', 'SKILL.md'), 'beta')
      await vi.waitFor(
        async () => {
          const catalog = await provider.list()
          expect(catalog.map((item) => item.name)).toContain('beta')
        },
        { timeout: 8000, interval: 50 },
      )
    } finally {
      provider.stopWatching()
    }
    expect(changes).toBeGreaterThan(0)

    off()
    const before = changes
    writeSkill(join(root, 'gamma', 'SKILL.md'), 'gamma')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(changes).toBe(before)
  })

  it('停止盯目录可以重复调', async () => {
    const root = tempDir()
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    provider.startWatching()

    provider.stopWatching()
    provider.stopWatching()
  })

  it('技能目录被删了：监听器跟着收掉', async () => {
    const root = tempDir()
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    await provider.list()
    provider.startWatching()
    try {
      rmSync(join(root, 'alpha'), { recursive: true, force: true })
      await provider.refresh()

      expect(await provider.list()).toEqual([])
    } finally {
      provider.stopWatching()
    }
  })

  it('停止盯目录时，正排队的那次刷新被取消', async () => {
    const root = tempDir()
    const provider = new FileSystemSkillProvider({ roots: [{ path: root, label: 'project' }] })
    // 先扫一遍：此刻目录是空的。
    await provider.list()
    // 合并窗口开得很大：变化先被攒着，等 stopWatching 来取消它。
    provider.startWatching({ debounceMs: 5000 })
    writeSkill(join(root, 'alpha', 'SKILL.md'), 'alpha')
    await new Promise((resolve) => setTimeout(resolve, 300))

    provider.stopWatching()

    expect(await provider.list()).toEqual([])
  })
})
