/**
 * 通讯录里的一张助理卡。
 *
 * **为什么要单独成文件**：这张卡是通讯录里最重的一块——性格四条就是 24 个 DOM 节点，
 * 加上头像、模型行、四个动作按钮，每张卡四十几个节点。原先它写在一个大组件的
 * `map` 里，于是**任何一次状态变化都会重渲全部卡片**：点一下「试听」，语音播放
 * 状态一变，三十张卡就跟着重画一遍——性能实测里这一项让每轮重渲成本翻倍
 * （10 位 0.72ms → 1.58ms，30 位 1.81ms → 4.32ms）。
 *
 * 现在这张卡是 memo 组件：只有「这位助理的数据变了」或「他在出声」这两件事会让它
 * 重画。点击回调不走 props，而是从一个稳定的 ref 里读（`handlers`）——父级每次
 * 渲染都会重建函数，把它们当 props 传下去，memo 就等于没开。
 * @module @ryharness/desktop/renderer/components/ContactCard
 */

import { type CSSProperties, memo } from 'react'
import type { AgentDef } from '../api.ts'
import { builtinBadge } from '../lib/agents.ts'
import { modelPair } from '../lib/humanize.ts'
import { affinityTier, clampTrait, NO_VOICE_ID, normalizePersona, TRAIT_META, traitBand } from '../lib/persona.ts'
import { stagger } from '../lib/stagger.ts'
import type { VoicePlayer } from '../lib/voice.ts'
import { Avatar3D } from './avatars/Avatar3D.tsx'
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
}: {
  agent: AgentDef
  /** 网格里的序号（入场动画的错峰用）。 */
  index: number
  /** 这位正在出声（按钮从「听听」变成「停止」）。 */
  speaking: boolean
  /** 试听播放器；无 DOM 环境里拿不到，按钮随之不可用。 */
  voicePlayer: VoicePlayer | undefined
  handlers: ContactCardHandlers
}) {
  // 存量 agent 没有 persona 字段，读出来按默认人格渲染，卡片才不会空白。
  const persona = normalizePersona(agent.persona)
  const badge = builtinBadge(agent)
  const hasVoice = persona.voiceId !== NO_VOICE_ID
  return (
    <article className="contact-card" style={stagger(index + 1)}>
      <Avatar3D avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={56} tilt />
      <h3>
        {agent.name}
        {badge !== undefined && <span className="badge">{badge}</span>}
      </h3>
      {/* 模型标识是开发者单位：直接上屏是「siliconflow / deepseek-ai/DeepSeek-V3」，
          走 humanize 的统一口径。 */}
      <p className="contact-model">{modelPair(agent.provider, agent.model)}</p>
      {/* 性格四条：这位助理什么脾气，一眼看完，比一句话省事。
          每条给「档位名」而不只是数字——「自来熟」比「外向 72」好懂。 */}
      <dl className="contact-traits">
        {TRAIT_META.map((meta) => {
          const score = clampTrait(persona[meta.key])
          const band = traitBand(meta, score)
          // 轴名与档位名撞了就只说一遍（外向 → 外向）：两处都印出来，
          // 那行看着像标签渲染重了。名片那边是同一条规则。
          const same = band.label === meta.label
          return (
            <div key={meta.key} className="contact-trait">
              <dt>{meta.label}</dt>
              <dd>
                <span className="contact-trait-bar" aria-hidden="true">
                  <span style={{ width: `${score}%` }} />
                </span>
                {same ? null : <span className="contact-trait-value">{band.label}</span>}
              </dd>
            </div>
          )
        })}
      </dl>
      {/* 口头禅：他常挂在嘴边的那句话，比系统提示更能让人记住这位是谁。 */}
      {persona.catchphrase.length > 0 && <p className="contact-catchphrase">「{persona.catchphrase}」</p>}
      <p className="provider-note">
        亲密度 {persona.affinity}/100 · {affinityTier(persona.affinity).label}
      </p>
      <div className="contact-actions" style={cardActionsStyle}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            handlers.current.onChat(agent.id)
          }}
        >
          发消息
        </button>
        {/* 听听他：每位助理都有自己的音色，念一句他自己的口头禅。
            音色是这位的「声音」，放在卡片上才看得见、也才用得上。 */}
        <button
          type="button"
          className="btn contact-voice"
          disabled={!hasVoice}
          title={hasVoice ? `听听 ${agent.name} 的声音` : '这位还没选音色（编辑里能选）'}
          onClick={() => {
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
          <Icon name={speaking ? 'square' : 'volume-2'} size={14} />
          {speaking ? '停止' : '听听'}
        </button>
        {/* 内置 agent 只锁删除（服务端本来就 409），不锁编辑：
            Ryen 是这个家里唯一一位一直在用的助理，把它钉死在出厂模型上
            等于让用户连换个便宜模型都得绕开产品。改完能存住，靠的是
            服务端「种子只补缺、不覆盖」那条，不是界面上的假象。 */}
        <button
          type="button"
          className="btn"
          onClick={() => {
            handlers.current.onEditAgent(agent)
          }}
        >
          编辑
        </button>
        {!agent.isBuiltin && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              handlers.current.onDeleteAgent(agent)
            }}
          >
            删除
          </button>
        )}
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
