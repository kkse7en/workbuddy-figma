#!/usr/bin/env node
/**
 * figma-bridge —— 把本地桥接层
 * 包成一个标准 MCP server，供 WorkBuddy 直接使用。
 *
 * 链路：
 *   WorkBuddy (MCP stdio client)
 *        ↓  JSON-RPC over stdio
 *   本文件 (LocalBridge)
 *        ↓  HTTP 长轮询 127.0.0.1:3055  /connect /poll /result
 *   Figma 伴生插件（WorkBuddy Figma，已配对）
 *        ↓  Figma Plugin API
 *   你正在编辑的 Figma 文档（真实读写，不消耗 Star 计划 MCP 额度）
 *
 * stdio 通道只允许出现 JSON-RPC，所有日志一律写 stderr。
 */
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { LocalBridge } from './lib/bridge.mjs'
import { LOCAL_TOOLS } from './lib/catalog.mjs'
import { readAssets, saveAssets, localResult } from './lib/assets.mjs'
import { ensureToken, prepareCompanion } from './lib/companion.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const STATE = join(homedir(), '.workbuddy', 'workbuddy-figma')
const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055)
const TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 120000)
const WORKSPACE = resolve(process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd())
const VERSION = '1.0.0'

const log = (...args) => process.stderr.write(`[figma-bridge] ${args.join(' ')}\n`)

/* ------------------------------------------------------------- 桥与状态 */

let companionCache = null

const token = await ensureToken(STATE)

async function ensureCompanion(port) {
  if (!companionCache) companionCache = await prepareCompanion({ root: ROOT, stateDir: STATE, token, port })
  return companionCache
}
let bridge = null
let bridgeError = null
let selectedId = null
const sessions = new Map()

