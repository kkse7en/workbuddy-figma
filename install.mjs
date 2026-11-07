#!/usr/bin/env node
/**
 * workbuddy-figma —— 一键安装
 *
 * 做四件事：
 *   1. 生成这台机器专属的配对 token
 *   2. 生成已配对的 Figma 伴生插件（返回需要导入的 manifest 路径）
 *   3. 把 MCP server 注册进 ~/.workbuddy/mcp.json（原有配置自动备份）
 *   4. 打印后续三步操作
 *
 * 用法：
 *   node install.mjs                 # 默认端口 3055
 *   node install.mjs --port 3060     # 换端口
 *   node install.mjs --dry-run       # 只看会改什么，不落盘
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { ensureToken, prepareCompanion } from './lib/companion.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WF_DIR = join(homedir(), '.workbuddy')
const MCP_FILE = join(WF_DIR, 'mcp.json')
const STATE_DIR = join(WF_DIR, 'workbuddy-figma')
const PLUGIN_DIR = join(homedir(), 'Documents', 'workbuddy-figma-plugin')
const FIGMA_SETTINGS = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Figma', 'settings.json')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const newId = args.includes('--new-id')
const register = args.includes('--register')
const portIndex = args.indexOf('--port')
const requestedPort = portIndex !== -1 ? Number(args[portIndex + 1]) : 3055
const SALT_FILE = join(STATE_DIR, 'companion-id-salt')

/** Figma 开着的时候写 settings.json，会在它退出时被整份覆盖，白忙一场。 */
const figmaRunning = () =>
  new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'tasklist' : 'pgrep', isWin ? ['/FI', 'IMAGENAME eq Figma.exe'] : ['-x', 'Figma'], {
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(isWin ? /Figma\.exe/i.test(out) : child.exitCode === 0))
  })

/**
 * 端口能不能拿来做桥。
 * 必须按双栈探测：别的 Figma 桥常常只占 127.0.0.1，而 Figma 里的 fetch 走 localhost
 * 会优先解析到 ::1 —— 只测 IPv4 会把这种端口误判成空闲，插件就永远连到别人身上。
 */
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen({ port, host: '::', ipv6Only: false })
  })

/**
 * 端口上跑的到底是不是「我们自己的桥」。
 * 同端口上可能躺着别的 Figma 桥（旧版 DSH / Codex），它们连 401 文案都一样，
 * 只能靠响应头标识区分，不能只看状态码。
 */
const isOurBridge = (port) =>
  new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      resolve(res.headers['x-workbuddy-figma'] === '1')
      res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })

