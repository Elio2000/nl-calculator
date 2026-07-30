/**
 * LLM 归一化：把中文翻译成一次**工具调用**。
 *
 * 这是整个架构里 LLM 唯一的职责——**它只挑工具、填参数，不计算**。
 * 模型给出的每个候选都要在本地真跑一遍，再交给用户确认；
 * 采纳哪一个由人决定，算出多少由本地引擎决定。
 * 于是模型再不靠谱，也只会让用户多点一次「都不是」，而不会给出一个错的答案。
 *
 * 契约是 MCP / function calling 风格：能力显式声明（见 llmTools.ts）。
 * 服务端原生支持 tools 就走 function calling，不支持就退回 JSON 文本，
 * 两条路解析到同一个 ToolCall 结构。
 *
 * 后端是任意 OpenAI 兼容服务：Ollama、LM Studio、云端皆可。
 */
import type { Settings } from '../state/settings'
import {
  buildToolsPayload,
  TOOLS_AS_TEXT,
  toToolCall,
  type ToolCall,
  type ToolRejection,
} from './llmTools'
import { runToolCall } from './toolRunner'

export interface TranslationCandidate {
  call: ToolCall
  /** 本地真跑一遍得到的结果，让用户看着答案做选择。 */
  preview: string
  /** 展示用算式（纯文本兜底）。 */
  formula: string
  /** 算式的 LaTeX，候选卡也要用数学排版显示。 */
  tex: string
  /** 模型给的中文说明。 */
  reading: string
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

const SYSTEM_PROMPT = `你是中文数学问题的翻译器。判断用户想做什么，调用对应的工具。

输入可能来自语音识别，会有同音字错误。遇到读不通的字，先想想它的谐音是不是某个数学词：
「根号酒」是「根号九」，「成以」「成一」都是「乘以」，「三四方」是「三次方」，
「更好久」是「根号九」，「屁」是「pi」。特别注意「成」极可能是「乘」的误识。

**通常只调用一次工具。** 只有句子本身真的有歧义——同一句话能读成两个不同的算式、
且两种读法都说得通——才给出第二种。凑数的理解比没有理解更糟，用户会怀疑你没读懂。
典型的真歧义：「六除二」在中文里既能读成 6÷2 也能读成 2÷6。
有两种说得通的读法时，就调用两次工具，一次一个读法。

如果完全不是数学问题，或者信息不足以构成一次计算，调用 reject 工具说明原因——
不要硬凑一个算式出来。`

/** 把一句中文交给模型翻译，返回经过本地验证的候选。 */
export class NotMathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotMathError'
  }
}

