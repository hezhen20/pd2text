import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { registerIpc, bindWindow } from './ipc'
import { applyDataRoot } from './paths'
import { initStore } from './store'

// 数据目录可能被用户改到别的盘（设置 → 存储）。userData 只能在 ready 之前改，
// 所以这一句必须放在最外层、创建窗口之前。
const dataRootState = applyDataRoot()
console.log(`[main] 数据目录：${dataRootState.root}${dataRootState.custom ? '（自定义）' : ''}`)

let mainWindow: BrowserWindow | null = null

/**
 * 加载失败时在窗口里显示一张说明页，而不是留一块白屏。
 * 最常见的两种：dev server 没起来（-102 ERR_CONNECTION_REFUSED）、端口被别的进程占了。
 */
function showLoadError(code: number, description: string, url: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const safe = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#F4F1EA;color:#1B1A17;
    font-family:"Songti SC","Noto Serif SC",Georgia,serif;}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;
    align-items:center;gap:18px;padding:48px;box-sizing:border-box;text-align:center;}
  .kicker{font:11px/1 ui-monospace,Consolas,monospace;letter-spacing:.22em;
    text-transform:uppercase;color:#B23C26;}
  h1{font-size:26px;font-weight:500;margin:0;letter-spacing:.02em;}
  p{margin:0;max-width:640px;line-height:1.85;font-size:14px;color:#4A4640;}
  code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;
    background:rgba(27,26,23,.06);padding:2px 6px;border-radius:2px;}
  .meta{font:11px/1.7 ui-monospace,Consolas,monospace;color:#8A8272;letter-spacing:.06em;}
  hr{width:64px;border:0;border-top:1px solid rgba(27,26,23,.18);margin:2px 0;}
</style></head><body><div class="wrap">
  <div class="kicker">LOAD FAILED</div>
  <h1>页面没能加载出来</h1>
  <hr>
  <p>开发模式下窗口加载的是 Vite 开发服务器。它没就绪、端口被占用或进程被中断时会走到这里。<br>
     回到终端确认上面没有报错，然后重新运行 <code>npm run dev</code>；若提示端口被占用，
     先结束残留的 <code>electron</code> / <code>vite</code> 进程。</p>
  <div class="meta">${safe(String(code))} · ${safe(description)}<br>${safe(url)}</div>
</div></body></html>`
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

function createWindow(): void {
  const mac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#F4F1EA',
    title: '誊声 · 播客文字稿工作台',
    titleBarStyle: 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: '#F4F1EA', symbolColor: '#1B1A17', height: 48 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程进沙箱：即使页面被注入脚本，也拿不到 Node 能力，
      // 只能走 preload 里那张白名单通道表。
      sandbox: true,
      spellcheck: false
    }
  })

  // 显示窗口：正常情况下 ready-to-show 就够了，但它依赖“首帧已绘制”，
  // 一旦页面白屏 / dev server 还没起来就永远不会触发，窗口会一直藏在 show:false 后面
  // （现象就是「终端说启动成功，桌面没反应」）。这里三路兜底，确保窗口一定露脸。
  let revealed = false
  const reveal = (): void => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return
    revealed = true
    mainWindow.show()
  }

  const fallbackTimer = setTimeout(reveal, 3000)
  mainWindow.on('closed', () => clearTimeout(fallbackTimer))

  mainWindow.on('ready-to-show', () => {
    clearTimeout(fallbackTimer)
    reveal()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    clearTimeout(fallbackTimer)
    reveal()
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[main] 页面加载失败 ${code} ${description} → ${url}`)
    reveal()
    showLoadError(code, description, url)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] 渲染进程退出：', details.reason)
  })

  // 调试用：Ctrl/⌘ + Shift + I 或 F12 打开渲染进程 DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const toggle = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'
    if (toggle || input.key === 'F12') {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 拦住页面内的整页跳转：只允许留在当前 origin（dev 下 HMR 会重载同源页面），
  // 其余一律丢给系统浏览器，避免窗口被导航到一个陌生的网页上。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    let sameOrigin = false
    try {
      sameOrigin = Boolean(current) && new URL(url).origin === new URL(current).origin
    } catch {
      sameOrigin = false
    }
    if (sameOrigin) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    console.log(`[main] 加载开发服务器 ${devUrl}`)
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  bindWindow(mainWindow)
}

app.whenReady().then(() => {
  initStore()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  // 主进程初始化失败（例如数据目录不可写）时，别静默退出
  console.error('[main] 启动失败：', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
