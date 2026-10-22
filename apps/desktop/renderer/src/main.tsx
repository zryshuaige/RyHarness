import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { startApiTokenSync } from './api.ts'
import { ErrorBoundary, reportRenderCrash } from './components/ErrorBoundary.tsx'
import './styles.css'
import './styles-product.css'
import './styles-provider.css'
import './styles-memory.css'
import './styles-control.css'

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

// 最外层兜底：没有它，App 里任何一次渲染期抛错都会掀掉整棵树，#root 变成零子节点——
// 窗口里只剩一片底色（真机上就是这么白过一次的）。App 内部另有内容区边界，能局部救回。
// onError 记崩溃日志：没有它，崩溃在磁盘上不留痕，只能靠用户手点复制去捞。
createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary title="RyHarness 没能画出来" onError={reportRenderCrash}>
    <App />
  </ErrorBoundary>,
)
