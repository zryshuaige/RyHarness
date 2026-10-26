import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VibeProject } from '@ryharness/server'
import { validateVibeProject } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []

function fixture(kind: VibeProject['kind'], name: string, content: string): VibeProject {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-lighthouse-${kind}-`))
  dirs.push(dir)
  const extension = kind === 'app' ? '.html' : kind === 'sheet' ? '.csv' : '.md'
  const fileName = `artifact${extension}`
  const path = join(dir, fileName)
  writeFileSync(path, content, 'utf8')
  return {
    name,
    slug: name,
    kind,
    dir,
    summary: name,
    files: [{ name: fileName, path, size: content.length }],
    createdAt: 0,
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('RyVibe 灯塔交付验收', () => {
  it('文档：可直接发送的周报通过，空章节模板不能通过', () => {
    const report = `# 本周周报

本周完成供应商配置与产物预览，修复了重启后文件消失的问题。
下周集中验证三个真实任务，交付物以用户能否直接使用为准。
风险是复杂任务仍会超时，需要保留断点和人工接管入口。`
    expect(validateVibeProject(fixture('doc', '本周周报', report)).ok).toBe(true)
    expect(validateVibeProject(fixture('doc', '本周周报', '# 周报\n\n## 背景\n\n## 要点\n')).ok).toBe(false)
  })

  it('表格：开支 CSV 可解析且金额可计算，错列和模板行不能通过', () => {
    const sheet = '项目,金额,备注\n房租,3200,十月\n餐饮,"1,280",含聚餐\n交通,126.5,地铁'
    const result = validateVibeProject(fixture('sheet', '本月开支', sheet))
    expect(result.ok).toBe(true)
    expect(result.checks.some((item) => item.id === 'sheet-numbers' && item.ok)).toBe(true)
    expect(validateVibeProject(fixture('sheet', '本月开支', '项目,金额\n房租,三千')).ok).toBe(false)
    expect(validateVibeProject(fixture('sheet', '本月开支', '项目,金额\n房租')).ok).toBe(false)
  })

  it('应用：记账工具必须有交互和持久化，项目骨架页不算交付', () => {
    const app = `<!doctype html><html><body>
<input id="amount" type="number"><button id="add">记账</button><ul id="items"></ul><output id="total"></output>
<script>
const rows = JSON.parse(localStorage.getItem('rows') || '[]');
function render() { document.querySelector('#total').textContent = rows.reduce((sum, row) => sum + row.amount, 0); }
document.querySelector('#add').onclick = () => { rows.push({ amount: Number(document.querySelector('#amount').value) }); localStorage.setItem('rows', JSON.stringify(rows)); render(); };
render();
</script></body></html>`
    expect(validateVibeProject(fixture('app', '记账工具', app)).ok).toBe(true)
    const skeleton =
      '<html><body><h1>记账工具</h1><h2>第一版要做的事</h2><p>由 RyHarness 的 RyVibe 生成</p></body></html>'
    const failed = validateVibeProject(fixture('app', '记账工具', skeleton))
    expect(failed.ok).toBe(false)
    expect(failed.checks.some((item) => item.id === 'app-not-template' && !item.ok)).toBe(true)
  })

  it('流程：必须有具体步骤以及触发和交接，空步骤不能通过', () => {
    const flow = `# 周报流程\n\n## 什么时候触发\n每周一上午。\n\n## 步骤\n1. 负责人收集上周数据并输出表格。\n2. 文案核对数据后交接周报正文。\n\n## 产物\n一份可发送的周报。`
    expect(validateVibeProject(fixture('flow', '周报流程', flow)).ok).toBe(true)
    expect(validateVibeProject(fixture('flow', '周报流程', '# 流程\n\n1. \n2. \n\n## 待填')).ok).toBe(false)
  })
})
