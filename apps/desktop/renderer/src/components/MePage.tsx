import type { AgentDef, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'

/** 「我的」页：用户信息、主题切换、供应商状态、关于。 */
export function MePage({
  ryen,
  providers,
  theme,
  onThemeChange,
}: {
  ryen: AgentDef | undefined
  providers: ProviderInfo[]
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
}) {
  return (
    <section className="page">
      <header className="page-header">
        <h2>我的</h2>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col me-page">
          {ryen !== undefined && (
            <>
              <span className="me-avatar">
                <Avatar avatarKey={ryen.avatar} name={ryen.name} seed={ryen.id} size={96} />
              </span>
              <div className="me-name">{ryen.name}</div>
              <p className="me-sub">你的猫管家总管 · 内置 Agent</p>
            </>
          )}

          <div className="me-section">
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">外观主题</div>
                <div className="me-row-sub">暖琥珀浅色 / 暖黑暗色</div>
              </div>
              <span className="theme-toggle" role="radiogroup" aria-label="主题">
                <button className={theme === 'light' ? 'is-active' : ''} onClick={() => { onThemeChange('light') }}>☀️ 浅色</button>
                <button className={theme === 'dark' ? 'is-active' : ''} onClick={() => { onThemeChange('dark') }}>🌙 暗色</button>
              </span>
            </div>
            {providers.map((provider) => (
              <div key={provider.id} className="me-row">
                <div className="me-row-body">
                  <div className="me-row-title">
                    {provider.apiKeyConfigured ? '✓' : '⚠️'} {provider.displayName}
                  </div>
                  <div className="me-row-sub">
                    {provider.apiKeyConfigured
                      ? `已配置 key · ${provider.models.length} 个模型`
                      : '未配置 key——设置 SILICONFLOW_API_KEY 环境变量后重启'}
                  </div>
                </div>
              </div>
            ))}
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">关于 RyAgent</div>
                <div className="me-row-sub">精简 agent 内核 + 社交化桌面 · 本地数据 SQLite</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
