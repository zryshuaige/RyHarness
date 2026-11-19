import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentDef,
  BackupFileView,
  BackupListView,
  MemoryHealthReport,
  MemoryRow,
  MemoryStats,
  ProviderInfo,
  TelemetrySnapshot,
  UsageReport,
  UserProfile,
} from '../api.ts'
import { copyText, openInFileManager } from '../lib/desktop.ts'
import { humanError } from '../lib/error-text.ts'
import { formatSize, formatTime } from '../lib/format.ts'
import { humanTokens, LOCAL_DATA_NOTE } from '../lib/humanize.ts'
import { toast } from '../lib/toast.ts'
import { loadAutoSpeak, saveAutoSpeak } from '../lib/voice.ts'
import { AnimalStudio, specOrDefault } from './AnimalStudio.tsx'
import { Avatar } from './avatars/Avatar.tsx'
import { Avatar3D } from './avatars/Avatar3D.tsx'
import { BRAND_AVATAR } from './avatars/avatars.tsx'
import { AvatarPicker } from './ContactsPage.tsx'
import { DocumentEngineSection } from './DocumentEngineSection.tsx'
import { type HostedApi, HostedSection } from './HostedSection.tsx'
import { Icon, type IconName } from './Icon.tsx'
import { KIND_LABELS, MemoryHealth } from './MemoryPanel.tsx'
import { Modal } from './Modal.tsx'
import type { ProviderApi } from './ProviderSettings.tsx'
import { ProviderSettings } from './ProviderSettings.tsx'
import { WorkspaceSection } from './WorkspaceSection.tsx'

interface MeApi extends ProviderApi, HostedApi {
  /**
   * 读本机的文档转换引擎状态。
   *
   * **可选**：测试替身不必实现——读不到时那一块显示一句说明，不该让整页报错。
   */
  documentEngines?(): Promise<{
    engine: { kind: 'word' | 'libreoffice' | 'none'; converterId: string; label: string }
  }>
  /**
   * 列工作区与未归属会话数。
   *
   * **可选**：测试替身不必实现这一条（界面上那一块拿不到就只显示默认目录）。
   */
  workspaces?(): Promise<{
    workspaces: Array<{
      id: string
      name: string
      rootPath: string
      createdAt: number
      sessionCount: number
      rootExists: boolean
    }>
    ungroupedSessionCount: number
  }>
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }>
  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }>
  workspace(): Promise<{ path: string }>
  /**
   * 个人资料。可选：服务端版本落后时缺这两条，用户卡退回写死的「你」并说明改不了，
   * 整页其余部分照常用——与下面 usage/memoryHealth 同一口径。
   */
  profile?(): Promise<{ profile: UserProfile }>
  saveProfile?(patch: Partial<UserProfile>): Promise<{ profile: UserProfile }>
  /**
   * 用量账单与记忆健康度要读的数据面。方法可选：缺任一条只会让对应区块显示一句
   * 说明（服务端版本落后时最常走这条路），不该让「我的」页报错或空着。
   */
  usage?(since?: number): Promise<UsageReport>
  memoryHealth?(): Promise<MemoryHealthReport>
  memoryStats?(): Promise<MemoryStats>
  telemetry?(limit?: number): Promise<TelemetrySnapshot>
  listArchivedMemories?(): Promise<{ items: MemoryRow[] }>
  /**
   * 一键备份整库。可选：服务端版本落后时整行不渲染（与 usage/memoryHealth 同一
   * 口径），而不是渲染一个点了必失败的按钮。
   */
  backup?(): Promise<{ path: string }>
  /**
   * 读最近备份清单。可选：旧版本服务端没有这条 GET，拿不到就只显示「上次备份」
   * 那一行，不渲染空清单（与 backup 同一口径）。
   */
  listBackups?(): Promise<BackupListView>
}

/** 「我的」页的二级路由。 */
export type MeSection =
  | 'profile'
  | 'assistant'
  | 'models'
  | 'cloud'
  | 'data'
  | 'usage'
  | 'plugins'
  | 'preferences'
  | 'about'

const ME_NAV: { key: MeSection; label: string; hint: string; icon: IconName }[] = [
  { key: 'profile', label: '个人资料', hint: '名字、头像与形象', icon: 'user' },
  { key: 'assistant', label: '助理', hint: '总管与共享画像', icon: 'sparkles' },
  { key: 'models', label: '模型与供应商', hint: 'Key、模型与探活', icon: 'blocks' },
  { key: 'cloud', label: '云成员', hint: 'Kimi Hosted Agents', icon: 'group' },
  { key: 'data', label: '工作区与数据', hint: '目录、备份与转换', icon: 'file' },
  { key: 'usage', label: '用量与记忆', hint: '账单与记忆健康度', icon: 'brain' },
  { key: 'plugins', label: '插件与能力', hint: '开关与说明', icon: 'blocks' },
  { key: 'preferences', label: '偏好', hint: '朗读、主题', icon: 'gear' },
  { key: 'about', label: '关于', hint: '版本与许可', icon: 'clipboard-list' },
]

