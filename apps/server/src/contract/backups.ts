/**
 * 备份域的只读响应契约：**形状的唯一真源**。
 *
 * GET /api/backups 把「最近 10 份」真的列给用户（此前界面文案承诺了清单却从不渲染，
 * 用户只能去文件管理器碰运气）。纯文件读的响应形状用接口钉住，routes/backup.ts 的
 * readBackupHistory 与渲染层 ApiClient.listBackups 共用同一份——手抄 drift 没有生存空间。
 * @module @ryharness/server/contract/backups
 */

/** 一份备份文件的只读视图（清单里的一项，不含内容）。 */
export interface BackupFileView {
  name: string
  path: string
  /** 修改时间（毫秒）：清单按它倒序，最新的在最上。 */
  at: number
  size: number
}

/** GET /api/backups 的响应：备份目录 + 最近备份清单（新→旧，最多 BACKUPS_KEPT 份）。 */
export interface BackupListView {
  dir: string
  backups: BackupFileView[]
}
