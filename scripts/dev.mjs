import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// WorkBuddy / 某些终端会注入 ELECTRON_RUN_AS_NODE=1，导致 Electron 以纯 Node 模式启动、
// require('electron') 只返回可执行文件路径，app.whenReady 直接报 TypeError。
// 这里不光在 env 上 delete，还强制用干净的 node 直接执行 electron-vite 的 JS 入口
// （不走 shell/cmd），避免变量被 cmd 重新继承回注。

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'

console.log('')
console.log('  誊声 · ' + (mode === 'dev' ? '开发模式' : '生产预览'))
console.log('  ' + (mode === 'dev' ? '渲染层热更新已开启，主进程改动会自动重启 Electron' : '加载 out/ 中的生产构建'))
console.log('  Ctrl+Shift+I 或 F12 打开渲染层 DevTools')
console.log('  主进程日志会打印在下方')
console.log('  本机数据：用户目录 /AppData/Roaming/tengsheng/data（win）')
console.log('')

// 直接用 node 执行 electron-vite 的 JS 入口，而非 .cmd（.cmd 会经 cmd.exe 重新继承环境）。
const viteBin = path.join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [viteBin, mode], {
  stdio: 'inherit',
  env,
  shell: false
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
