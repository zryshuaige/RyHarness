/**
 * 进程范围：一组进程归谁管。
 *
 * 「归谁管」是实打实的责任：这一组进程要么都还活着，要么都被收掉，不能是「主进程
 * 收了，它自己起的那些不知道去哪了」。所以范围提供的是**整体**动作——整体查活、
 * 整体终止——而不是让调用方自己记一张进程表。
 *
 * 档位要说清楚：本机 provider 没有原生的托管范围（Windows Job Object、Linux
 * cgroup 都没做），所以这里实现的是**模拟**：逐个记着、终止时逐个收。范围上的
 * `support` 字段就是这句话的机器可读版本，别让界面显示成「原子托管」。
 * @module @ryharness/subprocess/range
 */

import type { ManagedProcess, ManagedRangeSupport, ProcessRange } from './types.ts'

/** 范围 id 计数器。 */
let rangeSequence = 0

/** 下一个范围 id。 */
function nextRangeId(): string {
  rangeSequence += 1
  return `range-${rangeSequence}`
}

/** 建一个进程范围的参数。 */
export interface CreateProcessRangeOptions {
  /** 范围 id；缺省自动分配。 */
  readonly id?: string
  /** 范围的名字（给人看的）。 */
  readonly label?: string
  /** 托管档位；缺省 `emulated`（模拟托管）。 */
  readonly support?: ManagedRangeSupport
  /** 降级说明；缺省没有。 */
  readonly notes?: readonly string[]
}

/**
 * 建一个进程范围。
 *
 * @param options - id、名字、档位与降级说明。
 * @returns 进程范围。
 */
export function createProcessRange(options: CreateProcessRangeOptions = {}): ProcessRange {
  const members = new Set<ManagedProcess>()
  return {
    id: options.id ?? nextRangeId(),
    label: options.label ?? '未命名范围',
    support: options.support ?? 'emulated',
    notes: options.notes ?? [],
    add(process: ManagedProcess): void {
      members.add(process)
    },
    remove(process: ManagedProcess): void {
      members.delete(process)
    },
    list(): readonly ManagedProcess[] {
      return [...members]
    },
    alive(): readonly ManagedProcess[] {
      return [...members].filter((member) => !member.finished)
    },
    async terminate(reason?: string): Promise<void> {
      const running = [...members].filter((member) => !member.finished)
      await Promise.all(running.map((member) => member.kill(reason)))
    },
  }
}
