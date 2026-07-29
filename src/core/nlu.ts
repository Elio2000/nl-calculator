/**
 * 中文 → 规范表达式的编排层。
 *
 * 五步流水线：归一化 → 分词 → 意图分流 → 扁平模板 → 递归下降文法。
 * 输出是候选列表而不是单个结果：解析出多种读法时（典型是裸「除」），
 * 全部交给用户点选，而不是替他猜。
 */
import { normalize, stripFillers, tokenize, TokenizeError, type Token } from './tokenizer'
import { applyPatterns } from './patterns'
import { parseTokens, ParseError } from './parser'
import { classify } from './intent'
import { validate } from '../engines/mathEngine'

export interface Candidate {
  /** 规范表达式，可直接送引擎。 */
  expression: string
  /** 这条读法的中文说明，用于候选卡。 */
  reading: string
}

/** 普通求值。 */
export interface EvaluateRequest {
  kind: 'evaluate'
  candidates: Candidate[]
}

/** 解方程。 */
export interface SolveRequest {
  kind: 'solve'
  left: string
  right: string
  variable: string
  /** 式子里的其它未知数。非空时解只能用它们表示，而非具体数值。 */
  otherVariables: string[]
}

/** 求导 / 积分。 */
export interface CalculusRequest {
  kind: 'calculus'
  operation: 'diff' | 'integrate'
  expression: string
  variable: string
}

export type NluResult =
  | { ok: true; request: EvaluateRequest | SolveRequest | CalculusRequest }
  | { ok: false; reason: string }

/** 裸「除」的两种读法，文案要让用户一眼看懂差别。 */
const AMBIGUOUS_READINGS: Record<string, string> = {
  '/': '前面的数除以后面的数',
  '\\': '前面的数去除后面的数（数学上的「除」）',
}

export function understand(input: string): NluResult {
  const cleaned = stripFillers(normalize(input))
  if (!cleaned) {
    return { ok: false, reason: '没有看到要计算的内容' }
  }

  let tokens: Token[]
  try {
    tokens = tokenize(cleaned)
  } catch (error) {
    if (error instanceof TokenizeError) return { ok: false, reason: error.message }
    throw error
  }

  if (tokens.length === 0) {
    return { ok: false, reason: '没有看到要计算的内容' }
  }

  const intent = classify(tokens)

  if (intent.kind === 'solve') {
    const left = parseSide(intent.left)
    const right = parseSide(intent.right)
    if (!left || !right) {
      return { ok: false, reason: '方程的两边我没读懂' }
    }
    return {
      ok: true,
      request: {
        kind: 'solve',
        left,
        right,
        variable: intent.variable,
        otherVariables: intent.otherVariables,
      },
    }
  }

  if (intent.kind === 'calculus') {
    const expression = parseSide(intent.tokens)
    if (!expression) {
      return { ok: false, reason: '要计算的式子我没读懂' }
    }
    return {
      ok: true,
      request: {
        kind: 'calculus',
        operation: intent.operation,
        expression,
        variable: intent.variable,
      },
    }
  }

  return understandEvaluation(intent.tokens)
}

function understandEvaluation(tokens: Token[]): NluResult {
  // 一句话里出现多个歧义词时，候选会呈组合爆炸（两个「除」就是四种读法），
  // 与其摆一堆看不懂的卡片，不如请用户把话说清楚。
  // 关键是绝不能只展开第一个而把其余的悄悄定下来。
  const ambiguousCount = tokens.filter((token) => token.kind === 'ambiguous').length
  if (ambiguousCount > 1) {
    return {
      ok: false,
      reason: '这句话里有多处「除」，读法太多了。说成「除以」我就能确定顺序',
    }
  }

  const variants = expandAmbiguous(tokens)
  const candidates: Candidate[] = []
  let firstError: string | null = null

  for (const variant of variants) {
    try {
      const expression = parseTokens(applyPatterns(variant.tokens))
      // 文法产出的串必须能过引擎白名单，两层校验之间不留缝隙。
      validate(expression)
      if (!candidates.some((c) => c.expression === expression)) {
        candidates.push({ expression, reading: variant.reading })
      }
    } catch (error) {
      firstError ??= error instanceof ParseError ? error.message : (error as Error).message
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: firstError ?? '这句话我没读懂' }
  }

  return { ok: true, request: { kind: 'evaluate', candidates } }
}

/** 方程/微积分的一侧：允许出现变量，因此不过 mathjs 的白名单校验。 */
function parseSide(tokens: Token[]): string | null {
  if (tokens.length === 0) return null
  try {
    return parseTokens(applyPatterns(tokens))
  } catch {
    return null
  }
}

interface Variant {
  tokens: Token[]
  reading: string
}

/**
 * 把歧义 token 展开成多个 token 流。
 * 目前只有裸「除」一处，但机制是通用的：任何一个 token 有多种读法都能走这里。
 */
function expandAmbiguous(tokens: Token[]): Variant[] {
  const index = tokens.findIndex((token) => token.kind === 'ambiguous')
  if (index === -1) return [{ tokens, reading: '' }]

  const ambiguous = tokens[index] as Extract<Token, { kind: 'ambiguous' }>
  return ambiguous.ops.map((op) => ({
    tokens: tokens.map((token, i) =>
      i === index ? ({ kind: 'operator', op, text: token.text } as Token) : token,
    ),
    reading: AMBIGUOUS_READINGS[op] ?? '',
  }))
}
