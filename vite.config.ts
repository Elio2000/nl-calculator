import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error 纯 JS 共享模块（scripts 端也在用），不为它单开一份类型声明
import { readDeepseekKey, DEEPSEEK_UPSTREAM } from './scripts/lib/deepseek.mjs'

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
/** 启动时读一次（scripts/lib/deepseek.mjs 是 key 与上游地址的唯一出处）。 */
const API_KEY: string = readDeepseekKey()

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

const proxy: Record<string, ProxyOptions> = {
  // 「内置 Qwen 转发」的开发版：转给本机 Ollama，不需要凭据。
  // 生产版在 scripts/serve.mjs 里带完整护栏，这里保持开发/部署行为一致。
  '/api/qwen': {
    target: 'http://localhost:11434',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/qwen/, ''),
  },
  // DeepSeek 转发只在有 key 时注册；没有 key 时交给上面那个中间件回 500
  ...(API_KEY
    ? {
        '/api/llm': {
          target: DEEPSEEK_UPSTREAM,
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
        } satisfies ProxyOptions,
      }
    : {}),
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ...(API_KEY ? [] : [missingKeyPlugin()])],
  server: { proxy },
  // `vite preview` 也挂同一份代理，否则它伺服的产物会带着一条死掉的 /api/llm。
  // 正式预览请用 `npm run serve`（scripts/serve.mjs，带护栏），这里只是不留坑。
  preview: { proxy },
})
