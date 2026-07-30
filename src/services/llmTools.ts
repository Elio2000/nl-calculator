/**
 * LLM 的工具契约。
 *
 * 模型不是"输出一个表达式字符串"，而是**选一个计算工具并填参数**——
 * 和 MCP / function calling 是同一个思路：能力显式声明，模型只负责挑工具填槽，
 * 执行永远在我们这边。
 *
 * 设计上抄了 pi（earendil-works/pi）的几个做法：
 *   - 走 native tool calling 而不是「请输出 JSON」+ 正则抠取。pi 支持 20 多个
 *     provider 却完全不用 response_format，因为 tool calling 在异构后端上更通用，
 *     而且配 strict 后模型在**采样层面**就吐不出不合 schema 的 token。
 *   - 参数语义就地写在每个字段的 description 里，不靠 system prompt 解释。
 *     schema 是强约束时，用 few-shot「教格式」的需求就消失了。
 *   - 校验前先做类型强制转换：`"42"` → `42` 是模型最高频的软错误，
 *     这层零 API 往返就能修掉。
 */

/**
 * 每个计算工具都带的「复述」参数。
 *
 * 候选卡上要给用户看一句中文说明（「六除以二，结果等于 3」），让人不读算式
 * 也能确认理解对不对。把它做成工具参数而不是另一轮对话，原生 function calling
 * 一次就能把算式和说明都带回来。
 */
const READING_PARAM = {
  type: 'string',
  description: '用一句简短中文复述你把这句话理解成了什么',
} as const

const EXPRESSION_RULES =
  '规范数学表达式。只能用数字、+ - * / ^ ( ) 与这些函数：' +
  'sqrt cbrt nthRoot abs factorial exp log log10 sin cos tan asin acos atan sinh cosh tanh mod min max；' +
  '也接受 ln（自然对数）和 lg（常用对数）的写法。常量只有 pi e i。' +
  // 中文习惯里 log 常指常用对数，但引擎里 log 是自然对数——不写明会算错一个数量级
  '**注意 log(x) 是自然对数（以 e 为底），常用对数要写 log10(x)，以 b 为底写 log(x,b)。**' +
  '必须写显式乘号，每个二元运算都要加括号。不要用百分号——百分之二十写成 (20/100)。'

/** 我们对外暴露的计算能力，每个对应本地引擎的一个入口。 */
export const TOOLS = [
  {
    name: 'evaluate',
    description: '计算一个算式的值。加减乘除、幂、根、三角、对数等一切求值问题都用它。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: EXPRESSION_RULES },
        reading: READING_PARAM,
      },
      required: ['expression', 'reading'],
      additionalProperties: false,
    },
  },
  {
    name: 'solve',
    description: '解方程求未知数。用户说「解方程」「…等于…的解」「求 x」时用它。',
    parameters: {
      type: 'object',
      properties: {
        equation: {
          type: 'string',
          description:
            '移项到一侧、令其等于零的那个式子。x²+2x+1=0 填 "x^2+2*x+1"；2x+3=7 填 "2*x+3-7"。' +
            EXPRESSION_RULES,
        },
        variable: { type: 'string', description: '要解的未知数，通常是 x' },
        reading: READING_PARAM,
      },
      required: ['equation', 'variable', 'reading'],
      additionalProperties: false,
    },
  },
  {
    name: 'diff',
    description: '求导数。用户说「求导」「导数」「微分」时用它。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: `要求导的表达式。${EXPRESSION_RULES}` },
        variable: { type: 'string', description: '对哪个变量求导，通常是 x' },
        reading: READING_PARAM,
      },
      required: ['expression', 'variable', 'reading'],
      additionalProperties: false,
    },
  },
  {
    name: 'integrate',
    description: '求不定积分。用户说「积分」「原函数」时用它。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: `被积函数。${EXPRESSION_RULES}` },
        variable: { type: 'string', description: '积分变量，通常是 x' },
        reading: READING_PARAM,
      },
      required: ['expression', 'variable', 'reading'],
      additionalProperties: false,
    },
  },
  {
    // 显式的拒绝出口。没有它，`tool_choice:"required"` 会逼模型
    // 给「今天天气不错」硬编一个 evaluate 调用——契约自相矛盾。
    name: 'reject',
    description: '这句话不是数学问题，或者信息不足以构成一次计算。选它而不是硬凑一个算式。',
    parameters: {
      type: 'object',
      properties: {
        why: { type: 'string', description: '一句话说明为什么不是数学问题' },
      },
      required: ['why'],
      additionalProperties: false,
    },
  },
] as const

