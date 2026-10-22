import { Avatar } from './Avatar.tsx'
import { AVATAR_SPEC } from './avatars.tsx'

interface Member {
  id: string
  name: string
  /** Agent 定义上的 avatar 字段（avatarKey）。 */
  avatar?: string
}

/**
 * 群聊九宫格拼图头像（微信规则：2 人左右各半，3 人品字，4 人 2×2，
 * 5–9 人 3×3 前 N 格按对角优先顺序填充，>9 取前 9）。
 * 实现：CSS Grid + gridArea，免 canvas。
 */
const LAYOUT: Record<number, string[]> = {
  1: ['1 / 1 / 2 / 2'],
  2: ['1 / 1 / 2 / 2', '1 / 2 / 2 / 3'],
  3: ['1 / 1 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'],
  4: ['1 / 1 / 2 / 2', '1 / 2 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'],
}

/** 5–9 人：3×3 按微信对角优先顺序取前 N 格。 */
function grid9(n: number): string[] {
  const order = [
    '1 / 1 / 2 / 2',
    '1 / 2 / 2 / 3',
    '2 / 1 / 3 / 2',
    '2 / 2 / 3 / 3',
    '1 / 3 / 2 / 4',
    '3 / 1 / 4 / 2',
    '2 / 3 / 3 / 4',
    '3 / 2 / 4 / 3',
    '3 / 3 / 4 / 4',
  ]
  return order.slice(0, n)
}

export function groupGridAreas(count: number): string[] {
  const n = Math.max(1, Math.min(count, 9))
  return LAYOUT[n] ?? grid9(n)
}

export function GroupAvatar({ members, size = 48 }: { members: Member[]; size?: number }) {
  const shown = members.slice(0, 9)
  const grid = groupGridAreas(shown.length)
  const cell = shown.length <= 4 ? size / 2 : size / 3
  return (
    <span
      className="avatar avatar-group"
      role="img"
      aria-label={`群聊（${members.length} 位成员）`}
      style={{
        width: size,
        height: size,
        display: 'grid',
        gridTemplateColumns: `repeat(${shown.length <= 4 ? 2 : 3}, 1fr)`,
        gridTemplateRows: `repeat(${shown.length <= 4 ? 2 : 3}, 1fr)`,
        gap: 2,
        padding: 2,
        // 缝隙的底色：没有它，gap 露出来的是页面底色（列表里是白底、暗色里是
        // 近黑），九宫格就散成一堆不相干的圆片而不是一张拼图。设计规范 §4.3
        // 写的就是 --bg-subtle——比 --bg-surface 略深一档，分得开但不抢戏。
        background: 'var(--bg-subtle)',
      }}
    >
      {shown.map((member, index) => (
        <span
          key={member.id}
          // 单格与头像同一套圆角规格（AVATAR_SPEC.radius），此前 2 人用 3px、
          // 3 人以上用 4px 的方格，和成员头像的圆形并排时是两种零件。
          style={{ gridArea: grid[index], overflow: 'hidden', borderRadius: AVATAR_SPEC.radius }}
        >
          <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={cell} />
        </span>
      ))}
    </span>
  )
}
