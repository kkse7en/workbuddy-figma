#!/usr/bin/env node
/**
 * selftest.mjs —— 端到端自检
 *
 * 自己扮演两个角色：
 *   1. MCP 客户端（像 WorkBuddy 一样通过 stdio 发 JSON-RPC）
 *   2. 假 Figma 插件（按 /connect → /poll → /result 协议回话）
 * 用来验证桥接链路是否通，不需要真的打开 Figma。
 *
 * 用法： node selftest.mjs
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureToken } from './lib/companion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.SELFTEST_PORT || 3056)
const TOKEN = await ensureToken(join(homedir(), '.workbuddy', 'workbuddy-figma'))
const BASE = `http://127.0.0.1:${PORT}`
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  origin: 'https://www.figma.com',
}

let failures = 0
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!condition) failures++
}

/* ------------------------------------------------ 假 Figma 插件 */

const received = []
async function fakePlugin() {
  const connected = await fetch(`${BASE}/connect`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      clientId: randomUUID(),
      name: '自检画板',
      editorType: 'figma',
      fileKey: 'SELFTESTKEY',
      featureVersion: 3,
      companionVersion: '0.3.0',
    }),
  })
  const { connectionId } = await connected.json()
  if (!connectionId) throw new Error('connect 失败')
  console.log(`  · 假插件已连接 connectionId=${connectionId.slice(0, 8)}`)

  for (;;) {
    const polled = await fetch(`${BASE}/poll`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ connectionId }),
    })
    if (!polled.ok) return
    const job = await polled.json()
    if (job.idle) continue

    received.push({ method: job.method, args: job.args })
    console.log(`  · 收到任务 ${job.method}`)

    // 伪造一个 Figma 结果：get_selection 返回一个假图层
    const result =
      job.method === 'get_selection'
        ? {
            value: {
              page: { id: '0:1', name: 'Page 1' },
              selection: [{ id: '1:1', name: '自检矩形', type: 'RECTANGLE', width: 320, height: 120 }],
            },
            images: [],
          }
        : { value: { echo: job.method }, images: [] }

    await fetch(`${BASE}/result`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ connectionId, id: job.id, ok: true, result }),
    })
  }
}

/* ------------------------------------------------ MCP 客户端 */

const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  cwd: HERE,
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), CODEBUDDY_PROJECT_DIR: HERE },
  stdio: ['pipe', 'pipe', 'pipe'],
})
server.stderr.on('data', () => {}) // 服务端日志不参与断言

const waiting = new Map()
let buffer = ''
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const resolve = waiting.get(message.id)
    if (resolve) {
      waiting.delete(message.id)
      resolve(message)
    }
  }
})

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
    waiting.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

/* ------------------------------------------------ 跑测试 */

try {
  console.log('1) 握手')
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'selftest', version: '1' },
  })
  check('initialize 有结果', !!init.result, init.result?.serverInfo?.name)
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  console.log('2) 工具目录')
  const list = await rpc('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  check('工具数量为 21', names.length === 21, `实际 ${names.length}`)
  check('包含 use_figma', names.includes('use_figma'))
  check('包含 get_screenshot', names.includes('get_screenshot'))

  console.log('3) 无文档时的错误提示')
  const noDoc = await rpc('tools/call', { name: 'get_selection', arguments: {} })
  check('未连接时给出可读错误', noDoc.result?.isError === true, JSON.parse(noDoc.result?.content?.[0]?.text ?? '{}').error?.slice(0, 40))

  console.log('4) 假插件接入')
  const plugin = fakePlugin()
  plugin.catch(() => {})
  await new Promise((r) => setTimeout(r, 800))

  const status = await rpc('tools/call', { name: 'figma_status', arguments: {} })
  const statusValue = JSON.parse(status.result?.content?.[0]?.text ?? '{}')
  check('figma_status 看到 1 个文档', statusValue.documents?.length === 1, statusValue.documents?.[0]?.name)

  console.log('5) 真实任务往返')
  const selection = await rpc('tools/call', { name: 'get_selection', arguments: {} })
  const text = selection.result?.content?.[0]?.text ?? '{}'
  const parsed = JSON.parse(text)
  check('任务经桥下发并回收', parsed.selection?.[0]?.name === '自检矩形', text.slice(0, 80))
  check('插件侧确实收到 get_selection', received.some((r) => r.method === 'get_selection'))
} catch (error) {
  console.log(`  ✗ 异常：${error.message}`)
  failures++
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 200))
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}
