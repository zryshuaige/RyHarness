import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const splash = document.getElementById('splash')
if (splash !== null) {
  // 不依赖 rAF（窗口被遮挡时会被节流到永远不触发）；双 setTimeout + 兜底移除。
  setTimeout(() => {
    splash.classList.add('hide')
    setTimeout(() => { splash.remove() }, 360)
  }, 220)
  setTimeout(() => { splash.parentNode === null || splash.remove() }, 2500)
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
