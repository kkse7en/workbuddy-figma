/**
 * 伴生插件（Figma companion）的生成与配对。
 *
 * 原理：WorkBuddy 侧生成 32 字节随机 token，把它注入到 code.js 头部，
 * Figma 插件启动时把这段 bootstrap 通过 postMessage 交给 UI，
 * UI 再用它对我们本地的桥发 Bearer 请求。两边 token 一致才算配对成功。
 *
 * 这样每台机器生成的插件 id 都不同（id 里带 token 指纹），
 * 同一台机器装多个变体也不会互相顶掉。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/** 读取已有 token，没有就生成一个 32 字节随机 hex 并落盘（权限 600）。 */
export async function ensureToken(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, 'token')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/.test(existing)) return existing
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('hex')
  await writeFile(path, token, { mode: 0o600 })
  return token
}

/**
 * 生成一份已配对的 Figma 插件目录，返回 manifest 路径。
 * 生成的目录含本机凭证，只能留在本机。
 */
export async function prepareCompanion({ root, stateDir, token, port = 3055 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效')
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('配对 token 无效')

  const source = join(root, 'companion')
  const target = join(stateDir, 'companion')
  await mkdir(target, { recursive: true, mode: 0o700 })

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))

  manifest.id = 'workbuddy-figma-' + createHash('sha256').update(token).digest('hex').slice(0, 12)
  manifest.name = 'WorkBuddy Figma'
  manifest.networkAccess.devAllowedDomains = [`http://localhost:${port}`]

  const bootstrap = { version: pkg.version, port, token }
  const rawCode = await readFile(join(source, 'code.js'), 'utf8')
  const rawUi = await readFile(join(source, 'ui.html'), 'utf8')
  // ui.html 里的桥地址是写死的，端口变了必须一起替换
  const ui = rawUi.split('http://localhost:3055').join(`http://localhost:${port}`)

  // 先写资源、最后写 manifest：Figma 会一直记住这个目录，最后落 manifest 能保证原子性
  await writeFile(join(target, 'code.js'), `globalThis.DSH_FIGMA_BOOTSTRAP = ${JSON.stringify(bootstrap)};\n` + rawCode)
  await writeFile(join(target, 'ui.html'), ui)
  await writeFile(
    join(target, 'README.txt'),
    `WorkBuddy Figma ${pkg.version} — 本机专用已配对副本，含本机凭证，请勿上传或分享。\n\n` +
      `在 Figma 桌面端：Plugins → Development → Import plugin from manifest… → 选择 manifest.json\n` +
      `然后打开目标设计文件，运行「WorkBuddy Figma」，把插件窗口保持打开即可自动连接。\n` +
      `本地端口 ${port}。\n`
  )
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { manifest: join(target, 'manifest.json'), folder: target, port }
}