/** 模型选定的一次工具调用。 */
export type ToolCall =
  | { tool: 'evaluate'; expression: string }
  | { tool: 'solve'; equation: string; variable: string }
  | { tool: 'diff'; expression: string; variable: string }
  | { tool: 'integrate'; expression: string; variable: string }

/** 模型明确表示这不是数学问题。 */
export interface ToolRejection {
  tool: 'reject'
  why: string
}

/**
 * 把模型给的任意形状收敛成 ToolCall，形状不对返回 null。
 *
 * 容忍三类常见偏差，因为它们零成本就能修，没必要为此多跑一轮模型：
 *   - 参数嵌在 args/arguments 里，或直接扁平铺开
 *   - 数值被包成字符串（pi 说这是最高频的软错误）
 *   - solve 的 equation 带着 `=0` 没移项
 */
export function toToolCall(raw: unknown): ToolCall | ToolRejection | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>

  const nested = item.args ?? item.arguments ?? item.parameters
  const args = (nested && typeof nested === 'object' ? nested : item) as Record<string, unknown>

  const tool = coerceText(item.tool ?? item.name)
  const variable = coerceText(args.variable) ?? 'x'

  switch (tool) {
    case 'reject':
      return { tool: 'reject', why: coerceText(args.why) ?? '这不是一个数学问题' }
    case 'evaluate': {
      const expression = coerceText(args.expression ?? args.equation)
      return expression ? { tool: 'evaluate', expression: normalizeAliases(expression) } : null
    }
    case 'solve': {
      const raw = coerceText(args.equation ?? args.expression)
      if (!raw) return null
      const equation = normalizeEquation(normalizeAliases(raw))
      return equation ? { tool: 'solve', equation, variable } : null
    }
    case 'diff':
    case 'integrate': {
      const expression = coerceText(args.expression ?? args.equation)
      return expression ? { tool, expression: normalizeAliases(expression), variable } : null
    }
    default:
      return null
  }
}

/**
 * 表面别名 → 规范函数名。ln/lg 是中文使用者和模型都爱写的形态
 * （词表里对中文输入做了同款映射，这里对模型输出对齐）。
 * CFG 实验的教训：模型想写 ln 被硬堵时，可能滑进「合法但语义错」的式子——
 * 把高频别名纳入表面语言、在边界归一到核心语言，比堵住更安全。
 * 只在 LLM 边界做：引擎本身保持严格，展示层永远只见规范名。
 */
export function normalizeAliases(expression: string): string {
  return expression.replace(/\bln\(/g, 'log(').replace(/\blg\(/g, 'log10(')
}

/** 数值/布尔也接受，统一转成非空字符串。 */
function coerceText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/**
 * `a=b` → `a-(b)`；右边是 0 时直接取左边。已是单边式子则原样返回。
 *
 * 多个等号一律拒绝：`x=2=2` 曾被拼成畸形的 `x-(2=2)`，
 * 而下游居然还给出了 `x = 0` 这个答案。宁可让模型重来。
 */
function normalizeEquation(raw: string): string | null {
  const parts = raw.split('=')
  if (parts.length > 2) return null
  if (parts.length === 1) return raw

  const [leftRaw, rightRaw] = parts
  const left = leftRaw.trim()
  const right = rightRaw.trim()
  if (!left || !right) return null
  if (/^0+(\.0+)?$/.test(right)) return left
  return `${left}-(${right})`
}

/**
 * 构造发给服务端的 tools 数组。
 *
 * 抽成纯函数是为了可测——pi 的 130 多个测试全部离线跑，
 * 前提就是 payload 构造与网络 IO 分离。
 */
export function buildToolsPayload(strict: boolean) {
  return TOOLS.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // 不支持的服务会拒绝未知字段，所以按需附加
      ...(strict ? { strict: true } : {}),
    },
  }))
}

/** 工具契约的文字版，给完全不认 tools 参数的服务兜底用。 */
export const TOOLS_AS_TEXT = TOOLS.map(
  (tool) =>
    `- ${tool.name}：${tool.description}\n  参数：${Object.entries(tool.parameters.properties)
      .map(([key, spec]) => `${key}（${(spec as { description: string }).description}）`)
      .join('；')}`,
).join('\n')
