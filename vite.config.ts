import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 开发期的 LLM 转发代理。
 *
 * 浏览器只请求同源的 `/api/llm/v1/...`，由 dev server 补上 Authorization 再转给
 * DeepSeek。这样**页面里不需要任何凭据**，key 只存在于运行环境：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 项目根目录的 .deepseek.key（已在 .gitignore 里，不会进仓库）
 *
 * 生产预览走 scripts/serve.mjs，护栏更严；这里是同一套约定的开发版。
 */
const KEY_FILE = fileURLToPath(new URL('.deepseek.key', import.meta.url))

/** 启动时读一次。改了 key 需要重启 dev server——比每请求读盘可预期。 */
function readApiKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    // 文件末尾的换行会被原样拼进 Authorization 头，换来一个看不懂的 401，必须 trim
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

const API_KEY = readApiKey()

/** 缺 key 时的兜底：明确回一个 JSON 错误，而不是把没有认证的请求转出去挨 401。 */
function missingKeyPlugin(): Plugin {
  return {
    name: 'llm-proxy-missing-key',
    configureServer(server) {
      server.middlewares.use('/api/llm', (_req, res) => {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: { message: '服务端未配置 DEEPSEEK_API_KEY' } }))
      })
    },
  }
}

// 没有 key 就不注册代理，请求交给上面那个中间件处理
const proxy: Record<string, ProxyOptions> | undefined = API_KEY
  ? {
      '/api/llm': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        // 只剥掉 /api/llm 这层前缀，/v1/chat/completions 要原样送到上游
        rewrite: (path) => path.replace(/^\/api\/llm/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // setHeader 是覆盖：浏览器 localStorage 里若还留着旧的 BYOK key，
            // 也不会盖掉服务端这把
            proxyReq.setHeader('Authorization', `Bearer ${API_KEY}`)
          })
        },
      },
    }
  : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ...(API_KEY ? [] : [missingKeyPlugin()])],
  server: { proxy },
  // `vite preview` 也挂同一份代理，否则它伺服的产物会带着一条死掉的 /api/llm。
  // 正式预览请用 `npm run serve`（scripts/serve.mjs，带护栏），这里只是不留坑。
  preview: { proxy },
})
