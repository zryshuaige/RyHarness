/**
 * 会话导出：把一个会话打成一个 ZIP。
 *
 * 包里有四样东西：
 * - `session.json`：会话元数据（谁、什么会话、什么时候）；
 * - `messages.json` / `messages.jsonl`：全部消息（结构化一份、一行一条一份）；
 * - `artifacts.json`：产物清单（哪个消息产出了什么文件）；
 * - `README.md`：这个包里有什么、怎么读。
 *
 * 产物文件**本体**要不要一起打包由调用方决定：本包不碰文件系统（它不知道工作区
 * 在哪儿、也不知道哪些产物还在），调用方把要带上的文件按 `artifacts` 传进来。
 *
 * ZIP 格式自己拼（见 zip.ts），不引外部依赖。
 * @module @ryharness/session-query/export
 */

import type { MessageArtifact } from '@ryharness/session'
import type { SessionQueryService } from './service.ts'
import { createZip, type ZipEntry } from './zip.ts'

/** 要一起打进包里的产物文件。 */
export interface SessionExportArtifact {
  /** 包内路径（建议 `artifacts/xxx`）。 */
  path: string
  /** 文件内容。 */
  data: Buffer
}

/** 导出参数。 */
export interface SessionExportOptions {
  /** 要导出的会话 id。 */
  conversationId: string
  /** 产物文件本体（可选）：不带就只导出清单。 */
  artifacts?: readonly SessionExportArtifact[]
  /** 导出时间（Unix 毫秒，写进元数据）；缺省 = 现在。 */
  exportedAt?: number
}

/** 导出结果。 */
export interface SessionExportResult {
  /** ZIP 字节。 */
  data: Buffer
  /** 包内有哪些文件（按包内顺序）。 */
  entries: string[]
  /** 导出了几条消息。 */
  messageCount: number
  /** 清单里有几件产物。 */
  artifactCount: number
}

/** 产物清单里的一条。 */
interface ArtifactRecord {
  /** 产出它的消息 id。 */
  messageId: string
  /** 消息序号。 */
  seq: number
  /** 工具调用 id。 */
  callId: string
  /** 文件名。 */
  name: string
  /** 字节数。 */
  size: number
  /** MIME 类型。 */
  mime: string
  /** 包内路径；文件本体没打包时缺省。 */
  path?: string
}

/**
 * 把一个会话导成一个 ZIP。
 *
 * @param service - 查询服务（历史内容的来源）。
 * @param options - 导出参数。
 * @returns ZIP 字节与包内清单。
 */
export function exportSession(service: SessionQueryService, options: SessionExportOptions): SessionExportResult {
  const conversation = service.getConversation(options.conversationId)
  if (conversation === undefined) {
    throw new Error(`会话 ${options.conversationId} 不存在（或者已经被删了），导不出来。`)
  }
  const page = service.listMessages({
    conversationId: conversation.id,
    order: 'asc',
    limit: 1_000_000,
  })
  const messages = page.items
  const exportedAt = options.exportedAt ?? Date.now()

  const provided = options.artifacts ?? []

  const records: ArtifactRecord[] = []
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      records.push(toRecord(artifact, message.id, message.seq, provided))
    }
  }

  const metadata = {
    exportedAt,
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      memberAgentIds: conversation.memberAgentIds,
      ...(conversation.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: conversation.dispatcherAgentId }),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messageCount: messages.length,
    artifactCount: records.length,
  }

  const entries: ZipEntry[] = [
    { path: 'session.json', data: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8') },
    { path: 'messages.json', data: Buffer.from(`${JSON.stringify(messages, null, 2)}\n`, 'utf8') },
    { path: 'messages.jsonl', data: Buffer.from(toJsonLines(messages), 'utf8') },
    { path: 'artifacts.json', data: Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8') },
    { path: 'README.md', data: Buffer.from(readmeText(metadata, records), 'utf8') },
  ]
  for (const artifact of options.artifacts ?? []) {
    entries.push({ path: artifact.path, data: artifact.data })
  }

  return {
    data: createZip(entries, { modifiedAt: new Date(exportedAt) }),
    entries: entries.map((entry) => {
      return entry.path
    }),
    messageCount: messages.length,
    artifactCount: records.length,
  }
}

/** 产物 → 清单记录（带上它在包里的路径）。 */
function toRecord(
  artifact: MessageArtifact,
  messageId: string,
  seq: number,
  provided: readonly SessionExportArtifact[],
): ArtifactRecord {
  const found = provided.find((item) => {
    return item.path === `artifacts/${artifact.name}` || item.path.endsWith(`/${artifact.name}`)
  })
  return {
    messageId,
    seq,
    callId: artifact.callId,
    name: artifact.name,
    size: artifact.size,
    mime: artifact.mime,
    ...(found === undefined ? {} : { path: found.path }),
  }
}

/** 消息数组 → 一行一条的 JSONL。 */
function toJsonLines(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      return JSON.stringify(message)
    })
    .join('\n')
    .concat(messages.length === 0 ? '' : '\n')
}

/** 包内那份说明。 */
function readmeText(metadata: { messageCount: number; artifactCount: number }, records: ArtifactRecord[]): string {
  const lines = [
    '# 会话导出',
    '',
    `这个包是一个会话的完整历史，共 ${metadata.messageCount} 条消息、${metadata.artifactCount} 件产物。`,
    '',
    '## 包里有什么',
    '',
    '- `session.json`：会话元数据（id、标题、成员、时间）。',
    '- `messages.json`：全部消息（一个 JSON 数组）。',
    '- `messages.jsonl`：同一条数据，一行一条（便于流式处理或 `grep`）。',
    '- `artifacts.json`：产物清单：哪个消息产出了什么文件。',
    '- `README.md`：本文件。',
  ]
  const withFiles = records.filter((record) => {
    return record.path !== undefined
  })
  if (withFiles.length > 0) {
    lines.push('', '## 产物文件', '')
    for (const record of withFiles) {
      lines.push(`- \`${record.path}\`（${record.name}，${record.size} 字节）`)
    }
  }
  lines.push(
    '',
    '## 怎么读',
    '',
    '```sh',
    '# 看一眼会话是什么',
    'unzip -p session.zip session.json',
    '',
    '# 一行一条地翻消息',
    'unzip -p session.zip messages.jsonl',
    '```',
    '',
  )
  return lines.join('\n')
}
