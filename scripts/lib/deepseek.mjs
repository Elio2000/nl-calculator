/**
 * DeepSeek 凭据与上游地址的唯一出处。
 *
 * key 只来自运行环境，绝不出现在代码或仓库里：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 项目根目录 .deepseek.key（已在 .gitignore）
 * 读取方约定启动时读一次；换 key 重启即可——比每请求读盘可预期。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const DEEPSEEK_UPSTREAM = 'https://api.deepseek.com'

const KEY_FILE = fileURLToPath(new URL('../../.deepseek.key', import.meta.url))

export function readDeepseekKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    // 文件末尾的换行会被原样拼进 Authorization 头，换来一个看不懂的 401，必须 trim
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}
