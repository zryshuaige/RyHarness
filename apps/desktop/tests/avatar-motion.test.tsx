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
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import { Avatar3D } from '../renderer/src/components/avatars/Avatar3D.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import {
  AVATAR_BREATHE_MIN_SIZE,
  AVATAR_MOTION_MIN_SIZE,
  avatarActionAllowed,
  avatarMotionOf,
  avatarMotionScale,
  avatarTemperamentOf,
} from '../renderer/src/lib/avatar-motion.ts'
import type { UiMessage } from '../renderer/src/store.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')

/** 一套中性的性格：幅度与节奏的基准。 */
const TEST_TEMPERAMENT = { extroversion: 50, rigor: 50, humor: 50 }

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
    expect(html).toContain('data-motion="speaking"')
  })

  it('说完的那一条：停下来（历史消息不该还在动）', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage(true)}
        fileUrl={fileUrl}
        agent={{ id: 'ryen', name: 'Ryen', avatar: 'cat' }}
      />,
    )
    expect(html).not.toContain('data-motion')
  })

  it('用户自己那一侧不动：动的是"这位正在回话"，不是"有人在打字"', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ ...agentMessage(false), senderType: 'user', senderId: 'user' }}
        fileUrl={fileUrl}
        agent={{ id: 'ryen', name: 'Ryen', avatar: 'cat' }}
      />,
    )
    expect(html).not.toContain('data-motion')
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

describe('动作包：每个动作都有名字、有动画、有用法', () => {
  it('五个动作各有各的标记，静止时什么都不挂', () => {
    // 动效挂在 data-motion 上：普通立绘与立体动物挂的是同一种标记，两条路都吃。
    const html = renderToStaticMarkup(
      <Avatar avatarKey="dog" name="柴犬" size={56} action="speaking" temperament={TEST_TEMPERAMENT} />,
    )
    expect(html).toContain('data-motion="speaking"')
    const idle = renderToStaticMarkup(<Avatar avatarKey="dog" name="柴犬" size={56} />)
    expect(idle).not.toContain('data-motion')
  })

  it('样式表里这五个动作各自有动画，且都在「减少动态效果」时被关掉', () => {
    const css = readFileSync(resolve(SRC, 'styles-avatar-motion.css'), 'utf8')
    for (const action of ['breathing', 'speaking', 'pondering', 'listening', 'greeting']) {
      // 要找的是**这条动作自己**的规则：此前 `is-speaking` 只出现在
      // `.avatar.is-breathing.is-speaking` 这条组合规则里，而组件每次只挂**一个**动作——
      // 「正在说」那张脸因此一直没动过。
      const solo = new RegExp(`\\[data-motion='${action}'\\]\\s*\\{[^}]*animation`)
      expect(css, `${action} 得有自己的动画规则`).toMatch(solo)
    }
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'))
    expect(reduced, '减少动态效果时所有动作都要被关掉').toContain('[data-motion]')
  })

  it('立体动物也接得上：那一支此前把动作整段丢了', () => {
    // 用户自选立体动物是默认路径；动作没往下传，于是默认形象的头像全是静止的。
    const html = renderToStaticMarkup(
      <Avatar3D avatarKey="an3d:fox:30" name="柴犬" size={56} action="breathing" temperament={TEST_TEMPERAMENT} />,
    )
    expect(html).toContain('data-motion="breathing"')
  })

  it('24–40px 的头像也做动作，但幅度打折（24px 上同样的 1.5px 是整张脸在抖）', () => {
    // 打字行那张头像此前是 28px、门槛却是 32px ——「正在想」那张脸其实一直是静止的。
    expect(avatarActionAllowed('pondering', 28)).toBe(true)
    expect(avatarActionAllowed('speaking', 20)).toBe(false)
    expect(avatarMotionScale(48)).toBe(1)
    expect(avatarMotionScale(28)).toBe(0.5)
    expect(avatarMotionScale(20)).toBe(0)
  })

  it('「在听」是底噪：幅度远小于说话，周期更长（不跟正在说的那位抢注意力）', () => {
    const profile = avatarTemperamentOf({ extroversion: 50, rigor: 50, humor: 50 })
    expect(profile.listen).toBeLessThan(profile.breathe)
    expect(profile.listenMs).toBeGreaterThan(profile.breatheMs)
  })

  it('打字行那位「正在想」的头像真的接上了动作', () => {
    const source = readFileSync(resolve(SRC, 'components/ChatView.tsx'), 'utf8')
    expect(source).toContain('action="pondering"')
  })

  it('小队面板：正在想 pondering、别人在说时 listening，正在说的那一位不动（输出区在动）', () => {
    const source = readFileSync(resolve(SRC, 'components/RyVibePage.tsx'), 'utf8')
    expect(source).toContain("action={speaking ? 'idle' : pondering ? 'pondering' : live ? 'listening' : 'idle'}")
  })
})