let PORT = requestedPort
if (Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535) {
  for (let offset = 0; offset < 10; offset++) {
    const candidate = requestedPort + offset
    if (await portFree(candidate)) { PORT = candidate; break }
    if (await isOurBridge(candidate)) { PORT = candidate; break }
  }
}

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const info = (s) => console.log(`  \x1b[36m·\x1b[0m ${s}`)
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`)
const fail = (s) => {
  console.error(`\n  \x1b[31m✗ ${s}\x1b[0m\n`)
  process.exit(1)
}

/* 0. 环境检查 */
const major = Number(process.versions.node.split('.')[0])
if (major < 18) fail(`需要 Node.js 18 或更高版本，当前是 ${process.versions.node}`)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) fail(`端口无效：${PORT}`)

console.log('\n\x1b[1mworkbuddy-figma · 安装\x1b[0m\n')
info(`Node ${process.versions.node}`)
info(`项目目录 ${ROOT}`)
info(`桥接端口 ${PORT}` + (PORT !== requestedPort ? `（${requestedPort} 已被占用，自动改用 ${PORT}）` : ''))

/* 1. token + 伴生插件 */
const token = await ensureToken(STATE_DIR)
ok('配对 token 已就绪')

// Figma 按 manifest.id 去重，同 id 二次导入会报「文件名无效」。--new-id 换一个身份。
let idSalt = ''
try {
  idSalt = (await readFile(SALT_FILE, 'utf8')).trim()
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (newId || !idSalt) {
  idSalt = randomBytes(4).toString('hex')
  await writeFile(SALT_FILE, idSalt + '\n')
  ok(`插件 id 已更新（salt ${idSalt}）`)
}

const companion = await prepareCompanion({ root: ROOT, stateDir: STATE_DIR, token, port: PORT, idSalt, targetDir: PLUGIN_DIR })
ok(`Figma 插件已生成 → ${companion.folder}`)
const manifestId = JSON.parse(await readFile(companion.manifest, 'utf8')).id
info(`插件 id ${manifestId}`)

/**
 * 直接把插件写进 Figma 的插件列表，跳过「Import plugin from manifest」对话框。
 * 那个对话框对路径挑剔，报「文件名无效」时又给不出原因，绕开它最省事。
 * 必须关掉 Figma 再写，否则退出时会被覆盖。
 */
if (register) {
  if (!dryRun && (await figmaRunning()) && !args.includes('--force')) {
    fail(
      'Figma 正在运行。现在写注册表，会在 Figma 退出时被它整份覆盖。\n' +
        '     请完全退出 Figma（含托盘图标）后重跑：node install.mjs --register\n' +
        '     确实要现在写就加 --force，但基本不会生效。'
    )
  }
  const readSettings = async () => JSON.parse(await readFile(FIGMA_SETTINGS, 'utf8'))
  let settings
  try {
    settings = await readSettings()
  } catch (error) {
    fail(`读不到 Figma 配置（${FIGMA_SETTINGS}）：${error.message}`)
  }
  const list = Array.isArray(settings.localFileExtensions) ? settings.localFileExtensions : []
  // 清掉指向本目录的旧条目，避免重复堆叠
  const kept = list.filter((e) => !String(e.manifestPath || '').startsWith(PLUGIN_DIR))
  let nextId = kept.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0) + 1
  const manifestFileId = nextId++
  const codeFileId = nextId++
  const uiFileId = nextId++
  kept.push({
    id: manifestFileId,
    manifestPath: companion.manifest,
    lastKnownName: 'workbuddy-figma',
    lastKnownPluginId: manifestId,
    fileMetadata: { type: 'manifest', codeFileId, uiFileIds: [uiFileId] },
  })
  kept.push({ id: codeFileId, manifestPath: join(companion.folder, 'code.js'), fileMetadata: { type: 'code', manifestFileId } })
  kept.push({ id: uiFileId, manifestPath: join(companion.folder, 'ui.html'), fileMetadata: { type: 'ui', manifestFileId } })
  settings.localFileExtensions = kept

  if (dryRun) {
    info(`[dry-run] 会向 Figma 注册 ${kept.length} 条记录`)
  } else {
    const backup = `${FIGMA_SETTINGS}.bak-${Date.now()}`
    await copyFile(FIGMA_SETTINGS, backup)
    await writeFile(FIGMA_SETTINGS, JSON.stringify(settings, null, 2) + '\n')
    ok(`已写入 Figma 插件列表（备份 ${backup}）`)
    ok('重启 Figma 后，Plugins → Development 里会直接出现 workbuddy-figma')
  }
}

/* 2. 写 mcp.json */
let config = { mcpServers: {} }
let existed = false
try {
  config = JSON.parse(await readFile(MCP_FILE, 'utf8'))
  existed = true
} catch (error) {
  if (error.code !== 'ENOENT') fail(`读不了 ${MCP_FILE}：${error.message}`)
}
config.mcpServers ??= {}

// 官方的 Figma MCP 需要付费席位，改名停用，避免和本地桥冲突
const current = config.mcpServers.figma
if (current && typeof current.url === 'string' && current.url.includes('mcp.figma.com')) {
  config.mcpServers['figma-cloud'] = { ...current, disabled: true }
  delete config.mcpServers.figma
  warn('检测到 Figma 官方 MCP，已改名为 figma-cloud 并停用')
}

config.mcpServers.figma = {
  type: 'stdio',
  command: process.execPath,
  args: [join(ROOT, 'server.mjs')],
  cwd: ROOT,
  env: {
    CODEBUDDY_PROJECT_DIR: process.cwd(),
    FIGMA_BRIDGE_PORT: String(PORT),
  },
  defer_loading: false,
  disabled: false,
}
ok('MCP 配置已组装')

if (dryRun) {
  console.log('\n--- dry-run，不会写入。将要写入的内容 ---\n')
  console.log(JSON.stringify({ figma: config.mcpServers.figma }, null, 2))
  console.log('\n--- 结束 ---\n')
  process.exit(0)
}

if (existed) {
  const backup = `${MCP_FILE}.bak-${Date.now()}`
  await copyFile(MCP_FILE, backup)
  ok(`原配置已备份 → ${backup}`)
}
await writeFile(MCP_FILE, JSON.stringify(config, null, 2) + '\n')
ok(`MCP 配置已写入 → ${MCP_FILE}`)

/* 3. 后续步骤 */
console.log('\n\x1b[1m接下来三步\x1b[0m\n')
console.log('  1) 重启 WorkBuddy')
console.log('     MCP 配置只在启动时读取一次，不重启不会生效。\n')
console.log('  2) 在连接器管理里给 figma 点「信任」')
console.log('     自定义 MCP 需要手动授权，这是安全设计。\n')
if (register && !dryRun) {
  console.log('  3) 重启 Figma，直接运行已注册好的插件')
  console.log('     Plugins → Development → workbuddy-figma\n')
} else {
  console.log('  3) 在 Figma 桌面端导入插件并运行')
  console.log('     Plugins → Development → Import plugin from manifest…')
  console.log(`     选这个文件：\n     \x1b[36m${companion.manifest}\x1b[0m`)
  console.log('     如果对话框报「文件名无效」，改用：')
  console.log(`     \x1b[36mnode install.mjs --register\x1b[0m （先完全退出 Figma）\n`)
}

console.log('\x1b[1m验证\x1b[0m')
console.log('  在 WorkBuddy 里说一句「看看 Figma 连接状态」，或直接运行：')
console.log(`     node ${join(ROOT, 'selftest.mjs')}\n`)

console.log('\x1b[2m注意：生成的 companion 目录含本机配对凭证，不要提交或分享。\x1b[0m\n')
