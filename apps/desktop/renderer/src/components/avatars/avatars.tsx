/**
 * 预置 SVG 头像库：同一风格——圆形暖色底、圆头大色块、简洁线条。
 * 每个 avatar 是一个 64×64 viewBox 的 SVG 字符串（圆底 + 头部剪影）。
 * avatarKey 注册表供 Agent 定义引用；未知 key 回退首字符色块。
 */

export interface AvatarDef {
  key: string
  name: string
  /** 圆形底色（暖色系为主）。 */
  bg: string
  svg: string
}

function face(bg: string, inner: string): string {
  return `<circle cx="32" cy="32" r="30" fill="${bg}"/>${inner}`
}

const ink = '#4a2e1a'
const cream = '#fff4e4'
const white = '#fffdf8'

export const AVATARS: AvatarDef[] = [
  {
    key: 'cat', name: '橘猫', bg: '#F5A623',
    svg: face('#F5A623', `
      <path d="M15 22 L11 8 L25 14 Z" fill="#E8890C"/><path d="M49 22 L53 8 L39 14 Z" fill="#E8890C"/>
      <path d="M16.5 19 L14 11 L22.5 15 Z" fill="#FFD9B3"/><path d="M47.5 19 L50 11 L41.5 15 Z" fill="#FFD9B3"/>
      <circle cx="32" cy="35" r="20" fill="#F5AC5C"/>
      <ellipse cx="32" cy="41" rx="10" ry="7" fill="${cream}"/>
      <circle cx="25" cy="33" r="2.3" fill="${ink}"/><circle cx="39" cy="33" r="2.3" fill="${ink}"/>
      <path d="M30.6 38.4 h2.8 l-1.4 2z" fill="#D97B3F"/>
      <path d="M29.5 42 q2.5 2 5 0" stroke="${ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <ellipse cx="20" cy="39" rx="2.8" ry="1.8" fill="#FFC79E"/><ellipse cx="44" cy="39" rx="2.8" ry="1.8" fill="#FFC79E"/>`),
  },
  {
    key: 'corgi', name: '柴犬', bg: '#F0932B',
    svg: face('#F0932B', `
      <path d="M14 20 L10 6 L24 13 Z" fill="#D97F22"/><path d="M50 20 L54 6 L40 13 Z" fill="#D97F22"/>
      <circle cx="32" cy="35" r="20" fill="#F6A94F"/>
      <ellipse cx="32" cy="42" rx="11" ry="8" fill="${white}"/>
      <ellipse cx="32" cy="34" rx="7" ry="5" fill="${white}"/>
      <circle cx="25" cy="32" r="2.3" fill="${ink}"/><circle cx="39" cy="32" r="2.3" fill="${ink}"/>
      <ellipse cx="32" cy="38.5" rx="3" ry="2.2" fill="${ink}"/>
      <path d="M28.5 43 q3.5 3 7 0" stroke="${ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'fox', name: '狐狸', bg: '#F2752B',
    svg: face('#F2752B', `
      <path d="M13 24 L8 6 L26 15 Z" fill="#E0621F"/><path d="M51 24 L56 6 L38 15 Z" fill="#E0621F"/>
      <path d="M15 20 L12 10 L23 16 Z" fill="${ink}"/><path d="M49 20 L52 10 L41 16 Z" fill="${ink}"/>
      <circle cx="32" cy="35" r="20" fill="#F6863F"/>
      <path d="M18 36 Q32 30 46 36 Q44 48 32 50 Q20 48 18 36Z" fill="${white}"/>
      <circle cx="25" cy="32" r="2.3" fill="${ink}"/><circle cx="39" cy="32" r="2.3" fill="${ink}"/>
      <ellipse cx="32" cy="39" rx="2.8" ry="2" fill="${ink}"/>
      <path d="M28.5 43.5 q3.5 2.6 7 0" stroke="${ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'panda', name: '熊猫', bg: '#E7DFD2',
    svg: face('#E7DFD2', `
      <circle cx="16" cy="17" r="7" fill="#3A332C"/><circle cx="48" cy="17" r="7" fill="#3A332C"/>
      <circle cx="32" cy="35" r="20" fill="${white}"/>
      <ellipse cx="25" cy="32" rx="5" ry="6" transform="rotate(-18 25 32)" fill="#3A332C"/>
      <ellipse cx="39" cy="32" rx="5" ry="6" transform="rotate(18 39 32)" fill="#3A332C"/>
      <circle cx="25.5" cy="32" r="1.8" fill="${white}"/><circle cx="38.5" cy="32" r="1.8" fill="${white}"/>
      <ellipse cx="32" cy="41" rx="3" ry="2.2" fill="#3A332C"/>
      <path d="M28 45 q4 3 8 0" stroke="#3A332C" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <ellipse cx="20" cy="40" rx="2.6" ry="1.7" fill="#F6B8A8" opacity=".8"/><ellipse cx="44" cy="40" rx="2.6" ry="1.7" fill="#F6B8A8" opacity=".8"/>`),
  },
  {
    key: 'rabbit', name: '兔子', bg: '#F3C6C6',
    svg: face('#F3C6C6', `
      <ellipse cx="24" cy="12" rx="5.5" ry="11" fill="${white}"/><ellipse cx="40" cy="12" rx="5.5" ry="11" fill="${white}"/>
      <ellipse cx="24" cy="13" rx="2.6" ry="7.5" fill="#F3A9A9"/><ellipse cx="40" cy="13" rx="2.6" ry="7.5" fill="#F3A9A9"/>
      <circle cx="32" cy="37" r="19" fill="${white}"/>
      <circle cx="26" cy="35" r="2.2" fill="${ink}"/><circle cx="38" cy="35" r="2.2" fill="${ink}"/>
      <ellipse cx="32" cy="41" rx="2.4" ry="1.8" fill="#E58A8A"/>
      <path d="M32 43 v3 M32 46 q-3 2-5 .5 M32 46 q3 2 5 .5" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="22" cy="41" rx="2.6" ry="1.7" fill="#F6B8B8"/><ellipse cx="42" cy="41" rx="2.6" ry="1.7" fill="#F6B8B8"/>`),
  },
  {
    key: 'owl', name: '猫头鹰', bg: '#C98D5A',
    svg: face('#C98D5A', `
      <path d="M14 22 L12 10 L24 16 Z" fill="#A96F3E"/><path d="M50 22 L52 10 L40 16 Z" fill="#A96F3E"/>
      <circle cx="32" cy="35" r="20" fill="#D9A26B"/>
      <circle cx="25" cy="32" r="7" fill="${white}"/><circle cx="39" cy="32" r="7" fill="${white}"/>
      <circle cx="25" cy="32" r="3" fill="${ink}"/><circle cx="39" cy="32" r="3" fill="${ink}"/>
      <circle cx="26" cy="31" r="1" fill="${white}"/><circle cx="40" cy="31" r="1" fill="${white}"/>
      <path d="M30 39 l2 3.4 2-3.4z" fill="#E8890C"/>
      <path d="M22 44 q10 6 20 0" stroke="#B57E48" stroke-width="2" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'penguin', name: '企鹅', bg: '#7FA6B8',
    svg: face('#7FA6B8', `
      <circle cx="32" cy="34" r="20" fill="#3E5460"/>
      <ellipse cx="32" cy="40" rx="13" ry="12" fill="${white}"/>
      <circle cx="26" cy="30" r="2.2" fill="${ink}"/><circle cx="38" cy="30" r="2.2" fill="${ink}"/>
      <path d="M29 34 l3 3 3-3z" fill="#F2A03D"/>
      <path d="M20 26 q4-3 7-1 M37 25 q4-2 7 1" stroke="#3E5460" stroke-width="2.4" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'hamster', name: '仓鼠', bg: '#EFC883',
    svg: face('#EFC883', `
      <circle cx="17" cy="20" r="6.5" fill="#E5B368"/><circle cx="47" cy="20" r="6.5" fill="#E5B368"/>
      <circle cx="17" cy="20" r="3" fill="#F7DCA8"/><circle cx="47" cy="20" r="3" fill="#F7DCA8"/>
      <circle cx="32" cy="36" r="20" fill="#F2CD8D"/>
      <ellipse cx="24" cy="42" rx="5" ry="4" fill="#FBE3B8"/><ellipse cx="40" cy="42" rx="5" ry="4" fill="#FBE3B8"/>
      <circle cx="26" cy="32" r="2.2" fill="${ink}"/><circle cx="38" cy="32" r="2.2" fill="${ink}"/>
      <ellipse cx="32" cy="38.5" rx="2.2" ry="1.7" fill="#D98A7E"/>
      <path d="M28.5 42.5 q3.5 2.4 7 0" stroke="${ink}" stroke-width="1.7" fill="none" stroke-linecap="round"/>
      <path d="M12 36 h6 M12 40 h6 M46 36 h6 M46 40 h6" stroke="#D9A75E" stroke-width="1.5" stroke-linecap="round"/>`),
  },
  {
    key: 'koala', name: '考拉', bg: '#B9AE9F',
    svg: face('#B9AE9F', `
      <circle cx="16" cy="21" r="8" fill="#9E9384"/><circle cx="48" cy="21" r="8" fill="#9E9384"/>
      <circle cx="16" cy="21" r="4" fill="#E8B7B0"/><circle cx="48" cy="21" r="4" fill="#E8B7B0"/>
      <circle cx="32" cy="35" r="19" fill="#CFC6B8"/>
      <circle cx="26" cy="32" r="2.2" fill="${ink}"/><circle cx="38" cy="32" r="2.2" fill="${ink}"/>
      <ellipse cx="32" cy="38.5" rx="3.4" ry="2.6" fill="#6E6257"/>
      <path d="M28.5 43.5 q3.5 2.2 7 0" stroke="${ink}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'bot', name: '机器人', bg: '#E5B25C',
    svg: face('#E5B25C', `
      <line x1="32" y1="8" x2="32" y2="14" stroke="#A9772F" stroke-width="2.4"/>
      <circle cx="32" cy="7" r="2.8" fill="#F59E0B"/>
      <rect x="14" y="14" width="36" height="32" rx="14" fill="#F3D9A4"/>
      <rect x="14" y="14" width="36" height="32" rx="14" fill="none" stroke="#C9974A" stroke-width="2"/>
      <circle cx="25" cy="29" r="4" fill="#3D2E12"/><circle cx="39" cy="29" r="4" fill="#3D2E12"/>
      <circle cx="26" cy="28" r="1.2" fill="${white}"/><circle cx="40" cy="28" r="1.2" fill="${white}"/>
      <rect x="25" y="37" width="14" height="4.5" rx="2.2" fill="#3D2E12"/>
      <rect x="27.5" y="38.4" width="2" height="2" fill="#F3D9A4"/><rect x="32" y="38.4" width="2" height="2" fill="#F3D9A4"/>`),
  },
  {
    key: 'dragon', name: '龙', bg: '#E8845C',
    svg: face('#E8845C', `
      <path d="M20 18 l-3-8 7 4z M44 18 l3-8-7 4z" fill="#F2B84B"/>
      <circle cx="32" cy="35" r="20" fill="#EE9A6B"/>
      <path d="M20 24 q12-8 24 0" stroke="#D97742" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <circle cx="25" cy="33" r="2.4" fill="${ink}"/><circle cx="39" cy="33" r="2.4" fill="${ink}"/>
      <ellipse cx="32" cy="41" rx="9" ry="6.5" fill="#F7C9A3"/>
      <circle cx="28.5" cy="40" r=".9" fill="#B45F33"/><circle cx="32" cy="41.5" r=".9" fill="#B45F33"/><circle cx="35.5" cy="40" r=".9" fill="#B45F33"/>
      <path d="M26 44.5 q6 3.4 12 0" stroke="${ink}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`),
  },
  {
    key: 'deer', name: '鹿', bg: '#D9A06B',
    svg: face('#D9A06B', `
      <path d="M18 20 q-4-8 2-12 M18 20 q-8-4-10-10 M46 20 q4-8-2-12 M46 20 q8-4 10-10" stroke="#8A5A2E" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M15 22 L12 12 L22 17 Z" fill="#C78A50"/><path d="M49 22 L52 12 L42 17 Z" fill="#C78A50"/>
      <circle cx="32" cy="36" r="19" fill="#E4B47E"/>
      <circle cx="26" cy="33" r="2.3" fill="${ink}"/><circle cx="38" cy="33" r="2.3" fill="${ink}"/>
      <ellipse cx="32" cy="42" rx="6" ry="4.6" fill="#F3D3A8"/>
      <ellipse cx="32" cy="41" rx="2.6" ry="2" fill="#8A5A2E"/>
      <path d="M28 45.5 q4 2.4 8 0" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <circle cx="22" cy="24" r="1.3" fill="#F7E3C2"/><circle cx="42" cy="24" r="1.3" fill="#F7E3C2"/>`),
  },
  {
    key: 'whale', name: '鲸鱼', bg: '#8FB4C7',
    svg: face('#8FB4C7', `
      <path d="M10 38 Q10 20 32 20 Q54 20 54 36 Q54 48 40 50 L46 56 Q38 56 34 50 Q14 50 10 38Z" fill="#6E9BB4"/>
      <path d="M14 38 Q14 26 30 24 Q22 32 22 40 Q22 46 26 48 Q16 46 14 38Z" fill="#8FB4C7" opacity=".7"/>
      <circle cx="26" cy="33" r="2.3" fill="${ink}"/>
      <path d="M32 40 q4 3 9 1" stroke="#3E5460" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M44 26 q3-4 7-3" stroke="#6E9BB4" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <circle cx="38" cy="42" r="1.2" fill="#3E5460"/><circle cx="42" cy="40.5" r="1.2" fill="#3E5460"/>`),
  },
]

/** avatarKey → 定义。 */
export const AVATAR_BY_KEY: Readonly<Record<string, AvatarDef>> = Object.freeze(
  Object.fromEntries(AVATARS.map((avatar) => { return [avatar.key, avatar] })),
)

/** 首字符兜底色环（暖色系 12 色，按 seed 哈希取色）。 */
export const FALLBACK_COLORS = [
  '#F59E0B', '#F2752B', '#E8845C', '#D9A06B',
  '#C98D5A', '#EFC883', '#E5B25C', '#F3C6C6',
  '#B9AE9F', '#F2A03D', '#E58A7E', '#D98A7E',
] as const

export function fallbackColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length] as string
}
