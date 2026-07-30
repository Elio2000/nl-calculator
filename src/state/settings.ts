/**
 * 设置持久化。
 *
 * 语音模型完全本地，不需要任何凭据；只有 LLM 归一化那条可选链路涉及 key。
 * 默认那条链路也不需要用户填 key——走同源转发（见 DEFAULT_SETTINGS），
 * key 留在服务端。只有改成直连第三方服务时才需要填，那时 key 只存在这台机器的
 * localStorage 里、只发往用户自己填的地址。
 */
import { MODELS, type ModelSize } from '../services/stt'

export type LlmProvider = 'none' | 'endpoint'

/**
 * 翻译策略。
 *
 * 本地模型跑一次的边际成本接近零，所以没必要为了省 token 而限制模型的使用。
 * 两种策略的差别不在省钱，而在**确定性与覆盖面的取舍**：
 *   rule-first —— 规则能读懂的就用规则（毫秒级、离线、同样输入永远同样结果），
 *                 读不懂才问模型
 *   llm-first —— 一律先问模型，规则只作为模型不可用时的退路。
 *                 覆盖面更广，但每次都要等模型，且同一句话可能给出不同读法
 *
 * 无论哪种，**算数始终由本地引擎完成**，模型只提议读法。
 */
export type TranslateStrategy = 'rule-first' | 'llm-first'

export interface Settings {
  /** 语音模型档位。 */
  voiceModel: ModelSize
  /** 翻译策略。 */
  strategy: TranslateStrategy
  /** LLM 归一化的后端选择。 */
  llmProvider: LlmProvider
  /**
   * OpenAI 兼容服务地址。可以是相对路径（`/api/llm/v1`，走本站的转发代理），
   * 也可以是绝对地址（`https://api.deepseek.com/v1`、`http://localhost:11434/v1`）。
   */
  baseUrl: string
  apiKey: string
  chatModel: string
}

const STORAGE_KEY = 'nl-calculator.settings'

/**
 * 设置结构版本。
 *
 * **改了默认值就要把它 +1。** 否则老用户浏览器里存的旧配置会盖掉新默认值——
 * 比如默认模型从 gpt-4o-mini 换成本机 Ollama 后，之前打开过页面的人
 * 仍然看到空的服务地址，还以为是没配好。
 */
const SCHEMA_VERSION = 4

interface StoredSettings extends Settings {
  version?: number
}

/**
 * 默认走**同源转发**：浏览器只请求本站的 `/api/llm/v1`，由服务端（开发时是
 * vite 代理，部署时是 scripts/serve.mjs）补上 Authorization 再转给 DeepSeek。
 *
 * 这样默认路径**不需要用户填任何 key**，打开链接就能用；而 key 只存在服务端的
 * 环境变量／`.deepseek.key` 里，既不进代码库，也不下发到浏览器。
 *
 * 另外两条链路作为备选，在设置面板里一键切换：
 *   BYOK 直连   `https://api.deepseek.com/v1` + 自己的 key（DeepSeek 允许跨域）
 *   本地 Ollama `http://localhost:11434/v1` + qwen3:8b（完全离线；1.5B 实测 6/14 不够用，已下架）
 *
 * 服务不可用时会明确报错并提示改用「不启用」，不会静默失败。
 */
export const DEFAULT_SETTINGS: Settings = {
  voiceModel: 'turbo',
  strategy: 'rule-first',
  llmProvider: 'endpoint',
  baseUrl: '/api/llm/v1',
  apiKey: '',
  chatModel: 'deepseek-v4-flash',
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS

    const stored = JSON.parse(raw) as StoredSettings
    // 版本不匹配就整份丢弃，用新默认值重来
    if (stored.version !== SCHEMA_VERSION) return DEFAULT_SETTINGS

    const merged = { ...DEFAULT_SETTINGS, ...stored }

    // 存量设置可能指向已经下线的档位（早期版本有 tiny 档），
    // 不校验会在 MODELS[size].id 处直接 TypeError。
    if (!(merged.voiceModel in MODELS)) merged.voiceModel = DEFAULT_SETTINGS.voiceModel
    if (merged.strategy !== 'rule-first' && merged.strategy !== 'llm-first') {
      merged.strategy = DEFAULT_SETTINGS.strategy
    }
    // 选了服务却没填地址，等于没配——退回默认地址而不是留个空框
    if (merged.llmProvider === 'endpoint' && !merged.baseUrl.trim()) {
      merged.baseUrl = DEFAULT_SETTINGS.baseUrl
    }
    if (!merged.chatModel.trim()) merged.chatModel = DEFAULT_SETTINGS.chatModel

    return merged
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  try {
    const payload: StoredSettings = { ...settings, version: SCHEMA_VERSION }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 隐私模式下 localStorage 可能不可写，设置只在本次会话生效即可
  }
}

/**
 * LLM 归一化是否可用。
 *
 * 判据只有「选了服务 + 地址非空」，对相对路径同样成立——默认的 `/api/llm/v1`
 * 非空，所以默认就是就绪状态。key 不在判据里：转发链路本来就不需要用户填 key。
 */
export function isLlmReady(settings: Settings): boolean {
  return settings.llmProvider === 'endpoint' && settings.baseUrl.trim().length > 0
}
