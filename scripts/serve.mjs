/**
 * 生产预览服务器：静态伺服 dist/ + 一条 LLM 转发路由。
 *
 * 用途是把构建产物连同「内置转发」一起端出去（本机跑 + cloudflared/ngrok 打洞给人试用），
 * 所以它必须同时满足两件事：
 *   1. 面试官打开链接**不用填任何 key** 就能用 AI 归一化
 *   2. 这个临时暴露到公网的洞，不能变成一个任人白嫖的 OpenAI 代理
 *
 * 于是转发路由是一条**白名单**而不是一个通道：只认一个路径、只认 deepseek 系列
 * 模型、请求体限 64KB、max_tokens 封顶。除此之外的请求一律 404。
 *
 * 零依赖，只用 node 内置模块。
 *
 *   npm run build
 *   DEEPSEEK_API_KEY=sk-xxxx npm run serve        # 或把 key 写进 .deepseek.key
 *   cloudflared tunnel --url http://localhost:4173   # 或 ngrok http 4173
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { readDeepseekKey, DEEPSEEK_UPSTREAM } from './lib/deepseek.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 4173)

// 凭据与上游地址的唯一出处见 scripts/lib/deepseek.mjs；启动时读一次
const UPSTREAM = DEEPSEEK_UPSTREAM
const API_KEY = readDeepseekKey()

/* ── 转发路由的护栏 ───────────────────────────────── */

/** 请求体上限。翻译一句中文用不到 1KB，64KB 已经很宽松了。 */
const MAX_BODY_BYTES = 64 * 1024
/** 输出上限。工具调用只有几十个 token，封顶是为了防止有人拿它当写作机。 */
const MAX_OUTPUT_TOKENS = 4096

/**
 * 允许转发的路由，一条一档，多一条都不开；都只认 chat/completions 这一个动作。
 *
 * qwen 那条转给**服务端本机**的 Ollama——预设里直接写 localhost 的话，
 * 远程访客浏览器里的「localhost」是他自己的电脑，永远够不到这台机器的模型。
 * 经同源转发，访客才能用上这里跑着的 qwen3:8b。
 */
const ROUTES = {
  '/api/llm/v1/chat/completions': {
    upstream: `${UPSTREAM}/v1/chat/completions`,
    modelPrefix: 'deepseek',
    // null 表示缺凭据：直接 500，绝不把没认证的请求送出去挨 401
    authorization: () => (API_KEY ? `Bearer ${API_KEY}` : null),
    missingAuthMessage: '服务端未配置 DEEPSEEK_API_KEY',
    timeoutMs: 60000,
  },
  '/api/qwen/v1/chat/completions': {
    upstream: 'http://localhost:11434/v1/chat/completions',
    modelPrefix: 'qwen',
    authorization: () => '', // 本机 Ollama 不需要凭据
    missingAuthMessage: '',
    // 本地 8B 是思考模型，冷启动加载 + 思考都慢，比云端宽一倍
    timeoutMs: 120000,
  },
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

const fail = (res, status, message) => sendJson(res, status, { error: { message } })

/** 读请求体，超限就断。返回 null 表示已经回过错误了。 */
async function readBody(req, res) {
  let size = 0
  const chunks = []

  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      fail(res, 413, `请求体超过 ${MAX_BODY_BYTES / 1024}KB 上限`)
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

/** 转发到上游。请求头是**新建的**，不继承客户端的任何一个。 */
async function handleLlm(req, res, route) {
  const auth = route.authorization()
  if (auth === null) return fail(res, 500, route.missingAuthMessage)

  const raw = await readBody(req, res)
  if (raw === null) return

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(res, 400, '请求体不是合法 JSON')
  }

  if (typeof body?.model !== 'string' || !body.model.startsWith(route.modelPrefix)) {
    return fail(res, 400, `只允许 ${route.modelPrefix} 系列模型`)
  }

  // 客户端给多少都封顶；没给也补上，免得默认值放任长输出
  const asked = Number(body.max_tokens)
  body.max_tokens = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS

  let upstream
  try {
    upstream = await fetch(route.upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 唯一注入凭据的地方。它不出现在日志里，也不会回到浏览器
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(route.timeoutMs),
    })
  } catch (error) {
    return fail(res, 502, `连不上上游服务：${error.name}`)
  }

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  })
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
  else res.end()
}

/* ── 静态伺服 ─────────────────────────────────────── */

/**
 * SPA 回退只给**没有扩展名**的路径。
 *
 * 这条区分很要紧：语音模型走 `/models/...` 取权重，仓库里没有权重时
 * transformers.js 靠 **404** 判断「本地没有，去 HuggingFace 下」。
 * 如果这里对任何路径都回 index.html（200），它拿到一段 HTML 当 JSON 解析，
 * 会硬失败而不是回落——离线可用就变成了在线也不可用。
 */
async function handleStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return fail(res, 400, '路径编码非法')
  }

  const target = path.join(DIST, path.normalize(pathname))
  // path.normalize 之后再比一次前缀，挡掉 ../ 穿越
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    return fail(res, 403, '越界的路径')
  }

  const file = await resolveFile(target, pathname)
  if (!file) return fail(res, 404, '没有这个文件')

  const info = await stat(file)
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
  })

  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

async function resolveFile(target, pathname) {
  if (await isFile(target)) return target

  const indexFile = path.join(target, 'index.html')
  if (pathname.endsWith('/') && (await isFile(indexFile))) return indexFile

  // 带扩展名的没找到就是真的没有——必须让它 404（见上面的注释）
  if (path.extname(pathname)) return null

  const fallback = path.join(DIST, 'index.html')
  return (await isFile(fallback)) ? fallback : null
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/* ── 入口 ─────────────────────────────────────────── */

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname

  const route = ROUTES[pathname]
  if (route && req.method === 'POST') {
    handleLlm(req, res, route).catch(() => fail(res, 500, '转发时出错'))
    return
  }
  // /api 下只有白名单里那几条路由，其余一律当不存在——别让它长成通用代理
  if (pathname.startsWith('/api/')) return fail(res, 404, '没有这个接口')

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 404, '没有这个接口')

  handleStatic(req, res).catch(() => fail(res, 500, '读取文件出错'))
})

server.listen(PORT, () => {
  console.log(`静态目录 ${DIST}`)
  for (const [route, { upstream }] of Object.entries(ROUTES)) {
    console.log(`LLM 转发 ${route} → ${upstream}`)
  }
  console.log(API_KEY ? '已读到 API key（不打印内容）' : '⚠️  没有 API key，DeepSeek 转发会返回 500')
  console.log(`\n  http://localhost:${PORT}\n`)
})
