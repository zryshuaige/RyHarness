/**
 * 默认工作区根目录的选址与一次性迁移。
 *
 * 工作区是 agent 文件工具的读写边界（沙箱围栏、产物落盘都跟着它走），默认不该
 * 埋在 C 盘 AppData 深处——用户找自己生成的文件要翻半天。本机有 F 盘就放
 * `F:\RyHarness\workspace`；没有 F 盘的机器回退旧默认（`<dataDir>\workspace`），
 * 行为与从前一致。`RYHARNESS_WORKSPACE_DIR` 显式指定时永远优先。
 *
 * 单独成模块是为了能单测：main.ts 一 import 就带进 electron，测试里跑不动，
 * 而这段逻辑恰恰是"用户生成的文件还在不在"的第一道保障（与 data-dir 同理）。
 *
 * @module apps/desktop/electron/workspace-dir
 */

import { join } from 'node:path'

/** 有 F 盘时的默认落点：产品名下的专用目录，给未来的产物/导出留位置。 */
export const PREFERRED_WORKSPACE_ROOT = 'F:\\RyHarness\\workspace'

/** 选址要用的文件系统探测（注入是为了能单测）。 */
export interface WorkspaceDirIo {
  /** 路径是否存在。 */
  exists: (path: string) => boolean
  /** 移动目录。 */
  move: (from: string, to: string) => void
}

/** resolveWorkspaceRoot 的入参。 */
export interface ResolveWorkspaceInput {
  /** 显式指定的工作区根（RYHARNESS_WORKSPACE_DIR），空串视为未指定。 */
  envRoot: string | undefined
  /** 数据目录（旧默认工作区在它下面）。 */
  dataDir: string
  /** F 盘根（`F:\`）是否存在。 */
  preferredDriveExists: boolean
}

/**
 * 定默认工作区根：显式环境变量 > F 盘产品目录 > 旧默认。
 *
 * 环境变量与既有 DATA_DIR 同一套取值口径（见 security.ts 的 envValue），
 * 这里只收已经取好的值，不自己读 process.env——主进程与测试注入都干净。
 */
export function resolveWorkspaceRoot(input: ResolveWorkspaceInput): string {
  if (input.envRoot !== undefined && input.envRoot.length > 0) return input.envRoot
  if (input.preferredDriveExists) return PREFERRED_WORKSPACE_ROOT
  return join(input.dataDir, 'workspace')
}

/** 一次迁移的结果。 */
export interface WorkspaceMigrationResult {
  /** 旧默认工作区是否搬过去了。 */
  migrated: boolean
  /** 没搬的原因 / 搬的过程中出的问题。 */
  reason?: string
}

/**
 * 把旧默认工作区（`<dataDir>\workspace`）搬到新根。
 *
 * 只在**新根不存在**时搬：新根已经存在就说明用户（或上一次启动）已经用上了，
 * 再搬等于拿旧文件盖新文件。显式指定了环境变量时也不搬——那是用户自己挑的
 * 地方，不该被默认选址的迁移动作碰。
 */
export function migrateDefaultWorkspace(
  input: {
    /** 旧默认工作区。 */
    from: string
    /** 新根。 */
    to: string
    /** 是否显式指定了环境变量（指定了就不迁）。 */
    envOverride: boolean
  } & WorkspaceDirIo,
): WorkspaceMigrationResult {
  if (input.envOverride) return { migrated: false, reason: 'env-override' }
  if (input.from === input.to) return { migrated: false, reason: 'same-path' }
  if (input.exists(input.to)) return { migrated: false, reason: 'new-exists' }
  if (!input.exists(input.from)) return { migrated: false, reason: 'no-legacy' }
  try {
    input.move(input.from, input.to)
  } catch (error) {
    return { migrated: false, reason: `move failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { migrated: true }
}
