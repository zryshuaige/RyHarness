/**
 * SQLite FTS5 搜索后端：给大库用的那一个。
 *
 * 索引**自己一份**，不碰会话库：会话库的 schema 是 `@ryharness/session` 定的，
 * 本包不改它（改了就等于让底座依赖查询层）。所以这里另开一个 SQLite 文件，
 * 自己建一张 FTS5 虚表，外加一张普通表存元信息（会话 id、seq、发言者……）。
 *
 * 为什么是两张表：FTS5 虚表只能存正文，元信息放在 UNINDEXED 列里的话，按
 * message_id 查一次就得全表扫。虚表的 rowid 与元信息表的 rowid 对齐，于是
 * 「按 id 找到那一行」是主键查找，「搜正文」是虚表的 MATCH，两边都省。
 *
 * 分词口径与底座一致（bigram 预处理 + unicode61），查询串也用同一套转义
 * （`@ryharness/session` 的 `ftsMatchQuery`）：两边对同一个词的解释不同，
 * 就会出现「索引里有、查不出来」这种最难查的错。
 * @module @ryharness/session-query/fts5
 */

import { DatabaseSync } from 'node:sqlite'
import { bigrams, ftsMatchQuery } from '@ryharness/session'
import type { SearchBackendQuery, SearchDocument, SearchHit, SessionSearchBackend } from './types.ts'

/** FTS5 后端的参数。 */
export interface Fts5SearchBackendOptions {
  /** 索引文件路径；缺省 = 内存库（进程退出就没了）。 */
  path?: string
}

/** 索引表名（真表 + 虚表）。 */
const DOCS_TABLE = 'session_search_docs'
const FTS_TABLE = 'session_search_fts'

/** SQLite FTS5 搜索后端。 */
export class Fts5SearchBackend implements SessionSearchBackend {
  /** 后端名字。 */
  readonly name = 'fts5'

  /** 索引库句柄。 */
  private readonly db: DatabaseSync

  /** 构造函数：开库、建表。 */
  constructor(options: Fts5SearchBackendOptions = {}) {
    this.db = new DatabaseSync(options.path ?? ':memory:')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        rowid           INTEGER PRIMARY KEY,
        message_id      TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        sender_type     TEXT NOT NULL,
        sender_id       TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${DOCS_TABLE}_conversation
        ON ${DOCS_TABLE} (conversation_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(content, tokenize = 'unicode61');
    `)
  }

  /** 灌一条消息进索引（正文为空的不进索引）。 */
  index(document: SearchDocument): void {
    if (document.text.length === 0) return
    const existing = this.db.prepare(`SELECT rowid FROM ${DOCS_TABLE} WHERE message_id = ?`).get(document.messageId) as
      | { rowid: number }
      | undefined
    if (existing !== undefined) {
      this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(Number(existing.rowid))
      this.db.prepare(`DELETE FROM ${DOCS_TABLE} WHERE rowid = ?`).run(Number(existing.rowid))
    }
    const inserted = this.db
      .prepare(
        `INSERT INTO ${DOCS_TABLE} (message_id, conversation_id, seq, sender_type, sender_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.messageId,
        document.conversationId,
        document.seq,
        document.senderType,
        document.senderId ?? null,
        document.createdAt,
      )
    const rowid = Number(inserted.lastInsertRowid)
    this.db.prepare(`INSERT INTO ${FTS_TABLE} (rowid, content) VALUES (?, ?)`).run(rowid, bigrams(document.text))
  }

  /** 丢掉一个会话的全部索引行。 */
  removeConversation(conversationId: string): void {
    const rows = this.db.prepare(`SELECT rowid FROM ${DOCS_TABLE} WHERE conversation_id = ?`).all(conversationId) as {
      rowid: number
    }[]
    for (const row of rows) {
      this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(Number(row.rowid))
    }
    this.db.prepare(`DELETE FROM ${DOCS_TABLE} WHERE conversation_id = ?`).run(conversationId)
  }

  /**
   * 搜：BM25 相关度取负号当分数（越大越相关）。
   *
   * SQLite 的 `bm25()` 返回负数、越负越相关；本仓统一「越大越相关」，所以取负号，
   * 与内存倒排后端同一个方向，调用方排序时不用分后端。
   */
  search(query: string, options: SearchBackendQuery): SearchHit[] {
    const matchQuery = ftsMatchQuery(query)
    if (matchQuery.length === 0) return []
    const limit = Math.max(1, options.limit)
    const rows = (
      options.conversationId === undefined
        ? this.db
            .prepare(
              `SELECT d.message_id, d.conversation_id, d.seq, d.sender_type, d.sender_id, d.created_at,
                      -bm25(${FTS_TABLE}) AS score
                 FROM ${FTS_TABLE}
                 JOIN ${DOCS_TABLE} d ON d.rowid = ${FTS_TABLE}.rowid
                WHERE ${FTS_TABLE} MATCH ?
                ORDER BY score DESC, d.seq DESC
                LIMIT ?`,
            )
            .all(matchQuery, limit)
        : this.db
            .prepare(
              `SELECT d.message_id, d.conversation_id, d.seq, d.sender_type, d.sender_id, d.created_at,
                      -bm25(${FTS_TABLE}) AS score
                 FROM ${FTS_TABLE}
                 JOIN ${DOCS_TABLE} d ON d.rowid = ${FTS_TABLE}.rowid
                WHERE ${FTS_TABLE} MATCH ? AND d.conversation_id = ?
                ORDER BY score DESC, d.seq DESC
                LIMIT ?`,
            )
            .all(matchQuery, options.conversationId, limit)
    ) as {
      message_id: string
      conversation_id: string
      seq: number
      sender_type: string
      sender_id: string | null
      created_at: number
      score: number
    }[]
    return rows.map((row) => {
      return {
        messageId: String(row.message_id),
        conversationId: String(row.conversation_id),
        seq: Number(row.seq),
        senderType: String(row.sender_type) as SearchHit['senderType'],
        ...(row.sender_id === null ? {} : { senderId: String(row.sender_id) }),
        createdAt: Number(row.created_at),
        snippet: '',
        score: Number(row.score),
      }
    })
  }

  /** 清空索引。 */
  clear(): void {
    this.db.exec(`DELETE FROM ${FTS_TABLE}; DELETE FROM ${DOCS_TABLE};`)
  }

  /** 关掉索引库。 */
  close(): void {
    this.db.close()
  }

  /** 索引里现在有多少条文档（诊断用）。 */
  get size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${DOCS_TABLE}`).get() as { count: number }
    return Number(row.count)
  }
}