export async function translate(
  input: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<TranslationCandidate[]> {
  // 先走 native tool calling
  try {
    const first = await askEndpoint(input, settings, signal, 'tools')
    const parsed = parseCandidates(first)
    assertNotRejected(parsed)
    const candidates = await verify(parsed.calls)
    if (candidates.length > 0) return candidates
  } catch (error) {
    if (error instanceof NotMathError) throw error
    // 服务端压根不认 tools 字段会直接 4xx。这不是「翻译失败」，
    // 是「这条路走不通」，应当换条路而不是把错误抛给用户。
    if (!(error instanceof LlmError) || !isUnsupportedRequest(error)) throw error
  }

  // 走到这里有两种情况：服务不支持 tools，或者支持但没真的强制
  // （实测 Ollama 的 tool_choice:"required" 就不强制，模型会返回自由文本、
  // tool_calls 为 null）。两种都用文本契约重问一次。
  const second = await askEndpoint(input, settings, signal, 'text')
  const parsed = parseCandidates(second)
  assertNotRejected(parsed)
  return verify(parsed.calls)
}

/** 模型明确说了这不是数学问题——如实转达，而不是当成「翻译失败」。 */
function assertNotRejected(parsed: ParsedCandidates): void {
  if (parsed.rejection) throw new NotMathError(parsed.rejection.why)
}

/** 4xx 里表示「请求形状不被接受」的那几种，值得换条路重试。 */
function isUnsupportedRequest(error: LlmError): boolean {
  return /服务返回 4(00|1[35]|22)/.test(error.message)
}

/**
 * 候选去重的键：**这次工具调用本身**，而不是它的展示公式。
 *
 * 曾经拿展示公式去重，于是 solve(x+y, x) 与 solve(x+y, y) 撞在了一起——
 * 两者的公式都是 `x+y = 0`，但结果一个是 x = -y、一个是 y = -x。
 * 第二条被当成重复删掉，用户永远看不到那个读法。
 * 展示公式是**给人看的投影**，不同的调用完全可能投影成同一串，拿它当身份用不住。
 *
 * 只做去空白这一种规范化：对数学表达式它保义，而身份键要的正是保义的比较。
 * 变量名不做大小写折叠——对求解引擎来说 X 和 x 是两个不同的符号。
 *
 * 导出是为了能直接断言（与 buildRequest 同一个理由）：去重是唯一会
 * 「悄悄删掉一个正确候选」的地方，得有测试钉住。
 */
export function candidateKey(call: ToolCall): string {
  const tidy = (text: string) => text.replace(/\s+/g, '')
  return call.tool === 'solve'
    ? JSON.stringify([call.tool, tidy(call.equation), tidy(call.variable)])
    : call.tool === 'evaluate'
      ? JSON.stringify([call.tool, tidy(call.expression)])
      : JSON.stringify([call.tool, tidy(call.expression), tidy(call.variable)])
}

/**
 * 每个候选都在本地真跑一遍。
 * 跑不通就丢弃——宁可少给一个候选，也不摆一个点了会报错的按钮。
 */
async function verify(
  items: Array<{ call: ToolCall; reading: string }>,
): Promise<TranslationCandidate[]> {
  const verified: TranslationCandidate[] = []
  const seen = new Set<string>()

  for (const item of items) {
    try {
      const key = candidateKey(item.call)
      if (seen.has(key)) continue
      const outcome = await runToolCall(item.call)
      seen.add(key)
      verified.push({
        call: item.call,
        preview: outcome.preview,
        formula: outcome.formula,
        tex: outcome.tex,
        reading: item.reading || '模型给出的理解',
      })
    } catch {
      // 跑不通的候选直接丢弃
    }
  }

  return verified
}

interface RawCandidate {
  tool?: unknown
  name?: unknown
  args?: unknown
  reading?: unknown
}

interface ParsedCandidates {
  calls: Array<{ call: ToolCall; reading: string }>
  rejection: ToolRejection | null
}

function parseCandidates(raw: string): ParsedCandidates {
  const payload = extractJson(raw)
  if (!payload) return { calls: [], rejection: null }

  const calls: Array<{ call: ToolCall; reading: string }> = []
  let rejection: ToolRejection | null = null

  for (const item of payload.candidates ?? []) {
    const call = toToolCall(item)
    if (!call) continue
    if (call.tool === 'reject') {
      rejection ??= call
      continue
    }
    // 复述可能在候选顶层（文本契约），也可能在工具参数里（原生 FC）
    const nested = (item?.args ?? null) as Record<string, unknown> | null
    const reading = item?.reading ?? (nested && typeof nested === 'object' ? nested.reading : '')
    calls.push({ call, reading: String(reading ?? '').trim() })
  }

  // 只有在没给出任何可用调用时，拒绝才作数
  return { calls, rejection: calls.length > 0 ? null : rejection }
}

/** 模型常把 JSON 包在解释文字或代码块里，取第一段完整的对象。 */
function extractJson(raw: string): { candidates?: RawCandidate[] } | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1] : raw

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1)) as { candidates?: RawCandidate[] }
  } catch {
    return null
  }
}

/**
 * 构造请求体。抽成纯函数是为了能直接断言「strict 和 tools 有没有真的发出去」，
 * 不用 mock 网络——这是 LLM 路径唯一能低成本测到的地方。
 */
