/**
 * 扁平模板 pass —— 处理不连续的三段式构式。
 *
 * 这些构式里的「的」不属于最近的操作数：「以二为底八的对数」中，「的」管的是
 * 「以二为底八」整个结构，不是「八」。递归下降的后缀前瞻看不到这种跨度，
 * 硬塞进文法会很别扭。好在它们全都不递归，用模板在扁平 token 流上一次性消掉最干净。
 *
 * 本层跑在分词之后、文法之前，产出 expr token 交给文法当普通操作数。
 */
import type { Token } from './tokenizer'

/** 能充当模板操作数的 token——单个数值、常量或已生成的子表达式。 */
function operandOf(token: Token | undefined): string | null {
  if (!token) return null
  if (token.kind === 'number') return formatNumber(token.value)
  if (token.kind === 'constant') return token.name
  if (token.kind === 'expr') return token.canonical
  return null
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

function expr(canonical: string, text: string): Token {
  return { kind: 'expr', canonical, text }
}

type Rule = (tokens: Token[], at: number) => { token: Token; consumed: number } | null

/**
 * 规则按特异性从高到低排列——更长、更具体的模式必须先匹配。
 * 「二又三分之一」要先于「三分之一」，否则带分数会被拆散。
 */
const RULES: Rule[] = [
  ruleMixedFraction,
  rulePercentOf,
  ruleFractionOf,
  ruleLogarithmWithBase,
  ruleRemainder,
  ruleDiscount,
  // 相对变化要排在 ruleTenth 之后才能拿到展开好的「两成」，
  // 但 onePass 会反复扫描到不动点，顺序在这里只影响收敛轮数
  ruleRelativeChange,
  ruleTenth,
  ruleDegree,
]

export function applyPatterns(tokens: Token[]): Token[] {
  let current = tokens
  // 反复扫描直到不动点：模板产出的 expr 可能让外层模板成立，
  // 例如「百分之二十的平方」里 PERCENT_OF 先消解，「的平方」才轮到文法处理。
  for (let round = 0; round < 8; round++) {
    const next = onePass(current)
    if (next.length === current.length) return next
    current = next
  }
  return current
}

function onePass(tokens: Token[]): Token[] {
  const out: Token[] = []
  let i = 0

  while (i < tokens.length) {
    const hit = RULES.reduce<{ token: Token; consumed: number } | null>(
      (found, rule) => found ?? rule(tokens, i),
      null,
    )
    if (hit) {
      out.push(hit.token)
      i += hit.consumed
    } else {
      out.push(tokens[i])
      i += 1
    }
  }

  return out
}

/** 二又三分之一 → (2+(1/3)) */
function ruleMixedFraction(tokens: Token[], at: number) {
  const whole = operandOf(tokens[at])
  if (whole === null) return null
  if (tokens[at + 1]?.kind !== 'keyword' || (tokens[at + 1] as { tag: string }).tag !== 'MIXED_FRACTION') return null

  const denominator = operandOf(tokens[at + 2])
  if (denominator === null) return null
  if (tokens[at + 3]?.kind !== 'keyword' || (tokens[at + 3] as { tag: string }).tag !== 'FRACTION_OF') return null

  const numerator = operandOf(tokens[at + 4])
  if (numerator === null) return null

  const text = tokens.slice(at, at + 5).map((t) => t.text).join('')
  return { token: expr(`(${whole}+(${numerator})/(${denominator}))`, text), consumed: 5 }
}

/** 百分之二十 → (20/100)。展开成显式算式，不依赖引擎的 % —— mathjs 的 `50%(13)` 是取模。 */
function rulePercentOf(tokens: Token[], at: number) {
  const token = tokens[at]
  if (token?.kind !== 'keyword' || token.tag !== 'PERCENT_OF') return null
  const value = operandOf(tokens[at + 1])
  if (value === null) return null
  const text = token.text + tokens[at + 1].text
  return { token: expr(`((${value})/100)`, text), consumed: 2 }
}

/** 三分之一 → (1/3)。注意中文语序倒转：分母在前。 */
function ruleFractionOf(tokens: Token[], at: number) {
  const denominator = operandOf(tokens[at])
  if (denominator === null) return null
  const keyword = tokens[at + 1]
  if (keyword?.kind !== 'keyword' || keyword.tag !== 'FRACTION_OF') return null
  const numerator = operandOf(tokens[at + 2])
  if (numerator === null) return null

  const text = tokens.slice(at, at + 3).map((t) => t.text).join('')
  return { token: expr(`((${numerator})/(${denominator}))`, text), consumed: 3 }
}

/** 以二为底八的对数 → log(8,2) */
function ruleLogarithmWithBase(tokens: Token[], at: number) {
  const prefix = tokens[at]
  if (prefix?.kind !== 'keyword' || prefix.tag !== 'BASE_PREFIX') return null

  const base = operandOf(tokens[at + 1])
  if (base === null) return null
  if (tokens[at + 2]?.kind !== 'keyword' || (tokens[at + 2] as { tag: string }).tag !== 'BASE_SUFFIX') return null

  const value = operandOf(tokens[at + 3])
  if (value === null) return null

  // 「的对数」尾巴可省略：以二为底八 也认
  let consumed = 4
  if (
    tokens[at + 4]?.kind === 'keyword' && (tokens[at + 4] as { tag: string }).tag === 'DE' &&
    tokens[at + 5]?.kind === 'keyword' && (tokens[at + 5] as { tag: string }).tag === 'LOGARITHM'
  ) {
    consumed = 6
  }

  const text = tokens.slice(at, at + consumed).map((t) => t.text).join('')
  return { token: expr(`log(${value},${base})`, text), consumed }
}

/**
 * 余数的三种说法：
 *   一百除以七的余数 / 一百模七 / 十对三取余
 * 「除以…的余数」里的「的」管的是整个「一百除以七」，不是「七」——
 * 这正是递归下降的后缀前瞻看不到、需要扁平模板处理的跨度。
 */
function ruleRemainder(tokens: Token[], at: number) {
  const dividend = operandOf(tokens[at])
  if (dividend === null) return null

  const op = tokens[at + 1]

  // 十对三取余
  if (op?.kind === 'keyword' && op.tag === 'AGAINST') {
    const divisor = operandOf(tokens[at + 2])
    if (divisor === null) return null
    const modOp = tokens[at + 3]
    if (modOp?.kind !== 'operator' || modOp.op !== 'mod') return null
    const text = tokens.slice(at, at + 4).map((t) => t.text).join('')
    return { token: expr(`mod(${dividend},${divisor})`, text), consumed: 4 }
  }

  const isDivide = op?.kind === 'operator' && op.op === '/'
  const isMod = op?.kind === 'operator' && op.op === 'mod'
  if (!isDivide && !isMod) return null

  const divisor = operandOf(tokens[at + 2])
  if (divisor === null) return null

  if (isMod) {
    const text = tokens.slice(at, at + 3).map((t) => t.text).join('')
    return { token: expr(`mod(${dividend},${divisor})`, text), consumed: 3 }
  }

  // 除以 …… 的余数
  if (tokens[at + 3]?.kind !== 'keyword' || (tokens[at + 3] as { tag: string }).tag !== 'DE') return null
  if (tokens[at + 4]?.kind !== 'keyword' || (tokens[at + 4] as { tag: string }).tag !== 'REMAINDER') return null

  const text = tokens.slice(at, at + 5).map((t) => t.text).join('')
  return { token: expr(`mod(${dividend},${divisor})`, text), consumed: 5 }
}

/**
 * 打折与涨跌——中文里明确的相对百分比表达。
 *
 * 注意不照搬 libqalculate 的 `100 + 10% = 110`：中文的「加」是字面加法，
 * 「一百加百分之十」就是 100.1。真正表示相对变化的是「涨/降/打折」，
 * 只对这些说法做相对处理，语义才和中文直觉对得上。
 *
 *   一百打八折     → 100*(8/10) = 80
 *   一百涨百分之十 → 100*(1+10/100) = 110
 *   一百降两成     → 100*(1-2/10) = 80
 */
function ruleDiscount(tokens: Token[], at: number) {
  const base = operandOf(tokens[at])
  if (base === null) return null

  const prefix = tokens[at + 1]
  if (prefix?.kind !== 'keyword' || prefix.tag !== 'DISCOUNT_PREFIX') return null
  const rate = tokens[at + 2]
  if (rate?.kind !== 'number') return null
  const suffix = tokens[at + 3]
  if (suffix?.kind !== 'keyword' || suffix.tag !== 'DISCOUNT') return null

  const text = tokens.slice(at, at + 4).map((t) => t.text).join('')
  return { token: expr(`((${base})*((${rate.value})/10))`, text), consumed: 4 }
}

/** 一百涨百分之十 → 110；一百降两成 → 80。 */
function ruleRelativeChange(tokens: Token[], at: number) {
  const base = operandOf(tokens[at])
  if (base === null) return null

  const direction = tokens[at + 1]
  if (direction?.kind !== 'keyword') return null
  if (direction.tag !== 'INCREASE_BY' && direction.tag !== 'DECREASE_BY') return null

  // 幅度必须是已展开的比例（百分之十 → (10/100)、两成 → (2/10)）。
  // 只认 expr 是刻意的：这样本规则天然让位给 rulePercentOf / ruleTenth 先跑一轮，
  // 靠 onePass 的不动点迭代分两轮完成，不必在规则表里排顺序。
  const rate = tokens[at + 2]
  if (rate?.kind !== 'expr') return null
  const amount = rate.canonical

  const sign = direction.tag === 'INCREASE_BY' ? '+' : '-'
  const text = tokens.slice(at, at + 3).map((t) => t.text).join('')
  return { token: expr(`((${base})*(1${sign}(${amount})))`, text), consumed: 3 }
}

/**
 * 三成 → 0.3。
 *
 * 只在「成」后面不跟数字时成立。「成」和「乘」同音，语音识别经常混淆
 * （「二乘以三」→「二成一三」），若无条件吞掉「X成」，后面的数就会悬空，
 * 整句报一个和真实原因无关的错。留给下游报错或转交 AI 纠音更诚实。
 */
function ruleTenth(tokens: Token[], at: number) {
  const value = tokens[at]
  if (value?.kind !== 'number') return null
  const suffix = tokens[at + 1]
  if (suffix?.kind !== 'keyword' || suffix.tag !== 'TENTH') return null

  const following = tokens[at + 2]
  if (following?.kind === 'number' || following?.kind === 'expr') return null

  const text = value.text + suffix.text
  return { token: expr(`((${value.value})/10)`, text), consumed: 2 }
}

/** 三十度 → (30*pi/180)。角度制在这里就地转弧度，下游只见弧度。 */
function ruleDegree(tokens: Token[], at: number) {
  const value = operandOf(tokens[at])
  if (value === null) return null
  const suffix = tokens[at + 1]
  if (suffix?.kind !== 'keyword' || suffix.tag !== 'DEGREE') return null

  const text = tokens[at].text + suffix.text
  return { token: expr(`((${value})*pi/180)`, text), consumed: 2 }
}
