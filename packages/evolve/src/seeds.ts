/**
 * 冷启动种子：每个内置模板带 2–3 条经验手册条目（ACE 冷启动），
 * 用户 agent 创建时按模板播种（seedIfEmpty，幂等）。
 * @module @ryagent/evolve/seeds
 */

import type { PlaybookSection } from './schema.ts'
import type { EvolveStore } from './store.ts'

export const SEED_PLAYBOOKS: Readonly<Record<string, readonly { section: PlaybookSection; content: string }[]>> = {
  general: [
    { section: 'strategy', content: '先倾听再行动：确认用户真正想要什么，再决定自己答还是转交。' },
    { section: 'preference', content: '回复保持简洁温暖，除非用户要求展开。' },
    { section: 'pitfall', content: '不要主动 @ 自己；不确定的事先简短说明再问。' },
  ],
  coding: [
    { section: 'strategy', content: '改代码前先读完整文件，理解上下文再动手。' },
    { section: 'strategy', content: '改动保持最小：只做用户要求的事，不顺手重构。' },
    { section: 'pitfall', content: '跑命令前确认工作目录；失败命令要看 stderr 再下结论。' },
  ],
  writing: [
    { section: 'strategy', content: '先给成稿，再附简要修改说明；不要让用户等框架。' },
    { section: 'preference', content: '默认中文书面语，语气按场景调整（正式/亲切）。' },
  ],
  translation: [
    { section: 'strategy', content: '保留原文格式与术语；人名地名按通行译法。' },
    { section: 'pitfall', content: '拿不准的译法附简短注释，不硬翻。' },
  ],
  'file-organizer': [
    { section: 'strategy', content: '先盘点工作区文件，再按用户要求移动/归档。' },
    { section: 'pitfall', content: '任何删除前必须说明；结果用清单汇报。' },
  ],
}

/** 若该 agent 尚无 active 条目且模板有种子，播种（幂等）。返回播种条数。 */
export function seedIfEmpty(store: EvolveStore, agentId: string, templateKey: string): number {
  if (store.countActive(agentId) > 0) return 0
  const seeds = SEED_PLAYBOOKS[templateKey]
  if (seeds === undefined) return 0
  for (const seed of seeds) {
    store.insertEntry({
      agentId,
      section: seed.section,
      content: seed.content,
      source: 'seed',
      // 种子也进证据链：用户问「这条为什么在这儿」时要能答"来自内置模板"。
      origins: [{ kind: 'seed', refId: templateKey, detail: `内置 ${templateKey} 模板` }],
    })
  }
  return seeds.length
}