export function buildRequest(input: string, settings: Settings, mode: RequestMode = 'tools') {
  const base = {
    model: settings.chatModel,
    temperature: 0,
    messages: [
      {
        role: 'system' as const,
        content: mode === 'tools' ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n${TEXT_FALLBACK}`,
      },
      { role: 'user' as const, content: input },
    ],
  }

  if (mode === 'text') return base

  return {
    ...base,
    // native tool calling：模型在采样层面就只能吐出合 schema 的参数，
    // 比「请输出 JSON」+ 正则抠取可靠得多
    tools: buildToolsPayload(true),
    // 用 auto 而不是 required：有了显式的 reject 工具，「必须调用」就没有意义了——
    // 模型总有一个诚实的出口。而且 required 在真实后端上路况很差：
    // Ollama 收下但不强制，DeepSeek v4（思考模型）直接 400
    // "Thinking mode does not support this tool_choice"。
    tool_choice: 'auto' as const,
  }
}

export type RequestMode = 'tools' | 'text'

/** 服务端不认 tools 参数时的文字契约。 */
const TEXT_FALLBACK = `这个服务不支持工具调用，请直接输出 JSON：
{"candidates":[{"tool":"工具名","args":{...},"reading":"中文说明"}]}

可用工具与参数：
${TOOLS_AS_TEXT}

只输出 JSON，不要任何解释文字。`

/**
 * 按后端选超时。
 *
 * 云端（DeepSeek）1–3 秒出结果，20 秒足够宽，超了基本就是网断了，快速失败
 * 让用户早点看到规则引擎的兜底。本地 / 转发的 qwen3 是**思考模型**，
 * 冷启动要把 5G 权重搬进内存、答题前还要先思考——实测 20 秒必超时，
 * 界面上就成了「Qwen 一直坏」。这不是网络问题，是模型真的在算，等它。
 */
export function timeoutMsFor(baseUrl: string): number {
  const isLocalBackend = /^\/api\/qwen|^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseUrl)
  return isLocalBackend ? 120000 : 20000
}

/** OpenAI 兼容接口，含 Ollama / LM Studio 的 localhost。 */
async function askEndpoint(
  input: string,
  settings: Settings,
  signal: AbortSignal | undefined,
  mode: RequestMode,
): Promise<string> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new LlmError('还没有填服务地址')

  const timeout = AbortSignal.timeout(timeoutMsFor(baseUrl))
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify(buildRequest(input, settings, mode)),
      signal: merged,
    })
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') throw new LlmError('模型响应超时')
    // 浏览器直连时最常见的失败就是服务端没开跨域
    throw new LlmError(
      `连不上 ${baseUrl}（服务没启动，或没开跨域——Ollama 需设 OLLAMA_ORIGINS）`,
    )
  }

  if (!response.ok) {
    throw new LlmError(
      `服务返回 ${response.status}${response.status === 401 ? '，API key 可能不对' : ''}`,
    )
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
    }>
  }

  const message = data.choices?.[0]?.message

  // 正常路径：服务端返回结构化的 tool_calls
  const nativeCalls = message?.tool_calls
  if (nativeCalls?.length) {
    return JSON.stringify({
      candidates: nativeCalls.map((call) => {
        const args = parseArguments(call.function?.arguments)
        // reading 是工具参数之一（见 llmTools.ts），原生路径从参数里取出来
        const reading =
          args && typeof args === 'object' && 'reading' in args
            ? String((args as Record<string, unknown>).reading ?? '')
            : ''
        return { tool: call.function?.name, args, reading }
      }),
    })
  }

  // 没拿到 tool_calls：可能是服务端不支持，也可能模型自作主张写了正文。
  // 两种情况都把正文交给 parseCandidates 试着抠 JSON，抠不出来上层会走文本降级。
  return message?.content ?? ''
}

/**
 * 解析工具参数。
 *
 * 阶梯降级抄自 pi 的 json-parse：模型在 JSON 字符串里吐**裸控制字符**
 * 是中文场景的高频雷区，一个裸换行就能让 JSON.parse 直接崩。
 */
function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(repairJson(text))
    } catch {
      return {}
    }
  }
}

/** 修两类真实故障：字符串内的裸控制字符、非法反斜杠转义。 */
function repairJson(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (const ch of text) {
    if (escaped) {
      // 非法转义序列直接去掉反斜杠
      out += '"\\/bfnrtu'.includes(ch) ? `\\${ch}` : ch
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString && ch < ' ') {
      out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : ''
      continue
    }
    out += ch
  }

  return out
}
