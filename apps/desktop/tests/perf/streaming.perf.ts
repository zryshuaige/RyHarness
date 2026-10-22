/**
 * 客户端「流式丝滑」的性能基线（不进默认 CI 通道，用 `pnpm perf` 手动跑）。
 *
 * 断言都刻意用**比值 / 上界 / 命中计数**而不是绝对毫秒——机器快慢、CI 负载都不该让
 * 基线漂：
 *  1. 等价性：前缀缓存 + 尾巴重算得到的词法树，与整篇 lex 的结构一致（先证对，再证快）；
 *  2. 收益：流式期重建词法树的累计成本显著低于「每次 flush 整篇 lex」；
 *  3. 群聊并发：两条 lane 交替 flush 仍等价、仍命中（单槽实现会在这里塌掉）；
 *  4. 事件折叠：2000 个 text-delta 只换来个性数位次订阅通知（40ms 合并）。
 *
 * 未覆盖（需要真实 Chromium，jsdom 做不了）：帧时间 p50/p95、首屏分段、GC 堆基线。
 * 这三项要等 `boot-trace` 的分段值与真机采集，不在本清单里假装有。
 */
import { lexer, type Token } from 'marked'
import { describe, expect, it } from 'vitest'
import { prefixCacheStats, streamingTokens } from '../../renderer/src/components/Markdown.tsx'
import { ChatStore } from '../../renderer/src/store.ts'

const PROSE =
  '这一段用来测量渲染成本：包含 **强调**、`行内代码`、[链接](https://example.com) 与中文标点，' +
  '长度接近真实回答的平均段落。'

/** 一段真实长度的段落（约 60 个词）：流式会在它内部停留很多帧，缓存才有意义。 */
function paragraph(): string {
  return `${(PROSE + ' ').repeat(8).trimEnd()}\n\n`
}

/** 模拟完整回答：`paragraphs` 段，返回全文。 */
function docOf(paragraphs: number): string {
  let text = ''
  for (let index = 0; index < paragraphs; index++) text += paragraph()
  return text
}

/**
 * 模拟真实流式：按**词边界**切分逐帧追加。
 *
 * 两个坑都在这行注释里：
 * 1. 切点不能落在构造中间——把 `**强调**` 或 `[文字](url)` 从中间切开会让 marked 走到
 *    非预期的输入形态（实测能把一次 run 拖到分钟级）；按空白切分就不会切开构造。
 * 2. 模型要贴近真实：前缀缓存只在「块内稳定」时生效。若写成「每帧追加一整段」
 *    （每帧都撞在空行边界上），缓存拿不到任何好处，测试会把实现误判成无效。
 */
function streamFramesByWords(text: string, wordsPerFrame: number): string[] {
  const words = text.split(' ')
  const frames: string[] = []
  for (let end = wordsPerFrame; end < words.length + wordsPerFrame; end += wordsPerFrame) {
    frames.push(words.slice(0, end).join(' '))
  }
  return frames
}

/** 单帧耗时的中位数（比总和更能反映"每帧有多贵"）。 */
function medianMs(frames: readonly string[], run: (text: string) => unknown): number {
  const samples: number[] = []
  for (const text of frames) {
    const started = performance.now()
    run(text)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)] ?? 0
}

/** 结构指纹：块类型 + 原始文本，用于比较两条词法路径是否等价。 */
function fingerprint(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      return `${token.type}:${(token as { raw?: string }).raw?.length ?? 0}`
    })
    .join('|')
}

/**
 * 两条 lane 交替 flush（群聊 fanoutConcurrency 的最小复现）。
 *
 * 群聊里同时有好几条消息在出字，两条就够暴露问题：旧实现把「已稳定前缀」放在模块级
 * 单槽里，A、B 每帧互相顶掉对方的槽，`startsWith` 恒为 false ⇒ 每帧退回整篇 lex，
 * 下面那套增量的收益在群聊里正好是零，而单流用例永远量不出来。
 */
function interleaveLanes(left: readonly string[], right: readonly string[]): { text: string; cacheKey: string }[] {
  const frames: { text: string; cacheKey: string }[] = []
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index] !== undefined) frames.push({ text: left[index], cacheKey: 'lane-a' })
    if (right[index] !== undefined) frames.push({ text: right[index], cacheKey: 'lane-b' })
  }
  return frames
}

