/**
 * 中文算式文法（递归下降）→ 规范表达式。
 *
 * 输出一律全括号。中文的「的…次方」链是从左往右读的（二的三次方的二次方 = (2³)²），
 * 而 mathjs 的 `^` 右结合，靠全括号锁死解读，下游无法重新理解成别的意思。
 *
 * 词表是数据（lexicon.json），文法是代码（本文件）——因为优先级、就近绑定和
 * 递归这三件事，模板表达不了。
 */
import type { Token } from './tokenizer'

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

/** 「的」后缀构式表。按特异性排序：更长、更具体的模式必须排在前面。 */
interface SuffixRule {
  /** 「的」之后需要匹配的关键词标签序列，NUM 表示一个数值操作数。 */
  shape: string[]
  build: (base: string, operand?: string) => string
}

const SUFFIX_RULES: SuffixRule[] = [
  // 的 N 次方根 —— 必须先于「的 N 次方」，两者前两个 token 完全相同
  {
    shape: ['NUM', 'NTH_ROOT'],
    build: (base, n) => nthRootOf(base, n as string),
  },
  // 幂必须整体包裹。中文「二的三次方的二次方」是从左往右读的 (2³)²，
  // 少一层括号就会被 mathjs 的右结合重新解读成 2^(3²)——差 448。
  { shape: ['NUM', 'POWER'], build: (base, n) => `(${base}^(${n}))` },
  { shape: ['NUM', 'TIMES_NOUN'], build: (base, n) => `(${base}*(${n}))` },
  { shape: ['SQUARE'], build: (base) => `(${base}^(2))` },
  { shape: ['CUBE'], build: (base) => `(${base}^(3))` },
  { shape: ['SQRT'], build: (base) => `sqrt(${base})` },
  { shape: ['CBRT'], build: (base) => `cbrt(${base})` },
  { shape: ['FACTORIAL'], build: (base) => `factorial(${base})` },
  { shape: ['RECIPROCAL'], build: (base) => `((1)/${base})` },
  // 的绝对值 / 的正弦 —— 「的 + 函数名」是通用结构，不必逐个函数列进表里
  { shape: ['FUNC'], build: (base, fn) => `${fn}(${base})` },
]

/**
 * 偶次根走 sqrt 而非 nthRoot：mathjs 的 nthRoot(-4,2) 直接抛错，
 * 而 sqrt(-4) 会提升成 2i，与「根号负四」的行为保持一致。
 * 奇次根保留 nthRoot——nthRoot(-8,3) 给 -2，符合直觉，而 (-8)^(1/3) 会给复主根。
 */
function nthRootOf(base: string, n: string): string {
  if (n === '2') return `sqrt(${base})`
  return `nthRoot(${base},${n})`
}

const NOUN_OPERATORS: Record<string, string> = {
  SUM_NOUN: '+',
  DIFF_NOUN: '-',
  PRODUCT_NOUN: '*',
  QUOTIENT_NOUN: '/',
}

