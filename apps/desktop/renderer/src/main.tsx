import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { startApiTokenSync } from './api.ts'
import './styles.css'
import './styles-product.css'
import './styles-provider.css'
import './styles-memory.css'

const splash = document.getElementById('splash')

// 先接上 token 通道再渲染：后端对每个请求强制校验，渲染层不带就是一片 401。
// 早于 React 挂载，App 首次发起的请求就已经带着它了。
startApiTokenSync()

if (splash !== null) {
  // 不依赖 rAF（窗口被遮挡时会被节流到永远不触发）；双 setTimeout + 兜底移除。
  setTimeout(() => {
    splash.classList.add('hide')
    setTimeout(() => {
      splash.remove()
    }, 360)
  }, 220)
  setTimeout(() => {
    splash.parentNode === null || splash.remove()
  }, 2500)
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