describe('Markdown 流式词法（性能基线）', () => {
  it('逐帧等价：增量前缀 + 尾巴重算与整篇 lex 结构一致', () => {
    // 逐帧对比是这条优化的安全网：只要增量拼接改变了块结构（漏块 / 多块 / 类型变），
    // 这里就会在具体那一帧上变红，而不是等到用户看到渲染差异。
    const frames = streamFramesByWords(docOf(30), 6)
    for (const text of frames) {
      const cached = streamingTokens(text)
      const full = lexer(text)
      expect(fingerprint(cached), `帧长 ${text.length}`).toBe(fingerprint(full))
    }
  })

  it('真实流式（按词逐帧追加）下单帧成本显著低于整篇 lex', () => {
    const frames = streamFramesByWords(docOf(30), 6) // 约 18KB，120 帧
    const cachedMedian = medianMs(frames, streamingTokens)
    const fullMedian = medianMs(frames, (text) => {
      return lexer(text)
    })

    // eslint-disable-next-line no-console
    console.log(
      `[perf] 流式词法中位帧：增量路径 ${cachedMedian.toFixed(3)}ms vs 整篇重算 ${fullMedian.toFixed(3)}ms（${frames.length} 帧）`,
    )
    // 留足余量：实测增量路径约为整篇重算的 1/3-1/6（尾巴越小差距越大）。
    // 删掉增量逻辑时这条必然变红（退化成每帧整篇 lex → 比值 ~1）。
    expect(cachedMedian).toBeLessThan(fullMedian * 0.5)
  })

  it('群聊并发（两条 lane 交替 flush）：逐帧结果仍与整篇 lex 一致', () => {
    // 分槽只改缓存的取用方式，不许顺带改出渲染差异：交替逐帧对拍是最直接的网。
    const frames = interleaveLanes(streamFramesByWords(docOf(30), 6), streamFramesByWords(docOf(30), 6))
    for (const frame of frames) {
      expect(
        fingerprint(streamingTokens(frame.text, frame.cacheKey)),
        `${frame.cacheKey} 帧长 ${frame.text.length}`,
      ).toBe(fingerprint(lexer(frame.text)))
    }
  })

  it('群聊并发：交替 flush 下前缀缓存仍然命中（不是每帧整篇重 lex）', () => {
    const frames = interleaveLanes(streamFramesByWords(docOf(30), 6), streamFramesByWords(docOf(30), 6))
    // 先热 JIT 再计时，两条路径用同一批帧。
    for (const frame of frames) streamingTokens(frame.text, frame.cacheKey)

    const before = prefixCacheStats()
    const cachedStarted = performance.now()
    for (const frame of frames) streamingTokens(frame.text, frame.cacheKey)
    const cachedMs = performance.now() - cachedStarted
    const after = prefixCacheStats()

    const fullStarted = performance.now()
    for (const frame of frames) lexer(frame.text)
    const fullMs = performance.now() - fullStarted

    const hits = after.hits - before.hits
    const misses = after.misses - before.misses
    // eslint-disable-next-line no-console
    console.log(
      `[perf] 交替 flush（${frames.length} 帧）：增量 ${cachedMs.toFixed(2)}ms vs 整篇 ${fullMs.toFixed(2)}ms，` +
        `命中 ${hits} / 未命中 ${misses}，槽位 ${after.slots}`,
    )
    // 硬指标（与机器快慢无关）：每条 lane 只在「前缀还没成立」的那一帧整段重 lex。
    // 退回单槽实现时这里是每帧一次 miss，命中数归零——这条比任何比值都敏感。
    expect(misses).toBeLessThanOrEqual(4)
    expect(hits).toBeGreaterThan(frames.length * 0.9)
    expect(cachedMs).toBeLessThan(fullMs * 0.6)
  })
})

describe('ChatStore 事件折叠（性能基线）', () => {
  it('2000 个 text-delta 只触发个位数次订阅通知', async () => {
    const store = new ChatStore()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })

    const started = performance.now()
    for (let index = 0; index < 2000; index++) {
      store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '字' })
    }
    const foldMs = performance.now() - started
    // 合并窗口是 40ms 的尾随合并：等它把最后一次 flush 放出来再数。
    await new Promise((resolve) => {
      setTimeout(resolve, 80)
    })

    // eslint-disable-next-line no-console
    console.log(`[perf] 2000 个 delta 折叠耗时 ${foldMs.toFixed(2)}ms，订阅通知 ${notifications} 次`)
    expect(notifications).toBeLessThanOrEqual(10)
    expect(foldMs).toBeLessThan(200)
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ kind: 'text' })
  })
})