try {
  bridge = new LocalBridge({ token, port: PORT, timeoutMs: TIMEOUT_MS })
  await bridge.start()
  log(`bridge listening on 127.0.0.1:${bridge.port}`)
} catch (error) {
  bridgeError = error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用（可能另一个 Figma 桥已在运行）` : String(error.message || error)
  log('bridge failed:', bridgeError)
}

function pickDocument() {
  if (!bridge) throw new Error(`Figma 桥未启动：${bridgeError}`)
  const docs = bridge.list()
  if (!docs.length) throw new Error('没有已连接的 Figma 文档。请在 Figma 桌面端运行「WorkBuddy Figma」插件并保持窗口打开。')
  if (selectedId) {
    const found = docs.find((d) => d.connectionId === selectedId)
    if (found) return found
    selectedId = null
  }
  if (docs.length === 1) {
    selectedId = docs[0].connectionId
    return docs[0]
  }
  // 同一个文件被开了两次插件（很常见）：直接取最近连接的那个，不必打断用户
  const names = new Set(docs.map((d) => d.name))
  if (names.size === 1) {
    const latest = docs[docs.length - 1]
    selectedId = latest.connectionId
    log(`同名文档有 ${docs.length} 个连接，自动使用最近的一个`)
    return latest
  }
  throw new Error(
    `当前有 ${docs.length} 个 Figma 文档连接：${docs.map((d) => `${d.name}(${d.connectionId.slice(0, 8)})`).join('、')}。` +
      `请先调用 figma_select_document 指定目标。`
  )
}

/* ---------------------------------------------------------------- 工具表 */

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } })

const META_TOOLS = [
  {
    name: 'figma_status',
    description: '查看当前连接的 Figma 文档、插件版本与桥接状态。第一次使用、或操作失败后先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const companion = await ensureCompanion(bridge?.port ?? PORT)
      return ok({
        bridgeRunning: !!bridge,
        bridgePort: bridge?.port ?? PORT,
        bridgeError,
        version: VERSION,
        documents: bridge?.list() ?? [],
        selected: selectedId,
        companionManifest: companion.manifest,
        workspace: WORKSPACE,
        next: bridge?.list()?.length
          ? '文档已连接，可以直接下指令。'
          : `在 Figma 桌面端 Plugins → Development → Import plugin from manifest… 导入 ${companion.manifest}，然后在目标文件运行「WorkBuddy Figma」。`,
      })
    },
  },
  {
    name: 'figma_setup',
    description: '生成本机已配对的 Figma 伴生插件，返回需要导入的 manifest.json 路径。首次使用或重装时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const companion = await ensureCompanion(bridge?.port ?? PORT)
      return ok({
        ...companion,
        instructions:
          'Figma 桌面端 → Plugins → Development → Import plugin from manifest… → 选中上面这个 manifest.json。' +
          '之后打开任意设计文件，运行「WorkBuddy Figma」，保持插件窗口打开即可自动连接。此目录含本机凭证，不要分享。',
      })
    },
  },
  {
    name: 'figma_select_document',
    description: '同时连接了多个 Figma 文件时，指定要操作哪一个。connectionId 从 figma_status 获取。',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (!bridge) throw new Error(`Figma 桥未启动：${bridgeError}`)
      const doc = bridge.list().find((d) => d.connectionId === args.connectionId)
      if (!doc) throw new Error('该文档未连接，请先在对应文件里运行插件')
      selectedId = doc.connectionId
      return ok({ selected: doc })
    },
  },
]

const DOC_TOOLS = LOCAL_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  mutation: tool.mutation,
  inspect: tool.inspect,
  run: async (args) => {
    const doc = pickDocument()

    if (tool.name === 'create_session') {
      const id = randomUUID()
      sessions.set(id, { fileKey: args.fileKey, description: args.description, createdAt: new Date().toISOString() })
      return ok({ sessionId: id, fileKey: args.fileKey, description: args.description })
    }

    let payload = args
    if (tool.name === 'upload_assets') {
      payload = { parentId: args.parentId, assets: await readAssets(WORKSPACE, args.files) }
    }

    const response = await bridge.call(doc.connectionId, tool.name, payload, {
      mutation: tool.mutation,
      inspect: tool.inspect,
    })

    if (tool.name === 'download_assets') {
      const files = await saveAssets(WORKSPACE, response.assets ?? [])
      response.value = { ...(response.value ?? {}), files }
    }
    let saved = []
    if (tool.name === 'use_figma' && response.assets?.length) {
      saved = await saveAssets(WORKSPACE, response.assets)
    }

    const output = localResult(response)
    if (saved.length) {
      output.structuredContent.files = saved
      output.content.push({ type: 'text', text: JSON.stringify({ files: saved }) })
    }
    return output
  },
}))

const TOOLS = [...META_TOOLS, ...DOC_TOOLS]

/* ------------------------------------------------------------ stdio 循环 */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
}

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'figma-bridge', version: VERSION },
      instructions:
        '这是通过本地桥接直接读写 Figma 画布的工具集。开始前先调用 figma_status 确认连接；' +
        '修改类操作优先用 use_figma 直接执行 Figma Plugin API 脚本，读类操作可用 get_metadata / get_screenshot / get_design_context。',
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const name = params?.name
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return replyError(id, -32602, `未知工具：${name}`)
    try {
      const result = await tool.run(params?.arguments ?? {})
      return reply(id, result)
    } catch (error) {
      log(`tool ${name} failed: ${error?.message || error}`)
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error?.message || error) }) }],
        isError: true,
      })
    }
  }
  if (method === 'resources/list') return reply(id, { resources: [] })
  if (method === 'prompts/list') return reply(id, { prompts: [] })
  return replyError(id, -32601, `不支持的方法：${method}`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const inflight = new Set()

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return log('丢弃非法 JSON 行')
  }
  const task = handle(message)
    .catch((error) => {
      log('handler error:', error?.message || error)
      if (message?.id !== undefined) replyError(message.id, -32603, String(error?.message || error))
    })
    .finally(() => inflight.delete(task))
  inflight.add(task)
})

process.on('uncaughtException', (error) => log('uncaught:', error?.message || error))
process.on('unhandledRejection', (error) => log('unhandled:', error?.message || error))

async function shutdown() {
  // stdin 关闭时可能还有调用在跑，先让它们把结果写回 stdout
  const deadline = Date.now() + 55000
  while (inflight.size && Date.now() < deadline) {
    await Promise.allSettled([...inflight])
  }
  await bridge?.close().catch(() => {})
  process.exit(0)
}

process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
