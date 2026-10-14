/**
 * 性能基准：会话列表、消息分页、recall（有 key 实测 embedding）、playbook
 * 编译、server 冷启动。数字记入 docs/performance.md。
 * 用法：pnpm tsx scripts/bench.ts（真实 embedding 需 SILICONFLOW_API_KEY）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { EvolveService } from '@ryagent/evolve'
import { HashEmbeddings, MemoryService, NullEmbeddings, SiliconFlowEmbeddings } from '@ryagent/memory'
import { SessionStore } from '@ryagent/session'

const dir = mkdtempSync(join(tmpdir(), 'ryagent-bench-'))
const dbPath = join(dir, 'bench.db')

const store = new SessionStore(dbPath)

// ---- 造数据：20 会话 × 100 消息；50 条记忆 ----
const agents = ['ryen', 'codebot', 'owl']
for (const id of agents) {
  store.upsertAgent({
    id,
    name: id,
    systemPrompt: 'p',
    provider: 'mock',
    model: 'm',
    tools: [],
    isBuiltin: id === 'ryen',
  })
}
const convIds: string[] = []
for (let c = 0; c < 20; c++) {
  const conv = store.createConversation({
    kind: c % 3 === 0 ? 'group' : 'direct',
    title: `会话 ${c}`,
    memberAgentIds: [agents[c % 3]!],
    ...(c % 3 === 0 ? { dispatcherAgentId: 'ryen' } : {}),
  })
  convIds.push(conv.id)
  for (let m = 0; m < 100; m++) {
    store.appendMessage({
      conversationId: conv.id,
      senderType: m % 2 === 0 ? 'user' : 'agent',
      senderId: m % 2 === 0 ? 'user' : agents[c % 3]!,
      contentBlocks: [{ type: 'text', text: `第 ${m} 条消息，关于任务 ${c} 的中文文本填充。` }],
      turnIndex: Math.floor(m / 2),
    })
  }
}

function benchSync<T>(label: string, iterations: number, fn: () => T): number {
  fn()
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const ms = (performance.now() - t0) / iterations
  console.log(`[bench] ${label}: ${ms.toFixed(3)} ms/次 (${iterations} 次)`)
  return ms
}

async function benchAsync(label: string, iterations: number, fn: () => Promise<unknown>): Promise<number> {
  await fn()
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) await fn()
  const ms = (performance.now() - t0) / iterations
  console.log(`[bench] ${label}: ${ms.toFixed(2)} ms/次 (${iterations} 次)`)
  return ms
}

// ---- DB 查询 ----
benchSync('会话列表（单查询含预览+未读）', 200, () => {
  store.listConversationsWithPreview(50)
})
benchSync('消息分页（limit=50）', 200, () => {
  store.listMessages(convIds[0]!, { limit: 50 })
})
benchSync('消息分页（beforeSeq 翻页）', 200, () => {
  store.listMessages(convIds[0]!, { limit: 50, beforeSeq: 150 })
})

// ---- 记忆 recall ----
const hashEmb = new HashEmbeddings()
const memHash = new MemoryService({ dbPath, embeddings: hashEmb, logger: () => {} })
for (let i = 0; i < 50; i++) {
  memHash.store.insert({
    agentId: 'ryen',
    kind: i % 3 === 0 ? 'profile' : 'fact',
    content: `事实 ${i}：用户偏好第 ${i} 号设定，关于工作和生活的细节描述。`,
    embedding: hashEmb.vectorOf(`事实 ${i}`),
  })
}
await benchAsync('recall（Hash embedding，50 记忆）', 50, () => {
  return memHash.recall('ryen', '用户偏好什么')
})

const key = process.env.SILICONFLOW_API_KEY ?? ''
if (key.length > 0) {
  const memReal = new MemoryService({
    dbPath,
    embeddings: new SiliconFlowEmbeddings({ apiKey: key }),
    logger: () => {},
  })
  const t0 = performance.now()
  await memReal.recall('ryen', '用户工作上有什么偏好')
  console.log(`[bench] recall 真实 embedding 冷启动（网络）: ${(performance.now() - t0).toFixed(0)} ms`)
  await benchAsync('recall 真实 embedding 缓存命中', 5, () => {
    return memReal.recall('ryen', '用户工作上有什么偏好')
  })
  memReal.close()
} else {
  console.log('[bench] 无 SILICONFLOW_API_KEY，跳过真实 embedding 实测')
}

const memNull = new MemoryService({ dbPath, embeddings: new NullEmbeddings(), logger: () => {} })
await benchAsync('recall（纯 FTS5 降级）', 100, () => {
  return memNull.recall('ryen', '工作')
})

// ---- playbook 编译 ----
const evolve = new EvolveService({ dbPath, logger: () => {} })
await benchAsync('playbook compile', 500, () => {
  return evolve.compile('ryen', '帮我查一下最近的资料')
})

// ---- server 冷启动 ----
const { RyAgentServer } = await import('@ryagent/server')
const dir2 = mkdtempSync(join(tmpdir(), 'ryagent-boot-'))
const tBoot = performance.now()
const server = await RyAgentServer.create({ port: 0, dataDir: dir2, memory: null, evolution: null })
console.log(`[bench] server 冷启动（建库+迁移+种子+listen）: ${(performance.now() - tBoot).toFixed(0)} ms`)
await server.close()

store.close()
memHash.close()
memNull.close()
evolve.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
rmSync(dir2, { recursive: true, force: true, maxRetries: 5 })
console.log('[bench] done')