class Parser {
  private pos = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  parse(): string {
    const value = this.parseExpression()
    if (this.pos < this.tokens.length) {
      throw new ParseError(`"${this.tokens[this.pos].text}" 放在这里读不通`)
    }
    return value
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private isKeyword(token: Token | undefined, tag: string): boolean {
    return token?.kind === 'keyword' && token.tag === tag
  }

  /** expr := term (('+'|'-') term)* ，并处理「再/然后」把左侧整体括起 */
  private parseExpression(): string {
    let left = this.parseTerm()

    for (;;) {
      const token = this.peek()

      // 顺序词：「三加五再乘二」中的「再」意味着后面的运算作用于前面的全部结果
      if (this.isKeyword(token, 'THEN')) {
        this.pos += 1
        const operator = this.peek()
        if (operator?.kind !== 'operator' && operator?.kind !== 'ambiguous') {
          throw new ParseError('「再」后面要接一个运算')
        }
        this.pos += 1
        const right = this.parseTerm()
        left = combine(left, operatorOf(operator), right)
        continue
      }

      if (token?.kind === 'operator' && (token.op === '+' || token.op === '-')) {
        this.pos += 1
        const right = this.parseTerm()
        left = combine(left, token.op, right)
        continue
      }

      return left
    }
  }

  /** term := unary (('*'|'/'|mod) unary)* */
  private parseTerm(): string {
    let left = this.parseUnary()

    for (;;) {
      const token = this.peek()
      // '\' 是裸「除」展开出的反向除法，与乘除同级
      const isBinary =
        (token?.kind === 'operator' && ['*', '/', 'mod', '\\'].includes(token.op)) ||
        token?.kind === 'ambiguous'
      if (!isBinary) return left

      this.pos += 1
      const right = this.parseUnary()
      left = combine(left, operatorOf(token as Token), right)
    }
  }

  /**
   * unary := 负? postfix
   *
   * 「负」紧贴数字时合成负数字面量（负二的平方 = (-2)² = 4），
   * 隔着「的」时才是一元负号（负的二的平方 = -(2²) = -4）。
   * 这个区分决定了整个 unary/power 的层次关系，是文法的形状约束。
   */
  private parseUnary(): string {
    const token = this.peek()

    // 走到这一层的 '-' 一定是一元负号——二元减法在 parseExpression 就消费掉了。
    // 语音识别常把「负二」写成「-2」，这条让那种输入也能解析。
    if (token?.kind === 'operator' && token.op === '-') {
      this.pos += 1
      const next = this.peek()
      if (next?.kind === 'number') {
        this.pos += 1
        return this.parsePostfixFrom(`(-${next.value})`)
      }
      return `-(${this.parseUnary()})`
    }

    if (!this.isKeyword(token, 'NEGATIVE')) return this.parsePostfix()

    this.pos += 1

    if (this.isKeyword(this.peek(), 'DE')) {
      this.pos += 1
      return `-(${this.parseUnary()})`
    }

    const next = this.peek()
    if (next?.kind === 'number') {
      this.pos += 1
      return this.parsePostfixFrom(`(-${next.value})`)
    }

    return `-(${this.parseUnary()})`
  }

  /** postfix := primary ('的' 后缀构式)* */
  private parsePostfix(): string {
    return this.parsePostfixFrom(this.parsePrimary())
  }

  private parsePostfixFrom(base: string): string {
    let value = base

    for (;;) {
      const applied = this.tryApplyDeSuffix(value) ?? this.tryApplyBareSuffix(value)
      if (applied === null) return value
      value = applied
    }
  }

  /** 不带「的」的后缀：五阶乘、八开方、八开三次方。 */
  private tryApplyBareSuffix(base: string): string | null {
    const token = this.peek()
    if (token?.kind !== 'keyword') return null

    switch (token.tag) {
      case 'SQRT':
        this.pos += 1
        return `sqrt(${base})`
      case 'CBRT':
        this.pos += 1
        return `cbrt(${base})`
      case 'FACTORIAL':
        this.pos += 1
        return `factorial(${base})`
      // 「x平方」是口语常态，不像「三的平方」那样带「的」
      case 'SQUARE':
        this.pos += 1
        return `(${base}^(2))`
      case 'CUBE':
        this.pos += 1
        return `(${base}^(3))`
      case 'OPEN_ROOT': {
        // 八开三次方 → nthRoot(8,3)
        const degree = this.peek(1)
        if (degree?.kind !== 'number') return null
        if (!this.isKeyword(this.peek(2), 'POWER')) return null
        this.pos += 3
        return nthRootOf(base, String(degree.value))
      }
      default:
        return null
    }
  }

  /** 有序前瞻：从「的」往后看至多 3 个 token，第一条形状吻合的规则胜出。 */
  private tryApplyDeSuffix(base: string): string | null {
    if (!this.isKeyword(this.peek(), 'DE')) return null

    for (const rule of SUFFIX_RULES) {
      const match = this.matchShape(rule.shape)
      if (match === null) continue
      this.pos += 1 + rule.shape.length
      return rule.build(base, match)
    }

    // 「的」后面跟着看不懂的东西——报错而不是静默跳过，否则用户会拿到一个
    // 悄悄丢掉了半句话的结果。
    const next = this.peek(1)
    throw new ParseError(next ? `不认识「的${next.text}」这种说法` : '「的」后面缺少内容')
  }

  /** 匹配「的」之后的 token 形状，返回其中的操作数（数值或函数名，若有）。 */
  private matchShape(shape: string[]): string | null {
    let operand: string | null = null

    for (let i = 0; i < shape.length; i++) {
      const token = this.peek(1 + i)
      const expected = shape[i]

      if (expected === 'NUM') {
        if (token?.kind === 'number') {
          operand = String(token.value)
          continue
        }
        if (token?.kind === 'expr') {
          operand = token.canonical
          continue
        }
        // 指数也可以是未知数：「2的x次方」用在指数方程里
        if (token?.kind === 'variable') {
          operand = token.name
          continue
        }
        return null
      }

      if (expected === 'FUNC') {
        if (token?.kind !== 'function') return null
        operand = token.name
        continue
      }

      if (!this.isKeyword(token, expected)) return null
    }

    return operand ?? ''
  }

  /**
   * primary := 名词形分组 | 数值 | 常量 | 子表达式 | 函数应用 | 括号
   */
  private parsePrimary(): string {
    const nounGroup = this.tryParseNounGroup()
    if (nounGroup !== null) return nounGroup

    const token = this.peek()
    if (!token) throw new ParseError('算式不完整')

    switch (token.kind) {
      case 'number':
        this.pos += 1
        return `(${token.value})`

      case 'constant':
        this.pos += 1
        return token.name

      case 'variable':
        this.pos += 1
        return token.name

      case 'expr':
        this.pos += 1
        return token.canonical

      case 'paren': {
        if (token.value !== '(') throw new ParseError('多了一个右括号')
        this.pos += 1
        const inner = this.parseExpression()
        const closing = this.peek()
        if (closing?.kind !== 'paren' || closing.value !== ')') {
          throw new ParseError('括号没有闭合')
        }
        this.pos += 1
        return `(${inner})`
      }

      case 'function': {
        this.pos += 1
        // 函数就近绑定最小完整操作数：「根号四加五」= √4+5。
        // 走 unary 而非 postfix，「根号负四」里的负号才能被吃进参数。
        // 想要大范围作用有三条出口：显式括号、名词形「…的和」、顺序词「再」。
        const argument = this.parseUnary()
        return `${token.name}(${argument})`
      }

      default:
        throw new ParseError(`"${token.text}" 放在这里读不通`)
    }
  }

  /**
   * 名词形分组：简单操作数 与 简单操作数 的 (和|差|积|商)。
   * 它是中文里的天然括号——「三与五的和乘以二」= (3+5)*2。
   * 只支持简单操作数，更复杂的嵌套干净地失败并走候选/兜底，而不是猜。
   */
  private tryParseNounGroup(): string | null {
    const left = this.peek()
    if (left?.kind !== 'number' && left?.kind !== 'constant' && left?.kind !== 'expr') return null
    if (!this.isKeyword(this.peek(1), 'AND_NOUN')) return null

    const right = this.peek(2)
    if (right?.kind !== 'number' && right?.kind !== 'constant' && right?.kind !== 'expr') return null
    if (!this.isKeyword(this.peek(3), 'DE')) return null

    const noun = this.peek(4)
    if (noun?.kind !== 'keyword') return null
    const operator = NOUN_OPERATORS[noun.tag]
    if (!operator) return null

    this.pos += 5
    return `(${operandText(left)}${operator}${operandText(right)})`
  }
}

function operandText(token: Token): string {
  if (token.kind === 'number') return `(${token.value})`
  if (token.kind === 'constant') return token.name
  if (token.kind === 'expr') return token.canonical
  throw new ParseError('这里需要一个数')
}

function operatorOf(token: Token): string {
  if (token.kind === 'operator') return token.op
  // 歧义 token 必须在 nlu 层展开成候选后才能进文法。
  // 这里若还看得到它，说明有一处歧义被漏掉了——宁可报错，
  // 也不能挑第一种读法蒙混过去。
  if (token.kind === 'ambiguous') {
    throw new ParseError(`"${token.text}" 有多种读法，无法直接计算`)
  }
  throw new ParseError('这里需要一个运算符')
}

function combine(left: string, operator: string, right: string): string {
  if (operator === 'mod') return `mod(${left},${right})`
  // 反向除法：裸「除」的数学读法 A除B = B/A
  if (operator === '\\') return `(${right})/(${left})`
  return `(${left}${operator}${right})`
}

export function parseTokens(tokens: Token[]): string {
  return new Parser(tokens).parse()
}
