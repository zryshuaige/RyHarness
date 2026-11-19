/**
 * 通讯录里的一张助理卡（与列表行共用）。
 *
 * **为什么要单独成文件**：这张卡是通讯录里最重的一块——性格两条就是十几个 DOM 节点，
 * 加上头像、模型行、动作按钮，每张卡四十几个节点。原先它写在一个大组件的
 * `map` 里，于是**任何一次状态变化都会重渲全部卡片**：点一下「试听」，语音播放
 * 状态一变，三十张卡就跟着重画一遍——性能实测里这一项让每轮重渲成本翻倍
 * （10 位 0.72ms → 1.58ms，30 位 1.81ms → 4.32ms）。
 *
 * 现在这张卡是 memo 组件：只有「这位助理的数据变了」或「他在出声」这两件事会让它
 * 重画。点击回调不走 props，而是从一个稳定的 ref 里读（`handlers`）——父级每次
 * 渲染都会重建函数，把它们当 props 传下去，memo 就等于没开。
 *
 * **这一轮（P3）的两种形态**：
 * - `variant='row'`：通讯录默认视图。一行 64px：头像 40 + 名字/模型 + 两条性格 chip +
 *   亲密度 + hover/focus 才显现的动作。目的是「一屏能扫完更多人」。
 * - `variant='card'`：卡片视图。左对齐、紧凑 ~220px：头像 48、只读的 4px 性格尺、
 *   口头禅、发消息（outline H28）+ 溢出菜单。
 *
 * 两种形态共用同一套溢出菜单（听听/编辑/删除）与同一个身份色相环——身份只由
 * `--agent-hue` 喂头像环，名字保持中性（与聊天页的 D4 口径一致）。
 * @module @ryharness/desktop/renderer/components/ContactCard
 */

import { type CSSProperties, memo, useState } from 'react'
import type { AgentDef } from '../api.ts'
import { builtinBadge } from '../lib/agents.ts'
import { modelPair } from '../lib/humanize.ts'
import { affinityTier, clampTrait, NO_VOICE_ID, normalizePersona, TRAIT_META, traitBand } from '../lib/persona.ts'
import { stagger } from '../lib/stagger.ts'
import type { VoicePlayer } from '../lib/voice.ts'
import { Avatar3D } from './avatars/Avatar3D.tsx'
import { agentHues } from './avatars/avatars.tsx'
import { Icon } from './Icon.tsx'

/** 卡片底部动作条：顶到卡片下沿（网格里每张卡一样高）。 */
const cardActionsStyle: CSSProperties = { marginTop: 'auto' }

/**
 * 点击回调的稳定容器。
 *
 * 用 ref 装而不是直接当 props：父级每次渲染都重建这几个函数，直接传下去的话
 * memo 的浅比较永远不成立，卡片还是全量重画。读的时候取 `.current`，拿到的永远
 * 是最新那一份。
 */
export interface ContactCardHandlers {
  current: {
    onChat: (agentId: string) => void
    onEditAgent: (agent: AgentDef) => void
    onDeleteAgent: (agent: AgentDef) => void
  }
}

