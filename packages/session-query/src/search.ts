/**
 * 内存倒排索引：零配置的全文搜索后端。
 *
 * 做法是本仓最老的那套：一个词 → 见过它的消息集合，倒排表建在内存里。
 * 好处是不落盘、不用管索引文件、进程重启就没了（重建一次索引的事）；
 * 坏处是库大了就吃内存，而且每次查询都要扫词表——所以它只适合「会话不多、
 * 文本不多」的场合。库大了换 {@link Fts5SearchBackend}，接口不变。
 *
 * 排序用的是一个简化的 BM25 口径：命中词按「稀有度」加权（到处都有的词不值钱），
 * 同一个词在一条消息里出现多次再加一点词频分。分数方向统一为**越大越相关**。
 * @module @ryharness/session-query/search
 */

import { searchTokenList } from './text.ts'
import type { SearchBackendQuery, SearchDocument, SearchHit, SessionSearchBackend } from './types.ts'

/** 索引里的一条文档。 */
interface IndexedDocument {
  /** 文档本身。 */
  document: SearchDocument
  /** 词频表：词 → 出现次数。 */
  counts: Map<string, number>
}

/** 内存倒排索引。 */
export class MemorySearchBackend implements SessionSearchBackend {
  /** 后端名字。 */
  readonly name = 'memory'

  /** 消息 id → 文档。 */
  private readonly documents = new Map<string, IndexedDocument>()

  /** 词 → 见过它的消息 id。 */
  private readonly postings = new Map<string, Set<string>>()

  /** 会话 id → 这个会话里的消息 id。 */
  private readonly conversations = new Map<string, Set<string>>()

  /** 灌一条消息进索引（正文为空的不进索引）。 */
  index(document: SearchDocument): void {
    if (document.text.length === 0) return
    this.removeDocument(document.messageId)
    const counts = new Map<string, number>()
    for (const token of searchTokenList(document.text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    if (counts.size === 0) return
    this.documents.set(document.messageId, { document, counts })
    const owned = this.conversations.get(document.conversationId) ?? new Set<string>()
    owned.add(document.messageId)
    this.conversations.set(document.conversationId, owned)
    for (const token of counts.keys()) {
      const bucket = this.postings.get(token) ?? new Set<string>()
      bucket.add(document.messageId)
      this.postings.set(token, bucket)
    }
  }

  /** 丢掉一个会话的全部索引行。 */
  removeConversation(conversationId: string): void {
    const owned = this.conversations.get(conversationId)
    if (owned === undefined) return
    for (const messageId of owned) this.removeDocument(messageId)
    this.conversations.delete(conversationId)
  }

  /** 搜：按分数降序（同分按 seq 降序，新的在前）。 */
  search(query: string, options: SearchBackendQuery): SearchHit[] {
    const queryTokens = [...new Set(searchTokenList(query))]
    if (queryTokens.length === 0) return []
    const scored = new Map<string, { hit: SearchHit; score: number }>()
    const total = this.documents.size
    for (const token of queryTokens) {
      const bucket = this.postings.get(token)
      if (bucket === undefined) continue
      // 越少见的词越值钱：到处都有的词（"的"、"the"）几乎不贡献分数。
      const idf = Math.log(1 + total / bucket.size)
      for (const messageId of bucket) {
        const entry = this.documents.get(messageId)
        if (entry === undefined) continue
        if (options.conversationId !== undefined && entry.document.conversationId !== options.conversationId) continue
        const frequency = entry.counts.get(token) ?? 0
        const score = idf * (frequency / (frequency + 1))
        const found = scored.get(messageId)
        if (found === undefined) {
          scored.set(messageId, { hit: this.toHit(entry.document), score })
        } else {
          found.score += score
        }
      }
    }
    const ordered = [...scored.values()].sort((left, right) => {
      return right.score - left.score || right.hit.seq - left.hit.seq
    })
    return ordered.slice(0, Math.max(1, options.limit)).map((item) => {
      return { ...item.hit, score: item.score }
    })
  }

  /** 清空索引。 */
  clear(): void {
    this.documents.clear()
    this.postings.clear()
    this.conversations.clear()
  }

  /** 释放资源：内存索引没有句柄，清空即可。 */
  close(): void {
    this.clear()
  }

  /** 索引里现在有多少条文档（诊断用）。 */
  get size(): number {
    return this.documents.size
  }

  /** 从索引里去掉一条消息。 */
  private removeDocument(messageId: string): void {
    const entry = this.documents.get(messageId)
    if (entry === undefined) return
    for (const token of entry.counts.keys()) {
      const bucket = this.postings.get(token)
      if (bucket === undefined) continue
      bucket.delete(messageId)
      if (bucket.size === 0) this.postings.delete(token)
    }
    const owned = this.conversations.get(entry.document.conversationId)
    owned?.delete(messageId)
    this.documents.delete(messageId)
  }

  /** 文档 → 命中（片段先留空，由查询服务按最新的正文补）。 */
  private toHit(document: SearchDocument): SearchHit {
    return {
      messageId: document.messageId,
      conversationId: document.conversationId,
      seq: document.seq,
      senderType: document.senderType,
      ...(document.senderId === undefined ? {} : { senderId: document.senderId }),
      createdAt: document.createdAt,
      snippet: '',
      score: 0,
    }
  }
}
