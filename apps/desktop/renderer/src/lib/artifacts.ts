/**
 * 消息行上的产物卡（服务端落库字段）的读取层。
 *
 * 为什么单独一个模块：`api.ts` 的 `MessageRow` 是"服务端返回什么就声明什么"的镜像，
 * 而这个字段是本轮新加的（见 `SessionStore.appendMessage` 的 `artifacts` 入参）。
 * 放在这里，渲染层就能在**服务端字段到位之前**先把产物还原链路接通，
 * 且字段缺失（旧库、未落库、第三方客户端）时按空数组处理，不抛错、不崩历史。
 */
import type { MessageRow } from '../api.ts'

/** 一张产物卡：与 file_produce 的返回、与本地附件回执同构。 */
export interface RowArtifact {
  callId: string
  name: string
  size: number
  mime: string
}

/** 带产物字段的消息行（服务端 rowToMessage 的输出形状）。 */
type RowWithArtifacts = MessageRow & { artifacts?: readonly RowArtifact[] }

/**
 * 读一条历史行上的产物卡。
 *
 * 字段是可选的外部输入，因此这里做形状校验而不是断言：任何一条脏数据都不该让
 * 整个会话的历史加载失败。
 */
export function rowArtifacts(row: MessageRow): readonly RowArtifact[] {
  const raw = (row as RowWithArtifacts).artifacts
  if (!Array.isArray(raw)) return []
  const out: RowArtifact[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const { callId, name, size, mime } = item as Partial<RowArtifact>
    if (typeof callId !== 'string' || typeof name !== 'string') continue
    out.push({
      callId,
      name,
      size: typeof size === 'number' ? size : 0,
      mime: typeof mime === 'string' ? mime : '',
    })
  }
  return out
}
