#!/usr/bin/env node
/**
 * WorkBuddy Figma —— 一键安装
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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureToken, prepareCompanion } from './lib/companion.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WF_DIR = join(homedir(), '.workbuddy')
const MCP_FILE = join(WF_DIR, 'mcp.json')
const STATE_DIR = join(WF_DIR, 'workbuddy-figma')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const portIndex = args.indexOf('--port')
const PORT = portIndex !== -1 ? Number(args[portIndex + 1]) : 3055

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

console.log('\n\x1b[1mWorkBuddy Figma · 安装\x1b[0m\n')
info(`Node ${process.versions.node}`)
info(`项目目录 ${ROOT}`)
info(`桥接端口 ${PORT}`)

/* 1. token + 伴生插件 */
const token = await ensureToken(STATE_DIR)
ok('配对 token 已就绪')

const companion = await prepareCompanion({ root: ROOT, stateDir: STATE_DIR, token, port: PORT })
ok(`Figma 插件已生成 → ${companion.folder}`)

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
console.log('  3) 在 Figma 桌面端导入插件并运行')
console.log('     Plugins → Development → Import plugin from manifest…')
console.log(`     选这个文件：\n     \x1b[36m${companion.manifest}\x1b[0m`)
console.log('     然后在目标设计文件里运行「WorkBuddy Figma」，插件窗口别关。\n')

console.log('\x1b[1m验证\x1b[0m')
console.log('  在 WorkBuddy 里说一句「看看 Figma 连接状态」，或直接运行：')
console.log(`     node ${join(ROOT, 'selftest.mjs')}\n`)

console.log('\x1b[2m注意：生成的 companion 目录含本机配对凭证，不要提交或分享。\x1b[0m\n')
