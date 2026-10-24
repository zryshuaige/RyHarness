// @vitest-environment jsdom
/**
 * 助理头像的动效：谁在动、动多大、什么时候不动。
 *
 * 钉的是三条硬规矩（调研 + 规范共同指向的）：
 * 1. **正在回话的那一位才动**。判据是消息本身（done=false），不是另接一份状态——
 *    服务端把消息标成 done 的那一刻，头像自然停下来。
 * 2. **同屏只许有一个在动**。列表里的头像一律静态：几十个头像一起呼吸，界面就在
 *    微微发颤，用户读不出"这位在说话"，只读得出"这里有点乱"。
 * 3. **小尺寸不缩放**。≤24px 的头像动起来是闪烁不是生命感。
 *
 * 另外钉住"性格决定表演"：同一个助理，外向的和严谨的动起来幅度与节奏不同——
 * 否则动画就成了全站统一的一层贴纸。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import {
  AVATAR_BREATHE_MIN_SIZE,
  AVATAR_MOTION_MIN_SIZE,
  avatarMotionOf,
  avatarTemperamentOf,
} from '../renderer/src/lib/avatar-motion.ts'
import type { UiMessage } from '../renderer/src/store.ts'

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

function agentMessage(done: boolean): UiMessage {
  return {
    key: 'm1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done,
    parts: [{ kind: 'text', text: '在的。' }],
  }
}

describe('头像动效：谁在动', () => {
  it('正在流式输出的那一条：头像跟着动', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage(false)}
        fileUrl={fileUrl}
        agent={{ id: 'ryen', name: 'Ryen', avatar: 'cat' }}
      />,
    )
    expect(html).toContain('is-speaking')
  })

  it('说完的那一条：停下来（历史消息不该还在动）', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage(true)}
        fileUrl={fileUrl}
        agent={{ id: 'ryen', name: 'Ryen', avatar: 'cat' }}
      />,
    )
    expect(html).not.toContain('is-speaking')
  })

  it('用户自己那一侧不动：动的是"这位正在回话"，不是"有人在打字"', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ ...agentMessage(false), senderType: 'user', senderId: 'user' }}
        fileUrl={fileUrl}
        agent={{ id: 'ryen', name: 'Ryen', avatar: 'cat' }}
      />,
    )
    expect(html).not.toContain('is-speaking')
  })
})

describe('头像动效：性格决定表演', () => {
  it('外向的说话幅度更大、节奏更快；严谨的呼吸更慢', () => {
    const loud = avatarTemperamentOf({ extroversion: 95, rigor: 20, humor: 50 })
    const calm = avatarTemperamentOf({ extroversion: 10, rigor: 95, humor: 50 })
    // 说话的位移与周期：外向的动得多、动得快。
    expect(loud.lift).toBeGreaterThan(calm.lift)
    expect(loud.sway).toBeGreaterThan(calm.sway)
    expect(loud.speakMs).toBeLessThan(calm.speakMs)
    // 呼吸周期：严谨的慢。
    expect(calm.breatheMs).toBeGreaterThan(loud.breatheMs)
  })

  it('幽默的思考时游走得更远', () => {
    const witty = avatarTemperamentOf({ extroversion: 50, rigor: 50, humor: 95 })
    const plain = avatarTemperamentOf({ extroversion: 50, rigor: 50, humor: 5 })
    expect(witty.ponder).toBeGreaterThan(plain.ponder)
  })

  it('同一个形象不管走哪个通道，脾性一致（柴犬就是那只柴犬）', () => {
    // 立绘 'dog' 与立体动物 'an3d:dog:0' 是同一只柴犬，不该因为画风不同换一副脾性。
    expect(avatarMotionOf('dog')).toBe('dog')
    expect(avatarMotionOf('an3d:dog:0')).toBe('dog')
    expect(avatarMotionOf('an3d:panda:0')).toBe('plain')
  })
})

describe('头像动效：尺寸红线', () => {
  it('小于门槛的尺寸不给动效（24px 的头像动起来是闪烁不是生命感）', () => {
    expect(AVATAR_MOTION_MIN_SIZE).toBeGreaterThanOrEqual(24)
    expect(AVATAR_BREATHE_MIN_SIZE).toBeGreaterThanOrEqual(48)
  })
})
