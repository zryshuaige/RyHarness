/**
 * 「这次 vitest 运行到底跑完了没有」的判定。
 *
 * 为什么独立成一个纯函数：这段判定以前整块埋在 `vitest.config.ts` 的 reporter 里，
 * 唯一能验证它的办法是真去制造一次崩溃（起一个会打死 worker 的用例），那既慢又不稳定，
 * 于是它实际上从未被验证过——而它恰恰是那种「错了没人发现、发现了已经晚了」的代码：
 * 它一旦漏判，覆盖率棘轮就会把「没跑完」写成「某个源文件突然没人测了」。
 * 抽出来之后，崩溃的三种来源都能用普通单测钉住。
 *
 * 三种「没跑完」的来源（vitest 4.1 实测）：
 *   1. worker 被打死（OOM / 句柄耗尽 / 被 Ctrl-C）——模块停在 queued 或 pending；
 *   2. 未捕获错误与未处理 rejection——vitest 单独收在 unhandledErrors 里，
 *      它们不一定会让任何一个模块停在非终态，光看模块状态会漏判；
 *   3. 运行被中断——`onTestRunEnd` 的 reason 报 `interrupted`。
 * 外加两个 vitest 自己知道、却不告诉 reporter 的情形：
 *   4. 规格没被收集——vitest 会把没拿到 testModule 的规格过滤掉，于是收尾时模块数偏少；
 *   5. watcher 触发的重跑——vitest 内部对这种运行传的是 `allTestsRun = false`，
 *      也就是说覆盖率本来就是按「子集」算的，而阈值仍然会照常判定。
 */

/** vitest 的 TestModuleState：模块级就是 TestSuiteState 再加一个尚未入队的 queued。 */
export type RunModuleState = 'queued' | 'pending' | 'skipped' | 'failed' | 'passed'

/** 只描述用得上的那点成员，方便用例直接传字面量，不必造真的 TestModule。 */
export interface RunModuleLike {
  state: () => RunModuleState
  relativeModuleId: string
}

export interface RunDiagnosisInput {
  /** onTestRunStart 收到的规格数：本次本该跑多少个测试文件。 */
  expectedFiles: number
  /** onTestRunEnd 收到的模块；没收集到的规格已被 vitest 过滤，所以这个数只会偏少。 */
  modules: readonly RunModuleLike[]
  unhandledErrors: readonly unknown[]
  reason: string
  /**
   * 本次运行由 watcher / UI 触发重跑而来。vitest 内部对重跑传的是 `allTestsRun = false`，
   * 覆盖率是按子集算的，所以它属于「没有覆盖率结论」而不是「这次红」。
   */
  rerun: boolean
  /**
   * watch 模式。交互式跑一遍本来就会因为改文件重跑、Ctrl-C 中断，
   * 拿这些去把进程判红只会让人养成无视红字的习惯。
   */
  watch: boolean
}

export interface RunDiagnosis {
  /** 本次运行是否不足以支撑覆盖率结论。 */
  incomplete: boolean
  /** 判据本身，直接拼进给用户看的那一行，免得只报「不完整」却不说清为什么。 */
  reasons: string[]
  /**
   * 整体被 skip 的测试文件。运行本身是完整的，所以不算 incomplete，
   * 但这些文件一行覆盖率都没贡献——棘轮掉下来时要能一眼看出是这个原因。
   */
  skippedFiles: string[]
}

/** 没跑到终态：模块已被收进这次运行，但既没通过也没失败。 */
const UNFINISHED_STATES = new Set<RunModuleState>(['queued', 'pending'])

/** 超过这个数就只报数量，避免几十个文件名把一行提示撑爆。 */
const MAX_NAMED_FILES = 5

export function diagnoseRun(input: RunDiagnosisInput): RunDiagnosis {
  const unfinished = input.modules.filter((module) => UNFINISHED_STATES.has(module.state()))
  const skippedFiles = input.modules
    .filter((module) => module.state() === 'skipped')
    .map((module) => module.relativeModuleId)
  const reasons: string[] = []

  if (unfinished.length > 0) {
    // 文件名要列出来：只报「2 个文件」没法定位，而崩溃通常是某一个文件把 worker 带走的
    // （内存、句柄），知道是谁才能修。
    const names = unfinished
      .slice(0, MAX_NAMED_FILES)
      .map((module) => module.relativeModuleId)
      .join('、')
    reasons.push(
      `${unfinished.length} 个测试文件没跑到终态（${names}${unfinished.length > MAX_NAMED_FILES ? '…' : ''}）`,
    )
  }
  if (input.modules.length < input.expectedFiles) {
    reasons.push(`只收集到 ${input.modules.length}/${input.expectedFiles} 个`)
  }
  if (input.unhandledErrors.length > 0) {
    reasons.push(`${input.unhandledErrors.length} 处未捕获错误`)
  }
  // watch 模式下的 interrupted 多半是「改了一个文件、当前这轮作废重跑」，不是崩溃。
  if (input.reason === 'interrupted' && !input.watch) {
    reasons.push('运行被中断')
  }
  if (input.rerun && !input.watch) {
    reasons.push('这次是重跑而不是全量运行（覆盖率按子集统计）')
  }

  return { incomplete: reasons.length > 0, reasons, skippedFiles }
}
