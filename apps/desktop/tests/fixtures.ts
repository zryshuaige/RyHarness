/**
 * 跨测试文件共享的最小夹具。
 *
 * 存在的理由：渲染层类型收敛到服务端单一真源后，`AgentTemplate.persona` 从
 * 「渲染层手抄版里不存在」变成真源里的必填字段——测试夹具不再能靠手抄版的
 * 缺字段蒙混过关。一份共享的最小 persona，谁需要谁 import。
 */
import type { AgentPersona } from '../renderer/src/api.ts'

export const TEST_PERSONA: AgentPersona = {
  extroversion: 50,
  rigor: 50,
  humor: 50,
  initiative: 50,
  catchphrase: '',
  affinity: 0,
  voiceId: 'none',
  appearance: '',
}
