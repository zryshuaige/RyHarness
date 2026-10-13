import { Avatar } from './Avatar.tsx'

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
      }}
    >
      {shown.map((member, index) => (
        <span
          key={member.id}
          style={{ gridArea: grid[index], overflow: 'hidden', borderRadius: shown.length <= 2 ? 3 : 4 }}
        >
          <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={cell} />
        </span>
      ))}
    </span>
  )
}