function ContactCardImpl({
  agent,
  index,
  speaking,
  voicePlayer,
  handlers,
  variant = 'card',
}: {
  agent: AgentDef
  /** 网格/列表里的序号（入场动画的错峰用）。 */
  index: number
  /** 这位正在出声（菜单项从「听听」变成「停止」）。 */
  speaking: boolean
  /** 试听播放器；无 DOM 环境里拿不到，按钮随之不可用。 */
  voicePlayer: VoicePlayer | undefined
  handlers: ContactCardHandlers
  /** row = 通讯录默认列表行；card = 紧凑卡片视图。 */
  variant?: 'card' | 'row'
}) {
  // 存量 agent 没有 persona 字段，读出来按默认人格渲染，卡片才不会空白。
  const persona = normalizePersona(agent.persona)
  const badge = builtinBadge(agent)
  const hasVoice = persona.voiceId !== NO_VOICE_ID
  const [menuOpen, setMenuOpen] = useState(false)
  /** 身份色相只喂头像环：名字/正文不上色（D4 口径）。 */
  const hueStyle = { '--agent-hue': agentHues(agent.id).graphic } as CSSProperties
  const model = modelPair(agent.provider, agent.model)
  /** 性格只取前两条：卡片/行都是扫一眼的密度，四个维度留给编辑弹窗。 */
  const traits = TRAIT_META.slice(0, 2).map((meta) => {
    const score = clampTrait(persona[meta.key])
    const band = traitBand(meta, score)
    return { meta, score, band, same: band.label === meta.label }
  })
  const openChat = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation()
    handlers.current.onChat(agent.id)
  }

  /** 身份行：名字按钮（键盘入口）+ 内置/云标记。两种形态共用。 */
  const title = (
    <>
      <button type="button" className="contact-open" title={`和 ${agent.name} 开聊`} onClick={openChat}>
        {agent.name}
      </button>
      {badge !== undefined && <span className="badge">{badge}</span>}
      {agent.runtime === 'hosted' && (
        <span className="badge badge-cloud" title="跑在 Kimi 的云沙箱里，关掉客户端也会继续工作">
          云
        </span>
      )}
    </>
  )

  /** 溢出菜单：听听/编辑/删除。放在动作条右端，菜单向上展开（贴着视口底部时不会被裁）。 */
  const moreMenu = (
    <div className="contact-more-wrap">
      <button
        type="button"
        className="btn btn-sm contact-more-btn"
        aria-label={`${agent.name} 的更多操作`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => {
          setMenuOpen((open) => {
            return !open
          })
        }}
      >
        <Icon name="ellipsis" size={16} />
      </button>
      <div className="contact-more-menu" role="menu" hidden={!menuOpen}>
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          disabled={!hasVoice}
          title={hasVoice ? `听听 ${agent.name} 的声音` : '这位还没选音色（编辑里能选）'}
          onClick={() => {
            setMenuOpen(false)
            if (voicePlayer === undefined) return
            if (speaking) {
              voicePlayer.stop()
              return
            }
            const text = persona.catchphrase.length > 0 ? persona.catchphrase : `我是${agent.name}。`
            void voicePlayer.speak({
              text,
              profileId: persona.voiceId,
              key: `agent-voice-${agent.id}`,
            })
          }}
        >
          {speaking ? '停止' : '听听'}
        </button>
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => {
            setMenuOpen(false)
            handlers.current.onEditAgent(agent)
          }}
        >
          编辑
        </button>
        {!agent.isBuiltin && (
          <button
            type="button"
            role="menuitem"
            className="menu-item is-danger"
            onClick={() => {
              setMenuOpen(false)
              handlers.current.onDeleteAgent(agent)
            }}
          >
            删除
          </button>
        )}
      </div>
    </div>
  )

  const avatar = (
    <span className="contact-avatar" style={hueStyle}>
      <Avatar3D
        avatarKey={agent.avatar}
        name={agent.name}
        seed={agent.id}
        size={variant === 'row' ? 40 : 48}
        tilt={variant === 'card'}
        // 正在出声（用户点了「听听」）的那一位说得上话：头像跟着动。
        // 其余卡片一律静止——一屏几十张脸一起动，界面就在发颤。
        action={speaking ? 'speaking' : 'idle'}
        temperament={{ extroversion: persona.extroversion, rigor: persona.rigor, humor: persona.humor }}
      />
    </span>
  )

  if (variant === 'row') {
    return (
      <article className="contact-row" style={stagger(index + 1)} data-clickable="true">
        {/* 整行可点 = 开聊，但不用 article 上的 onClick：在静态元素上挂点击既过不了
            键盘可达性，也会把行内的真实按钮变成嵌套交互。这里铺一枚透明的
            「拉平链接」按钮（stretched link），行内名字/动作按钮浮在它上面。
            键盘用户只走名字按钮，所以这枚不进 Tab 序列。 */}
        <button
          type="button"
          className="contact-hit"
          tabIndex={-1}
          aria-label={`和 ${agent.name} 开聊`}
          onClick={() => {
            handlers.current.onChat(agent.id)
          }}
        />
        {avatar}
        <span className="contact-row-body">
          <span className="contact-title contact-row-name">{title}</span>
          {/* 模型名是开发者单位：单行省略，完整值交给 title。 */}
          <span className="contact-model" title={model}>
            {model}
          </span>
        </span>
        {/* 性格 chip：只给档位名（「自来熟」比「外向 72」好懂），最多两条。 */}
        <span className="contact-traits contact-row-traits">
          {traits.map(({ meta, band }) => {
            return (
              <span key={meta.key} className="contact-trait-chip">
                {band.label}
              </span>
            )
          })}
        </span>
        <span className="contact-row-bond" title={`亲密度 ${persona.affinity}/100`}>
          亲密度 {persona.affinity}
        </span>
        <span className="contact-row-actions">
          <button type="button" className="btn btn-sm" onClick={openChat}>
            发消息
          </button>
          {moreMenu}
        </span>
      </article>
    )
  }

  return (
    <article className="contact-card" style={stagger(index + 1)} data-clickable="true">
      {/* 与列表行同一条「拉平链接」：卡面可点又不会让整卡变成嵌套交互。 */}
      <button
        type="button"
        className="contact-hit"
        tabIndex={-1}
        aria-label={`和 ${agent.name} 开聊`}
        onClick={() => {
          handlers.current.onChat(agent.id)
        }}
      />
      {avatar}
      <h3 className="contact-title">{title}</h3>
      <p className="contact-model" title={model}>
        {model}
      </p>
      {/* 性格两条：4px 只读尺（不是滑杆，没有拇指）。档位名那格永远占位——
          两条尺要一样长，否则长短会被「哪一行没字」带偏。 */}
      <dl className="contact-traits">
        {traits.map(({ meta, score, band, same }) => {
          return (
            <div key={meta.key} className="contact-trait" title={`${meta.label}：${band.label}（只读）`}>
              <dt>{meta.label}</dt>
              <dd>
                <span className="contact-trait-bar" aria-hidden="true">
                  <span style={{ width: `${score}%` }} />
                </span>
                <span className={`contact-trait-value${same ? ' is-empty' : ''}`}>{same ? '' : band.label}</span>
              </dd>
            </div>
          )
        })}
      </dl>
      {/* 口头禅：他常挂在嘴边的那句话，比系统提示更能让人记住这位是谁。 */}
      {persona.catchphrase.length > 0 && <p className="contact-catchphrase">「{persona.catchphrase}」</p>}
      <p className="provider-note contact-affinity">
        亲密度 {persona.affinity}/100 · {affinityTier(persona.affinity).label}
      </p>
      <div className="contact-actions" style={cardActionsStyle}>
        <button type="button" className="btn btn-sm" onClick={openChat}>
          发消息
        </button>
        {moreMenu}
      </div>
    </article>
  )
}

/**
 * 助理卡（memo）。
 *
 * props 全是稳定的引用时，只有这张卡自己的数据变了才会重画：点「试听」时，出声的
 * 那张卡重画，别人的一动不动。
 */
export const ContactCard = memo(ContactCardImpl)