/** 设置 Hub 的二级导航：九个去处，一处定义，MePage 与插件子页共用。 */
function SettingsNav({ active, onSelect }: { active: MeSection | 'all'; onSelect: (section: MeSection) => void }) {
  return (
    <nav className="me-nav" aria-label="设置">
      {ME_NAV.map((item) => {
        return (
          <button
            key={item.key}
            type="button"
            className={`me-nav-item${active === item.key ? ' is-active' : ''}`}
            aria-current={active === item.key ? 'page' : undefined}
            onClick={() => {
              onSelect(item.key)
            }}
          >
            <span className="me-nav-icon" aria-hidden="true">
              <Icon name={item.icon} size={16} />
            </span>
            <span className="me-nav-text">
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </button>
        )
      })}
    </nav>
  )
}

/** 设置 Hub 的外壳：标题、二级导航、独立滚动区。 */
export function SettingsShell({
  active,
  onSelect,
  children,
  scrollRef,
  legacy,
}: {
  active: MeSection | 'all'
  onSelect: (section: MeSection) => void
  children: ReactNode
  scrollRef?: RefObject<HTMLDivElement | null>
  legacy?: boolean
}) {
  return (
    <section className="page me-hub">
      <header className="page-header">
        <h2>我的</h2>
      </header>
      <div className="me-hub-body">
        <SettingsNav active={active} onSelect={onSelect} />
        <div className="page-scroll" ref={scrollRef}>
          <div className={`page-scroll-col me-page${legacy === true ? ' is-legacy' : ''}`} data-active-section={active}>
            {children}
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * 「我的」页：用户卡（你）、猫管家卡（Ryen，昵称可改）、我的形象、工作区、供应商、
 * 插件入口、用量账单、记忆健康度、自动朗读、外观主题、关于。
 *
 * 此前这一页只有一张卡，画的是 Ryen 的猫、写的是它的名字——页面叫「我的」，
 * 用户却找不到自己，编辑的还总是内置 agent 的名字。用户与 agent 是两件事，分开说。
 *
 * 这一页现在是一个设置 Hub：左边九项二级导航，右边只渲染当前那一段。
 * 之前它是一条 2,700px 的长滚动，模型供应商、云成员、用量都挤在同一列 520px 里。
 */
export function MePage({
  api,
  ryen,
  providers,
  agents,
  theme,
  onThemeChange,
  onRyenPatched,
  onAgentsChanged,
  onOpenPlugins,
  section,
  onSectionChange,
}: {
  api: MeApi
  ryen: AgentDef | undefined
  providers: ProviderInfo[]
  /** 云成员区块要把 agentId 映射回名字。 */
  agents?: AgentDef[]
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
  onRyenPatched?: () => void
  /** 雇佣/解雇云成员后刷新通讯录。 */
  onAgentsChanged?: () => void
  /** 跳到独立插件页。可选：只渲染页面的测试不必接这条导航。 */
  onOpenPlugins?: () => void
  /** 当前设置子页。缺省 = 嵌入模式：九段全部平铺。 */
  section?: MeSection
  onSectionChange?: (section: MeSection) => void
}) {
  const [shared, setShared] = useState<MemoryRow[] | undefined>(undefined)
  const [sharedError, setSharedError] = useState<string | undefined>(undefined)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  /**
   * 用户自己的名字与头像。此前这块是写死的「你」+ 一个随机色块——页面叫「我的」，
   * 用户却改不了自己叫什么，而这个名字是 agent 真正知道的那一个（服务端把它拼进
   * 系统提示），不是界面上的一行装饰。
   *
   * undefined = 服务端没有这条能力（老版本），用户卡退回只读形态并说明。
   */
  const [profile, setProfile] = useState<UserProfile | undefined>(undefined)
  const [profileReady, setProfileReady] = useState(false)
  const [avatarDraft, setAvatarDraft] = useState<string | undefined>(undefined)
  const [editingUser, setEditingUser] = useState(false)
  const [userNameDraft, setUserNameDraft] = useState('')
  // 与主题同一套存法（localStorage）：这是本机使用偏好，不该写进服务端配置。
  const [autoSpeak, setAutoSpeak] = useState(loadAutoSpeak)
  const activeSection: MeSection | 'all' = section ?? 'all'
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (section === undefined) return
    scrollRef.current?.scrollTo?.({ top: 0 })
  }, [section])
  useEffect(() => {
    if (api.profile === undefined) {
      setProfileReady(true)
      return
    }
    let alive = true
    api
      .profile()
      .then(({ profile: next }) => {
        if (!alive) return
        setProfile(next)
        setProfileReady(true)
      })
      .catch((error: unknown) => {
        // 读不出来不该挡住整页：退回到缺省资料，头像与名字仍可改（改的那次会再报）。
        if (!alive) return
        setProfile({ name: '你', avatar: '' })
        setProfileReady(true)
        toast.error(`个人资料没读出来：${humanError(error, '再试一次')}`)
      })
    return () => {
      alive = false
    }
  }, [api])
  useEffect(() => {
    if (ryen === undefined) return
    api
      .listAgentMemories(ryen.id)
      .then(({ shared: profile }) => {
        setShared(profile)
        setSharedError(undefined)
      })
      .catch((error: unknown) => {
        // 清空列表等于把「读不出来」说成「还没有画像」。
        setShared([])
        setSharedError(humanError(error, '共享画像没读出来，再试一次'))
      })
  }, [api, ryen])

  /**
   * 用户卡能不能改。加载没回来之前先按「不能」处理：那几秒里点下去会走一次注定
   * 失败的保存，与其给一个会回弹的按钮，不如先不亮。
   */
  const editable = profileReady && api.saveProfile !== undefined

  const saveName = async (): Promise<void> => {
    if (ryen === undefined) return
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed.length === 0 || trimmed === ryen.name) return
    try {
      await api.patchAgent(ryen.id, { name: trimmed })
    } catch (error) {
      toast.error(`改昵称失败：${humanError(error, '昵称没能存上，再试一次')}`)
      return
    }
    toast.success(`猫管家现在叫「${trimmed}」`)
    onRyenPatched?.()
  }

  /** 行内改名的提交。空串与缺省名「你」都不写：空名字会造出一个没有主语的用户。 */
  const commitUserName = async (): Promise<void> => {
    setEditingUser(false)
    const trimmed = userNameDraft.trim()
    if (trimmed.length === 0 || trimmed === profile?.name) return
    await saveProfile({ name: trimmed })
  }

  /** 存个人资料。失败就把草稿退回服务端那份，不让界面显示一个没存上的名字。 */
  const saveProfile = async (patch: Partial<UserProfile>): Promise<void> => {
    if (api.saveProfile === undefined) {
      toast.error('这个版本的服务端还不支持改个人资料，升级后就能改了。')
      return
    }
    const previous = profile
    // 乐观更新：改名字/头像不该等一个往返才有反馈；存失败时下面会把状态退回去。
    setProfile((prev) => {
      return { name: prev?.name ?? '你', avatar: prev?.avatar ?? '', ...patch }
    })
    try {
      const { profile: saved } = await api.saveProfile(patch)
      setProfile(saved)
      // 形象存上了给一句瞬态确认（D8）：面板里那枚「已保存」状态徽标随 key 重挂出现，
      // toast 再补一声「存上了」，两者都不伪装成控件。
      if (patch.avatar !== undefined) toast.success('形象已保存')
    } catch (error) {
      setProfile(previous)
      toast.error(`没存上：${humanError(error, '再试一次')}`)
    }
  }

  // 一键备份的界面态：进行中 / 成功路径 / 失败原因。路径要留在页面上——toast 一闪
  // 就没，而「备份在哪」恰恰是用户接下来要去找的东西。
  const [backingUp, setBackingUp] = useState(false)
  const [backupPath, setBackupPath] = useState<string | undefined>(undefined)
  const [backupError, setBackupError] = useState<string | undefined>(undefined)
  // 备份清单：把「最近 10 份留在这里」真的列出来。undefined = 服务端没这条能力
  // 或还没读回（不渲染空清单）；读到了即便是空数组也渲染目录入口。
  const [backups, setBackups] = useState<BackupFileView[] | undefined>(undefined)
  const [backupsDir, setBackupsDir] = useState<string | undefined>(undefined)

  /** 读最近备份清单；可选能力，读不到就静默退回只显示「上次备份」那一行。 */
  const refreshBackups = useCallback(async (): Promise<void> => {
    if (api.listBackups === undefined) return
    try {
      const { dir, backups: list } = await api.listBackups()
      setBackupsDir(dir)
      setBackups(Array.isArray(list) ? list : [])
    } catch {
      // 清单读不到不该让备份区块报错——「立即备份」仍然可用。
    }
  }, [api])

  useEffect(() => {
    void refreshBackups()
  }, [refreshBackups])

  /** 立即备份整库（会话+记忆+进化都在一个库里，一份即全部）。 */
  const runBackup = async (): Promise<void> => {
    if (api.backup === undefined || backingUp) return
    setBackingUp(true)
    setBackupError(undefined)
    try {
      const { path } = await api.backup()
      setBackupPath(path)
      toast.success('备份完成')
      // 新备份落盘后刷新清单，让用户立刻看到它排在最上。
      void refreshBackups()
    } catch (error) {
      setBackupError(humanError(error, '备份没能完成，再试一次'))
      toast.error(`备份失败：${humanError(error, '再试一次')}`)
    } finally {
      setBackingUp(false)
    }
  }

  /** 打开备份目录；浏览器形态没有主进程桥就复制路径（与工作区同一口径）。 */
  const openBackupsDir = async (): Promise<void> => {
    if (backupsDir === undefined) return
    if (!(await openInFileManager(backupsDir))) {
      await copyText(backupsDir)
      toast.info('这个环境打不开本地目录，路径已复制')
    }
  }

  return (
    <>
      <SettingsShell
        active={activeSection}
        onSelect={(next) => {
          onSectionChange?.(next)
          if (next === 'plugins') onOpenPlugins?.()
        }}
        scrollRef={scrollRef}
        {...(section === undefined ? { legacy: true } : {})}
      >
        {/* ---- 个人卡：这一页的头一块 ---- */}
        <div className="me-usercard" data-section="profile">
          <div className="me-usercard-main">
            <button
              type="button"
              className="me-avatar me-avatar-btn"
              aria-label={editable ? '换头像' : '换头像（这个版本的服务端还不支持）'}
              title={editable ? '换头像' : '这个版本的服务端还不支持改头像'}
              disabled={!editable}
              onClick={() => {
                setAvatarDraft(profile?.avatar === '' ? BRAND_AVATAR : (profile?.avatar ?? BRAND_AVATAR))
              }}
            >
              <Avatar3D
                avatarKey={profile?.avatar}
                name={profile?.name ?? '你'}
                seed="you"
                size={72}
                tilt
                action="breathing"
              />
              {/* 角标常驻：只靠悬停才冒出来的话，第一次来的人不知道这张脸可以点。
                    服务端不支持改头像时**不画这个角标**——一个点不动的铅笔角标比没有更让人
                    以为这功能坏了（按钮本身已经 disabled）。 */}
              {editable && (
                <span className="me-avatar-edit" aria-hidden="true">
                  <Icon name="pencil" size={14} />
                </span>
              )}
            </button>
            <div className="me-usercard-body">
              {editingUser ? (
                <input
                  className="me-name-inline"
                  value={userNameDraft}
                  aria-label="你的名字"
                  // biome-ignore lint/a11y/noAutofocus: 点击名字进入行内编辑，聚焦输入框是预期行为
                  autoFocus
                  maxLength={32}
                  onChange={(e) => {
                    setUserNameDraft(e.target.value)
                  }}
                  onBlur={() => {
                    void commitUserName()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitUserName()
                    if (e.key === 'Escape') setEditingUser(false)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="me-name me-inline-edit"
                  title={editable ? '改你的名字' : '这个版本的服务端还不支持改名字'}
                  disabled={!editable}
                  onClick={() => {
                    setUserNameDraft(profile?.name ?? '你')
                    setEditingUser(true)
                  }}
                >
                  {profile?.name ?? '你'}
                  {editable && <Icon name="pencil" size={16} className="me-pencil" />}
                </button>
              )}
              <p className="me-sub">这台电脑上的使用者</p>
              <p className="me-hint">改过的名字会随对话一起告诉每位助理。</p>
            </div>
          </div>
          {/* 存储口径说得挺长，但它说的是这台机器而不是这个人：放在卡片最下面
                的一行小字里，不跟名字抢位置。 */}
          <p className="me-note">{LOCAL_DATA_NOTE}</p>
        </div>

        {/* ---- 我的形象：一只可定制的立体动物 ---- */}
        <div className="me-section" data-section="profile">
          <AnimalStudio
            // 资料是异步读回来的：key 让面板在资料到达时重挂一次，草稿就是
            // 用户存好的那一只（而不是先停在默认狗上）。
            key={profile?.avatar ?? 'no-avatar'}
            current={specOrDefault(profile?.avatar)}
            savedAvatar={profile?.avatar}
            pending={!profileReady}
            disabled={!editable}
            onSave={(avatar) => {
              void saveProfile({ avatar })
            }}
            onPickOther={() => {
              setAvatarDraft(profile?.avatar === '' ? BRAND_AVATAR : (profile?.avatar ?? BRAND_AVATAR))
            }}
          />
        </div>

        {/* ---- 助理 ---- */}
        <div className="me-section" data-section="assistant">
          <h3 className="me-group-title">助理</h3>
          <div className="me-list">
            {ryen !== undefined && (
              <div className="me-row me-butler">
                <Avatar avatarKey={ryen.avatar} name={ryen.name} seed={ryen.id} size={44} />
                <div className="me-row-body">
                  {editingName ? (
                    <input
                      className="me-name-inline"
                      value={nameDraft}
                      aria-label="猫管家昵称"
                      // biome-ignore lint/a11y/noAutofocus: 点击昵称进入行内编辑，聚焦输入框是预期行为
                      autoFocus
                      onChange={(e) => {
                        setNameDraft(e.target.value)
                      }}
                      onBlur={() => {
                        void saveName()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveName()
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="me-row-title me-inline-edit"
                      title="给它改个昵称"
                      onClick={() => {
                        setNameDraft(ryen.name)
                        setEditingName(true)
                      }}
                    >
                      {ryen.name} <Icon name="pencil" size={16} className="me-pencil" />
                    </button>
                  )}
                  <div className="me-row-sub">总管助理</div>
                </div>
                <span className="me-tag">内置</span>
              </div>
            )}

            {/* 它对我了解多少：单独一块，和上面的身份行之间隔一根线。 */}
            <div className="me-row me-row-block">
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="user" size={16} /> {ryen?.name ?? 'Ryen'} 了解你
                </div>
                <div className="me-row-sub">它从你们的对话里记住的事，每轮都会带上。</div>
                {sharedError !== undefined ? (
                  <p className="apikey-error" role="alert" style={{ marginTop: 8 }}>
                    共享画像没读出来：{sharedError}
                  </p>
                ) : shared === undefined ? (
                  <div className="me-skeleton" role="status" aria-label="正在读画像">
                    <span className="skeleton" style={{ width: '70%', height: 12 }} />
                    <span className="skeleton" style={{ width: '45%', height: 12 }} />
                  </div>
                ) : shared.length === 0 ? (
                  <p className="me-row-note">还没有画像，聊几轮就有了。</p>
                ) : (
                  <ul className="memory-list" style={{ marginTop: 8 }}>
                    {shared.map((memory) => (
                      <li key={memory.id} className="memory-row">
                        <span className={`memory-kind kind-${memory.kind}`}>{KIND_LABELS[memory.kind]}</span>
                        <span className="memory-content">{memory.content}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ---- 这台电脑 ---- */}
        <div className="me-section" data-section="data">
          <h3 className="me-group-title">这台电脑</h3>
          <div className="me-list">
            <WorkspaceSection api={api} />
            <DocumentEngineSection api={api} />
            {api.backup !== undefined && (
              <div className="me-row me-row-block">
                <div className="me-row-body">
                  <div className="me-row-title">
                    <Icon name="copy" size={16} /> 数据备份
                  </div>
                  <div className="me-row-sub">把全部会话与记忆导出成一个文件，保留最近 10 份，列在下面。</div>
                  {backupPath !== undefined && (
                    <p className="me-path" data-testid="backup-path">
                      上次备份：{backupPath}
                    </p>
                  )}
                  {backupError !== undefined && (
                    <p className="apikey-error" role="alert">
                      备份失败：{backupError}
                    </p>
                  )}
                  {backups !== undefined && (
                    <div className="backup-history">
                      <div className="backup-history-head">
                        <span className="backup-history-title">最近备份（{backups.length}）</span>
                        <button
                          type="button"
                          className="btn btn-mini"
                          disabled={backupsDir === undefined}
                          onClick={() => {
                            void openBackupsDir()
                          }}
                        >
                          打开目录
                        </button>
                      </div>
                      {backups.length === 0 ? (
                        <p className="backup-history-empty">还没备份过。点「立即备份」导出第一份。</p>
                      ) : (
                        <ul className="backup-list">
                          {backups.map((file) => (
                            <li key={file.path} className="backup-item">
                              <span className="backup-item-time">{formatTime(file.at)}</span>
                              <span className="backup-item-size">{formatSize(file.size)}</span>
                              <code className="backup-item-name" title={file.path}>
                                {file.name}
                              </code>
                              <button
                                type="button"
                                className="btn btn-mini backup-item-copy"
                                title={`复制 ${file.name} 的路径`}
                                onClick={() => {
                                  void copyText(file.path).then((ok) => {
                                    toast.success(ok ? '路径已复制' : '复制失败，请手动选中复制')
                                  })
                                }}
                              >
                                复制路径
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-mini"
                  disabled={backingUp}
                  onClick={() => {
                    void runBackup()
                  }}
                >
                  {backingUp ? '备份中…' : '立即备份'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ---- 模型供应商 ---- */}
        {/* id 给「配置云端音色」这类跨页跳转当锚点：切到本页后滚到供应商区块。 */}
        <div className="me-section" id="provider-settings" data-section="models">
          <ProviderSettings
            api={api}
            providers={providers}
            onChanged={() => {
              onRyenPatched?.()
            }}
          />
        </div>

        {/* ---- 云成员（Kimi Hosted Agents） ---- */}
        <div className="me-section" data-section="cloud">
          <HostedSection
            api={api}
            {...(agents === undefined ? {} : { agents })}
            {...(onAgentsChanged === undefined ? {} : { onChanged: onAgentsChanged })}
          />
        </div>

        {/* ---- 用量与记忆 ---- */}
        <div className="me-section" data-section="usage">
          <h3 className="me-group-title">用量与记忆</h3>
          <div className="me-list">
            <div className="me-row me-row-block">
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="clipboard-list" size={16} /> 用量账单
                </div>
                <div className="me-row-sub">跨会话、跨供应商累计花了多少字，换模型前先在这里比一比。</div>
                <UsageLedger api={api} />
              </div>
            </div>
            <div className="me-row me-row-block">
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="brain" size={16} /> 记忆健康度
                </div>
                <div className="me-row-sub">长期记忆库的整体状态；单个助理的条目在右栏记忆面板里。</div>
                <MemoryHealth api={api} />
              </div>
            </div>
          </div>
        </div>

        {/* ---- 偏好 ---- */}
        <div className="me-section" data-section="preferences">
          <h3 className="me-group-title">偏好</h3>
          <div className="me-list">
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="speaker" size={16} /> 助理回复时自动朗读
                </div>
                <div className="me-row-sub">单聊里说完一句就念一句；群聊不念。云端音色不可用时改用系统语音。</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSpeak}
                aria-label="助理回复时自动朗读"
                className="me-switch"
                onClick={() => {
                  const next = !autoSpeak
                  setAutoSpeak(next)
                  saveAutoSpeak(next)
                }}
              >
                <span className="me-switch-track" aria-hidden="true" />
                <span>{autoSpeak ? '已开启' : '已关闭'}</span>
              </button>
            </div>
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="sun" size={16} /> 外观主题
                </div>
                <div className="me-row-sub">现在是{theme === 'light' ? '暖琥珀浅色' : '暖黑暗色'}。</div>
              </div>
              <span className="theme-toggle" role="radiogroup" aria-label="主题">
                {/* biome-ignore lint/a11y/useSemanticElements: 胶囊式单选，原生 radio 的样式无法套用 .theme-toggle button */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'light'}
                  className={theme === 'light' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('light')
                  }}
                >
                  <Icon name="sun" size={16} /> 浅色
                </button>
                {/* biome-ignore lint/a11y/useSemanticElements: 同上 */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'dark'}
                  className={theme === 'dark' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('dark')
                  }}
                >
                  <Icon name="moon" size={16} /> 暗色
                </button>
              </span>
            </div>
          </div>
        </div>

        <div className="me-section" data-section="about">
          <h3 className="me-group-title">关于</h3>
          <div className="me-list">
            <div className="me-row me-row-block">
              <AboutContent />
            </div>
          </div>
        </div>
      </SettingsShell>
      {avatarDraft !== undefined && (
        <Modal
          title="换头像"
          onClose={() => {
            setAvatarDraft(undefined)
          }}
        >
          <div className="provider-form">
            <AvatarPicker
              value={avatarDraft}
              onChange={(next) => {
                setAvatarDraft(next)
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAvatarDraft(undefined)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const chosen = avatarDraft
                  setAvatarDraft(undefined)
                  if (chosen !== undefined && chosen !== profile?.avatar) {
                    void saveProfile({ avatar: chosen })
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/** 账单一次最多列出的行数；再多折叠成一句「另有 N 项」。 */
const LEDGER_ROWS = 8

/** token 缩写：千位一位小数，1k 以下原样。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value)))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 账单的时间窗口。全部历史由服务端扫描全部消息；带 since 的窗口把统计收到
 * 「最近 N 天」——换模型前后比花销看的就是这个增量，口径写在界面上而不是藏在代码里。
 */
const LEDGER_WINDOWS = [
  { key: 'all', label: '全部历史', days: undefined },
  { key: '7d', label: '最近 7 天', days: 7 },
  { key: '30d', label: '最近 30 天', days: 30 },
] as const

type LedgerWindow = (typeof LEDGER_WINDOWS)[number]['key']

const DAY_MS = 86_400_000

/** 账单里的一行（两个维度投影成同一张表）。 */
interface LedgerRow {
  key: string
  label: string
  sub: string
  input: number
  output: number
  total: number
}

/** 按会话维度：标题 + 会话类型与模型调用次数。 */
function conversationRow(row: UsageReport['byConversation'][number]): LedgerRow {
  return {
    key: row.conversationId,
    label: row.title === '' ? '（未命名会话）' : row.title,
    sub: `${row.kind === 'group' ? '群聊' : '单聊'} · ${row.messages} 次模型调用`,
    input: row.input,
    output: row.output,
    total: row.total,
  }
}

/** 按供应商维度：显示名 + 花钱最多的几个发言 agent。 */
function providerRow(row: UsageReport['byProvider'][number]): LedgerRow {
  const names = row.agents.map((agent) => {
    return agent.name
  })
  return {
    key: row.provider,
    label: row.displayName,
    sub: names.length === 0 ? '发言方已删除' : names.join('、'),
    input: row.input,
    output: row.output,
    total: row.total,
  }
}

/**
 * 用量账单的形状守卫：这份 JSON 真的是账单吗？
 *
 * 见 {@link UsageLedger} 里的用法——形状对不上时整页崩掉是最差的结果。
 */
function isUsageReport(value: unknown): value is UsageReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Partial<UsageReport>
  if (!Array.isArray(report.byConversation) || !Array.isArray(report.byProvider)) return false
  const totals = report.totals
  if (typeof totals !== 'object' || totals === null) return false
  return typeof totals.total === 'number' && typeof totals.input === 'number' && typeof totals.output === 'number'
}

/**
 * 用量账单：跨会话、跨供应商的累计 token。此前只有右栏一行"本会话用了多少"，
 * 换个模型到底贵不贵、花在哪个会话，只能靠感觉。
 *
 * 数据来自 GET /api/usage：两个维度由服务端从同一批消息算出，合计恒等于 totals。
 * 此前这一块是渲染层逐会话翻「最近 200 条消息」自己加总的——超过单页上限的会话
 * 用量被静默丢掉，而且按供应商那一栏是客户端二次归因，两栏加总对不上看着像 bug。
 */
function UsageLedger({ api }: { api: MeApi }) {
  const [report, setReport] = useState<UsageReport | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [view, setView] = useState<'conversation' | 'provider'>('conversation')
  const [windowKey, setWindowKey] = useState<LedgerWindow>('all')

  useEffect(() => {
    if (api.usage === undefined) {
      setProblem('这版服务端还没有提供用量数据，账单暂时做不出来。')
      return
    }
    const scope = LEDGER_WINDOWS.find((item) => {
      return item.key === windowKey
    })
    let alive = true
    setReport(undefined)
    api
      .usage(scope?.days === undefined ? undefined : Date.now() - scope.days * DAY_MS)
      .then((next) => {
        if (!alive) return
        // 形状对不上就按「读不出来」处理。
        //
        // 服务端返回的东西不是只会在「请求失败」时不对——版本不匹配、代理吐了一份
        // 错误 JSON、磁盘读失败，它照样回 200。此前渲染层直接 `report.byConversation.map`，
        // 于是「我的」页整块白掉，用户只看到一句"这块页面没画出来"。这与这个文件里
        // 其它几处降级（服务端没这个方法、读失败）同一口径：形状不对也是一种读不出来。
        if (!isUsageReport(next)) {
          setReport(undefined)
          setProblem('用量账单格式对不上，这版服务端返回的不是账单。')
          return
        }
        setReport(next)
        setProblem(undefined)
      })
      .catch((error: unknown) => {
        // 统计读不出来就说读不出来：空表和"真的没用过 token"长得一模一样。
        if (!alive) return
        setReport(undefined)
        setProblem(`用量没读出来：${humanError(error, '再试一次，或先关掉这一页')}`)
      })
    return () => {
      alive = false
    }
  }, [api, windowKey])

  if (problem !== undefined) {
    return (
      <p className="me-row-note" role="alert" style={{ marginTop: 8 }}>
        {problem}
      </p>
    )
  }
  if (report === undefined) {
    // 加载中：骨架条 + 一句给读屏的话。空态与加载态长得一样的话，
    // 用户会以为这页没东西了。
    return (
      <div className="me-skeleton" role="status" aria-label="正在统计用量">
        <span className="skeleton" style={{ width: '60%', height: 12 }} />
        <span className="skeleton" style={{ width: '38%', height: 12 }} />
      </div>
    )
  }
  const buckets =
    view === 'conversation' ? report.byConversation.map(conversationRow) : report.byProvider.map(providerRow)
  const scopeLabel = LEDGER_WINDOWS.find((item) => {
    return item.key === windowKey
  })?.label
  return (
    <div className="usage-ledger">
      <p className="usage-total">
        累计 {humanTokens(report.totals.total)} · 输入 {humanTokens(report.totals.input)} · 输出{' '}
        {humanTokens(report.totals.output)}
        <span className="usage-scope">
          覆盖 {report.byConversation.length} 个会话 · {scopeLabel} · 只算模型回复的开销
        </span>
      </p>
      <div className="usage-tabs">
        {/* biome-ignore lint/a11y/useSemanticElements: 胶囊按钮组，fieldset 的默认边框与内边距套不上 .usage-tab 的样式 */}
        <span className="usage-tab-group" role="group" aria-label="统计维度">
          <button
            type="button"
            aria-pressed={view === 'conversation'}
            className={view === 'conversation' ? 'usage-tab is-active' : 'usage-tab'}
            onClick={() => {
              setView('conversation')
            }}
          >
            按会话
          </button>
          <button
            type="button"
            aria-pressed={view === 'provider'}
            className={view === 'provider' ? 'usage-tab is-active' : 'usage-tab'}
            onClick={() => {
              setView('provider')
            }}
          >
            按供应商
          </button>
        </span>
        <span className="usage-tab-sep" aria-hidden="true" />
        {/* biome-ignore lint/a11y/useSemanticElements: 同上 */}
        <span className="usage-tab-group" role="group" aria-label="统计窗口">
          {LEDGER_WINDOWS.map((item) => {
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={windowKey === item.key}
                className={windowKey === item.key ? 'usage-tab is-active' : 'usage-tab'}
                onClick={() => {
                  setWindowKey(item.key)
                }}
              >
                {item.label}
              </button>
            )
          })}
        </span>
      </div>
      {buckets.length === 0 ? (
        <p className="panel-empty">
          {windowKey === 'all' ? '还没有可统计的用量——聊一轮就会出现在这里。' : `最近 ${scopeLabel}还没有模型调用。`}
        </p>
      ) : (
        <>
          <ul className="usage-list">
            {buckets.slice(0, LEDGER_ROWS).map((bucket) => (
              <li key={bucket.key} className="usage-row">
                <span className="usage-name" title={bucket.label}>
                  {bucket.label}
                </span>
                <span className="usage-sub">{bucket.sub}</span>
                <span className="usage-total-num" title={`输入 ${bucket.input} · 输出 ${bucket.output}`}>
                  {formatTokens(bucket.total)}
                </span>
              </li>
            ))}
          </ul>
          {buckets.length > LEDGER_ROWS && <p className="usage-more">另有 {buckets.length - LEDGER_ROWS} 项未列出</p>}
        </>
      )}
    </div>
  )
}

/**
 * 关于弹窗正文。单独导出是为了能被测试直接断言——署名写错是最难靠肉眼复查、
 * 又最容易在重构里悄悄漂移的一处（此前就署着早已不用的 Fluent Emoji 与四个
 * DiceBear 家族）。只写**实际在用**的资产，数量以 renderer 的注册表为准。
 */
export function AboutContent() {
  return (
    <div className="about-body">
      <p>
        <strong>RyHarness</strong> v0.5.0 · 带人格的多 Agent 桌面工作台
      </p>
      <p>
        本体以 <strong>MIT License</strong> 发布（见仓库 LICENSE）。
      </p>
      <p className="about-heading">第三方资产与署名</p>
      <ul className="about-list">
        <li>
          界面图标：<strong>Lucide</strong>（ISC License）
        </li>
        <li>应用图标与猫管家形象：本仓库原创（随本项目 MIT）</li>
        <li>
          Agent 头像：<strong>DiceBear</strong>（框架 MIT；本地生成，不联网）
        </li>
        <li>
          CC BY 4.0 署名：DiceBear <strong>Dylan!</strong>（人物）by Natalia Spivak；DiceBear <strong>Fun Emoji</strong>
          （吉祥物）by Davis Uche
        </li>
        <li>Agent 内核：cordis / cosmokit / schemastery（MIT，vendor 自上游）</li>
      </ul>
      <p className="about-note">完整许可文本见仓库 NOTICE.md 与 vendor/*/LICENSE。</p>
    </div>
  )
}
