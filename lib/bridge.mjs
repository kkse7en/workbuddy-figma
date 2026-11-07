import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

const MAX_BODY = 24 * 1024 * 1024
const ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com'])
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const failure = (message, safeToRetryWithoutCanvasRead = false) => Object.assign(new Error(message), {safeToRetryWithoutCanvasRead})
const json = (res, code, value) => { if (!res.destroyed) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) } }
async function body(req) {
  let size = 0; const chunks = []
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('Body too large'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** Only Figma's sandbox executes scripts. This process never evals canvas code. */
export class LocalBridge {
  constructor({ token, port = 3055, timeoutMs = 120000 }) {
    this.token = token; this.port = port; this.timeoutMs = timeoutMs
    this.documents = new Map(); this.stopped = false
  }
  async start({ portCandidates } = {}) {
    this.server = createServer((req, res) => this.route(req, res).catch(() => json(res, 400, { error: 'Invalid bridge request' })))
    // 长轮询每次挂起 18s；Node 默认 keepAliveTimeout 只有 5s，会在两次轮询之间
    // 悄悄关闭空闲连接，Figma 的 fetch 复用到已关闭的 socket 就会报 Failed to fetch。
    // 这是「经常连不上、连接中断」最隐蔽的一个来源，必须把保活时间拉到长轮询之上。
    this.server.keepAliveTimeout = 65000
    this.server.headersTimeout = 70000
    this.server.requestTimeout = 0
    const candidates = portCandidates?.length ? portCandidates : [this.port]
    let lastError = null
    for (const candidate of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { this.server.removeListener('listening', onListening); reject(error) }
          const onListening = () => { this.server.removeListener('error', onError); resolve() }
          this.server.once('error', onError)
          this.server.once('listening', onListening)
          this.server.listen(candidate, '127.0.0.1')
        })
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    if (lastError) throw lastError
    this.port = this.server.address().port
    this.timer = setInterval(() => {
      // 45s 太激进：Figma 后台窗口会节流定时器，正常挂起也可能被判死。
      for (const doc of this.documents.values()) if (Date.now() - doc.lastSeen > 120000) this.remove(doc.id)
    }, 5000); this.timer.unref()
    return this
  }
  list() { return [...this.documents.values()].map(d => ({ connectionId: d.id, name: d.name, editorType: d.editorType, fileKey: d.fileKey, busy: !!d.active, needsInspection: d.uncertain, featureVersion: d.featureVersion, companionVersion: d.companionVersion })) }
  async route(req, res) {
    if (this.stopped) return json(res, 503, { error: 'Bridge stopped' })
    if (![ `127.0.0.1:${this.port}`, `localhost:${this.port}` ].includes(req.headers.host)) return json(res, 403, { error: 'Host rejected' })
    const origin = req.headers.origin
    if (origin && !ORIGINS.has(origin)) return json(res, 403, { error: 'Origin rejected' })
    if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin') }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'POST')
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
      res.setHeader('access-control-allow-private-network', 'true')
      res.writeHead(204); return res.end()
    }
    if (!equal(req.headers.authorization, `Bearer ${this.token}`)) return json(res, 401, { error: 'Pairing token required' })
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
    const data = await body(req)
    if (req.url === '/connect') {
      const clientId = typeof data.clientId === 'string' && /^[a-f0-9-]{36}$/.test(data.clientId) ? data.clientId : null
      const existing = clientId && [...this.documents.values()].find(doc => doc.clientId === clientId)
      if (existing) { existing.lastSeen = Date.now(); return json(res, 200, { connectionId: existing.id }) }
      if (this.documents.size >= 20) return json(res, 429, { error: 'Too many open documents' })
      if (typeof data.name !== 'string' || !['figma', 'figjam', 'slides', 'buzz'].includes(data.editorType)) throw new Error('Invalid document')
      const doc = { id: randomUUID(), clientId, name: data.name.slice(0, 200), editorType: data.editorType,
        fileKey: typeof data.fileKey === 'string' && /^[A-Za-z0-9]{5,128}$/.test(data.fileKey) ? data.fileKey : null,
        featureVersion: Number.isInteger(data.featureVersion) && data.featureVersion >= 0 && data.featureVersion <= 100 ? data.featureVersion : 0,
        companionVersion: typeof data.companionVersion === 'string' && data.companionVersion.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(data.companionVersion) ? data.companionVersion : null,
        lastSeen: Date.now(), queue: [], active: null, poll: null, uncertain: false }
      // 同一个文件重开插件会留下一条僵尸连接；不清掉它，pickDocument 可能选到
      // 那条永远等不到响应的连接，表现就是「工具报了连接但操作一直超时」。
      if (doc.fileKey) {
        for (const other of [...this.documents.values()]) {
          if (other.id === doc.id || other.fileKey !== doc.fileKey) continue
          if (other.active || other.poll) continue
          if (Date.now() - other.lastSeen > 30000) this.remove(other.id)
        }
      }
      this.documents.set(doc.id, doc)
      return json(res, 200, { connectionId: doc.id })
    }
    const doc = this.documents.get(data.connectionId)
    if (!doc) return json(res, 404, { error: 'Document disconnected; reconnect and select it again' })
    doc.lastSeen = Date.now()
    if (req.url === '/heartbeat') return json(res, 200, { connected: true })
    if (req.url === '/disconnect') { this.remove(doc.id); return json(res, 200, { disconnected: true }) }
    if (req.url === '/poll') {
      // 不返回 409：上一次 poll 因为客户端 abort 或代理重置而没被回收时（socket close
      // 事件在部分内嵌浏览器里会丢），这里再拒绝一次就会让插件永远连不上。
      // 正确做法是让新的 poll 接管，旧的直接以 idle 结束。
      if (doc.poll) {
        const previous = doc.poll
        doc.poll = null
        clearTimeout(previous.timer)
        json(previous.res, 200, { idle: true, superseded: true })
      }
      const timer = setTimeout(() => { if (doc.poll?.res === res) { doc.poll = null; json(res, 200, { idle: true }) } }, 18000)
      doc.poll = { res, timer }
      res.once('close', () => { if (doc.poll?.res === res) doc.poll = null; clearTimeout(timer) })
      this.dispatch(doc); return
    }
    if (req.url === '/result') {
      const job = doc.active
      // 结果回传的请求本身也可能被网络抖一下；幂等处理，避免明明执行成功却被判成
      // 「结果未知」，逼用户重新打开插件。
      if (!job || data.id !== job.id) {
        if (doc.lastResultId && doc.lastResultId === data.id) return json(res, 200, { accepted: true, duplicate: true })
        return json(res, 409, { error: 'Unknown or already consumed operation' })
      }
      doc.active = null
      doc.lastResultId = job.id
      if (!job.settled) {
        if (data.ok === true) {
          if (job.inspect) doc.uncertain = false
          job.finish(null, data.result)
        } else {
          const safe = doc.featureVersion >= 3 && data.safeToRetryWithoutCanvasRead === true
          if (job.mutation && !safe) doc.uncertain = true
          job.finish(failure(`${String(data.error || 'Figma operation failed').slice(0, 2000)}; ${safe?'correct the error and retry':'inspect the canvas before retrying'}`,safe))
        }
      }
      json(res, 200, { accepted: true }); this.dispatch(doc); return
    }
    json(res, 404, { error: 'Unknown route' })
  }
  dispatch(doc) {
    if (doc.active || !doc.poll) return
    let job
    while ((job = doc.queue.shift())) {
      if (job.settled) continue
      if (doc.uncertain && job.mutation) { job.finish(new Error('Previous operation outcome is uncertain. Read get_metadata before another write.')); continue }
      doc.active = job; job.dispatched = true; job.dispatchedAt = performance.now()
      const poll = doc.poll; doc.poll = null; clearTimeout(poll.timer)
      json(poll.res, 200, { id: job.id, method: job.method, args: job.args }); return
    }
  }
  call(id, method, args, { signal, mutation = false, inspect = false, onMetric } = {}) {
    const doc = this.documents.get(id)
    if (this.stopped || !doc) return Promise.reject(new Error('Figma document is not connected'))
    if (doc.queue.length >= 30) return Promise.reject(new Error('Figma queue is full'))
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_BODY - 1024) return Promise.reject(new Error('Figma request is too large'))
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), method, args, mutation, inspect, settled: false, dispatched: false, queuedAt: performance.now() }
      let timer
      const cancel = () => {
        if (job.dispatched && mutation) doc.uncertain = true
        job.finish(failure(job.dispatched ? 'Figma operation interrupted; its outcome may be unknown. Do not replay. Wait for completion and inspect the canvas.' : 'Figma operation canceled before dispatch',!job.dispatched&&!doc.uncertain))
      }
      job.finish = (error, result) => {
        if (job.settled) return
        job.settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
        if (!job.dispatched) doc.queue = doc.queue.filter(other => other !== job)
        const finishedAt = performance.now()
        try { onMetric?.({queueMs:(job.dispatchedAt??finishedAt)-job.queuedAt,bridgeMs:job.dispatched?finishedAt-job.dispatchedAt:null}) } catch {} // Diagnostics must never affect execution.
        error ? reject(error) : resolve(result)
      }
      timer = setTimeout(cancel, this.timeoutMs)
      if (signal?.aborted) return cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      doc.queue.push(job); this.dispatch(doc)
    })
  }
  remove(id) {
    const doc = this.documents.get(id); if (!doc) return
    this.documents.delete(id)
    if (doc.poll) { clearTimeout(doc.poll.timer); json(doc.poll.res, 410, { error: 'Disconnected' }) }
    for (const job of [doc.active, ...doc.queue].filter(Boolean)) job.finish(new Error('Figma disconnected. Operation was not replayed; inspect the canvas after reconnecting.'))
  }
  async close() {
    this.stopped = true; clearInterval(this.timer)
    for (const id of this.documents.keys()) this.remove(id)
    if (this.server?.listening) await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections() })
  }
}
