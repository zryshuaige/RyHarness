/** 应用图标组件：rail logo 与应用内标题栏使用（内联母版 SVG）。 */
export function AppIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="RyAgent">
      <defs>
        <linearGradient id="ryagent-icon-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <path fill="url(#ryagent-icon-bg)" d="M512 32 C742 32 992 172 992 512 C992 852 742 992 512 992 C282 992 32 852 32 512 C32 172 282 32 512 32 Z" />
      <path fill="#FFFDF8" d="M300 430 L258 218 L438 316 Z M724 430 L766 218 L586 316 Z" />
      <circle cx="512" cy="560" r="238" fill="#FFFDF8" />
      <circle cx="432" cy="540" r="26" fill="#3D2E12" />
      <circle cx="592" cy="540" r="26" fill="#3D2E12" />
      <path d="M498 620 h28 l-14 22 z" fill="#3D2E12" />
      <path d="M462 668 q50 42 100 0" stroke="#3D2E12" strokeWidth="22" fill="none" strokeLinecap="round" />
      <path fill="#3D2E12" d="M512 762 L436 716 L436 808 Z M512 762 L588 716 L588 808 Z" />
      <circle cx="512" cy="762" r="26" fill="#3D2E12" />
    </svg>
  )
}
