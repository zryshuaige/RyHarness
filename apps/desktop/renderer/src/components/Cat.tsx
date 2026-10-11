/** Ryen 猫管家吉祥物（SVG 三态：idle / thinking / happy）。 */
export function Cat({ mood, size = 40 }: { mood: 'idle' | 'thinking' | 'happy'; size?: number }) {
  const starClass = mood === 'thinking' ? 'star fast' : mood === 'happy' ? 'star joy' : 'star'
  let eyes: string
  if (mood === 'happy') {
    eyes = '<path class="ink" d="M20.5 33 q3.5 -4.6 7 0"/><path class="ink" d="M36.5 33 q3.5 -4.6 7 0"/>'
  } else if (mood === 'thinking') {
    eyes = '<circle class="inkf" cx="25.5" cy="32" r="2.4"/><circle class="inkf" cx="39.5" cy="30.8" r="2.4"/>'
  } else {
    eyes = '<circle class="inkf" cx="24" cy="33" r="2.5"/><circle class="inkf" cx="40" cy="33" r="2.5"/>'
  }
  const mouth = mood === 'happy'
    ? '<path d="M26.5 40.5 q5.5 5.6 11 0 q-5.5 3 -11 0z" fill="#c2503a"/>'
    : '<path class="ink" d="M29 42 q3 2.4 6 0"/>'
  const svg = '<svg class="cat" width="' + size + '" height="' + size + '" viewBox="0 0 64 64">'
    + '<path class="' + starClass + '" d="M51 6 l2.4 5 5 2.4 -5 2.4 -2.4 5 -2.4 -5 -5 -2.4 5 -2.4z" fill="#FFC53D"/>'
    + '<path d="M14 24 L9.5 8.5 L25 14.5 Z" fill="#f0a45c"/><path d="M50 24 L54.5 8.5 L39 14.5 Z" fill="#f0a45c"/>'
    + '<path d="M15 20.5 L12.3 11 L22 15.2 Z" fill="#ffd9b3"/><path d="M49 20.5 L51.7 11 L42 15.2 Z" fill="#ffd9b3"/>'
    + '<ellipse cx="32" cy="37" rx="22" ry="19.5" fill="#f5ac6b"/>'
    + '<path d="M25 19.5 q3.2 3.2 0 6.4 M32 18.4 q3.2 3.2 0 6.4 M39 19.5 q3.2 3.2 0 6.4" stroke="#de8a3f" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    + '<ellipse cx="32" cy="43.5" rx="11.5" ry="8" fill="#fff4e4"/>'
    + eyes
    + '<path d="M30.4 39.2 h3.2 l-1.6 2.3z" fill="#d97b3f"/>'
    + mouth
    + '<ellipse cx="17.5" cy="41.5" rx="3.2" ry="2.1" fill="#ffc79e" opacity=".85"/><ellipse cx="46.5" cy="41.5" rx="3.2" ry="2.1" fill="#ffc79e" opacity=".85"/>'
    + '<path d="M10.5 37.5 h6.5 M10.5 42.5 h6.5 M47 37.5 h6.5 M47 42.5 h6.5" stroke="#e9a25f" stroke-width="1.6" stroke-linecap="round"/>'
    + '</svg>'
  return <span dangerouslySetInnerHTML={{ __html: svg }} aria-label={`Ryen ${mood}`} role="img" />
}

/** 非 Ryen agent 的圆形 emoji 头像。 */
const AVATAR_COLORS = ['#dbeafe', '#dcfce7', '#fce7f3', '#ede9fe', '#fef9c3', '#e0e7ff']

export function AgentAvatar({ agent, size = 36 }: { agent: { id: string; name: string; avatar?: string }; size?: number }) {
  if (agent.id === 'ryen') return <Cat mood="idle" size={size} />
  const color = AVATAR_COLORS[Math.abs(hash(agent.id)) % AVATAR_COLORS.length]
  return (
    <span className="agent-avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.52 }} role="img" aria-label={agent.name}>
      {agent.avatar ?? agent.name.slice(0, 1)}
    </span>
  )
}

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return h
}
