/**
 * 规范表达式求值引擎。
 *
 * "规范表达式"是 mathjs 语法的一个白名单子集：显式乘号、完整括号、
 * 只允许下表中的函数与常量，禁止赋值、函数定义、索引、数组等一切非计算构造。
 * 中文构式层与 LLM 归一化层都以它为输出目标，因此这里的校验既是安全边界，
 * 也是两条上游链路共用的契约。
 */
import { create, all, type MathNode } from 'mathjs'

/** 允许出现在规范表达式里的函数。导出是给契约层做「白名单 ⊇ 对外承诺」的一致性测试。 */
export const ALLOWED_FUNCTIONS = new Set([
  'abs', 'sqrt', 'cbrt', 'nthRoot', 'exp', 'log', 'log10', 'log2',
  'factorial', 'gamma',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sec', 'csc', 'cot', 'asec', 'acsc', 'acot',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'sech', 'csch', 'coth',
  'round', 'floor', 'ceil', 'fix', 'sign',
  'gcd', 'lcm', 'min', 'max', 'mod', 'hypot',
  'combinations', 'permutations',
  're', 'im', 'arg', 'conj',
])

/** 允许出现在规范表达式里的常量符号。 */
const ALLOWED_CONSTANTS = new Set(['pi', 'e', 'i', 'tau', 'phi'])

/** 允许的运算符节点（OperatorNode.fn）。 */
const ALLOWED_OPERATORS = new Set([
  'add', 'subtract', 'multiply', 'divide', 'pow', 'mod',
  'unaryMinus', 'unaryPlus', 'factorial',
])

/** 结果里超出此位数的部分视为数值噪声，展示前统一修约。 */
export const DISPLAY_PRECISION = 12

/**
 * 精确整数完整显示的位数上限。
 * 超过就转科学计数法并标成近似——但要注意那时它**仍然是精确值**，
 * 只是展示形式换了，所以文案用「约」而不是假装精确。
 */
const EXACT_INTEGER_DIGITS = 50

/**
 * 复核判据：换成双倍精度重算，结果缩小超过这个倍数就认定真值是 0。
 *
 * 噪声随精度提高而缩小（sin(pi) 从 3e-64 掉到 9.6e-129，缩小 3e-65 倍），
 * 真实的数则纹丝不动（(1/e)^200 两种精度都是 1.384e-87）。
 *
 * 注意判据只看**比值**，不看绝对大小——曾经先用「结果 < 1e-10」筛一道再复核，
 * 于是 `sin(pi)*10^100` 的噪声被放大到 3e36、压根不触发复核，
 * 一个本该是 0 的式子答成了三万亿亿亿亿。噪声可以被放大到任意大，
 * 绝对阈值在这里根本不成立。
 */
const ZERO_SHRINK_RATIO = 1e-6

/**
 * 复数分量的噪声判据：小于「本通道量级 × 这个比值」才算舍入残渣。
 *
 * 取 double 舍入单位（2^-53 ≈ 2.2e-16）的 32 倍，给多步运算的误差累积留余量。
 * 两侧都留着数量级的空档：`e^(i*pi)` 的虚部相对量级是 3.9e-17（比判据小 180 倍），
 * `1+i/10^13` 的虚部相对量级是 1e-13（比判据大 14 倍）。
 */
const COMPLEX_NOISE_RATIO = 32 * Number.EPSILON

/** 估算复数通道量级时最多算多少个子式，防止巨大表达式被逐个子树重算拖垮。 */
const SCALE_SAMPLE_LIMIT = 64

const bigMath = create(all, { number: 'BigNumber', precision: 64 })
const fracMath = create(all, { number: 'Fraction' })
/** 只用于复核可疑的零，不参与正常求值。 */
const checkMath = create(all, { number: 'BigNumber', precision: 128 })
/** double 模式，只用于预算检查时快速估算指数大小。 */
const numberMath = create(all, { number: 'number' })

/**
 * 第三道复核（256 位），只有 128 位复核发现结果缩水时才用得上。
 * 惰性创建：绝大多数式子走不到这一步，而每建一个 mathjs 实例都要付一次启动开销。
 */
let deepMathInstance: ReturnType<typeof create> | null = null
function deepMath(): ReturnType<typeof create> {
  deepMathInstance ??= create(all, { number: 'BigNumber', precision: 256 })
  return deepMathInstance
}

/** 表达式不符合规范子集。 */
export class ExpressionError extends Error {
  readonly detail?: string

  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'ExpressionError'
    this.detail = detail
  }
}

/** 求值过程中的数学错误（除零、定义域越界等）。 */
export class MathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MathError'
  }
}

/**
 * 结果是精确值还是近似值。
 *
 * 这个区分必须一路带到展示层：`√2 = 1.41421356237` 用等号是在撒谎，
 * 那是修约过的近似值，该写 `≈`。反过来 `30!` 是精确整数，
 * 不该被有效数字修约成科学计数法。
 */
export type EvalValue =
  /** 精确有理数，能同时给出分数形与小数形。 */
  | {
      kind: 'rational'
      fraction: string
      decimal: string
      approx: number
      isInteger: boolean
      exact: true
    }
  /**
   * 实数。exact=false 表示 decimal 是修约过的近似值。
   *
   * ⚠️ approx 是 JS number，超出 ±1.8e308 会变 Infinity、小于 5e-324 会变 0。
   * 判断大小或格式化时**以 decimal 为准**，approx 只用于粗略比较。
   */
  | { kind: 'real'; decimal: string; approx: number; exact: boolean }
  /** 复数。 */
  | {
      kind: 'complex'
      re: string
      im: string
      text: string
      approxRe: number
      approxIm: number
      exact: boolean
    }

export interface EvalOutcome {
  /** 送进引擎的规范表达式。 */
  expression: string
  /** 供 UI 渲染的 LaTeX。 */
  tex: string
  value: EvalValue
}

/**
 * 计算量预算。
 *
 * 白名单只管「能不能算」，不管「算多久」——`factorial(100000000)` 和 `9^(9^9)`
 * 都是合法表达式，但会在 UI 主线程上算到浏览器卡死。中文里说一句
 * 「一亿的阶乘」就能触发，LLM 候选也可能生成。
 */
const LIMITS = {
  /** 输入长度。 */
  expressionChars: 2000,
  /** AST 节点数，防止深度嵌套。 */
  astNodes: 500,
  /** 阶乘 / 排列组合的参数上限。1000! 已有 2568 位，够用了。 */
  factorialArgument: 1000,
  /** 指数上限。2^100000 有 3 万位，再大就没有展示价值了。 */
  exponent: 100000,
} as const

/** 校验表达式是否属于规范子集，返回解析后的 AST。 */
export function validate(expression: string): MathNode {
  return validateAllowing(expression, new Set())
}

/**
 * 检查计算量是否在预算内。只看得出常量参数的情况——
 * `factorial(x)` 这种要到运行时才知道，挡不住，但那类表达式走的是求解通道。
 */
function assertWithinBudget(root: MathNode, expression: string): void {
  if (expression.length > LIMITS.expressionChars) {
    throw new ExpressionError(`表达式太长了（超过 ${LIMITS.expressionChars} 字符）`)
  }

  let nodes = 0
  const walk = (node: MathNode): void => {
    nodes += 1
    if (nodes > LIMITS.astNodes) {
      throw new ExpressionError('表达式太复杂了，拆成几步来算吧')
    }

    if (node.type === 'FunctionNode') {
      const name = (node as unknown as { fn: { name?: string } }).fn?.name
      if (name === 'factorial' || name === 'combinations' || name === 'permutations') {
        const argument = estimateConstant((node as unknown as { args: MathNode[] }).args[0])
        if (argument !== null && argument > LIMITS.factorialArgument) {
          throw new ExpressionError(
            `${formatLimitNumber(argument)} 的阶乘要算很久，这里最大支持 ${LIMITS.factorialArgument}`,
          )
        }
      }
    }

    if (node.type === 'OperatorNode') {
      const fn = (node as unknown as { fn: string }).fn
      if (fn === 'factorial') {
        const argument = estimateConstant((node as unknown as { args: MathNode[] }).args[0])
        if (argument !== null && argument > LIMITS.factorialArgument) {
          throw new ExpressionError(
            `${formatLimitNumber(argument)} 的阶乘要算很久，这里最大支持 ${LIMITS.factorialArgument}`,
          )
        }
      }
      if (fn === 'pow') {
        const exponent = estimateConstant((node as unknown as { args: MathNode[] }).args[1])
        if (exponent !== null && Math.abs(exponent) > LIMITS.exponent) {
          throw new ExpressionError(
            `指数 ${formatLimitNumber(Math.abs(exponent))} 太大了，这里最大支持 ${LIMITS.exponent}`,
          )
        }
      }
    }

    node.forEach(walk)
  }

  walk(root)
}

/**
 * 估算一个纯常量子树的值，用于预算检查。
 *
 * 直接看字面量不够——`9^(9^9)` 的指数是个表达式，看不出它有多大。
 * 用 double 快速算一遍：`9^9` 秒出，真溢出也只会得到 Infinity，不会卡住。
 * 子树里有变量或函数就放弃估算（返回 null），那类表达式走别的通道。
 */
function estimateConstant(node: MathNode): number | null {
  const direct = constantValueOf(node)
  if (direct !== null) return direct

  let pure = true
  const check = (n: MathNode): void => {
    if (!pure) return
    if (n.type === 'SymbolNode' || n.type === 'FunctionNode') {
      pure = false
      return
    }
    n.forEach(check)
  }
  check(node)
  if (!pure) return null

  try {
    // number 模式是 double，快且溢出安全
    const value = Number(numberMath.evaluate(node.toString()))
    return Number.isNaN(value) ? null : value
  } catch {
    return null
  }
}

/** 超大数字在报错信息里用科学计数，免得刷屏。 */
function formatLimitNumber(value: number): string {
  return Number.isFinite(value) && Math.abs(value) < 1e15
    ? String(value)
    : value.toExponential(2)
}

/** 取节点的常量值；不是字面量（含括号与正负号）则返回 null。 */
function constantValueOf(node: MathNode): number | null {
  let current = node
  let sign = 1
  for (let guard = 0; guard < 8; guard++) {
    if (current.type === 'ParenthesisNode') {
      current = (current as unknown as { content: MathNode }).content
      continue
    }
    const fn = (current as unknown as { fn?: string }).fn
    if (current.type === 'OperatorNode' && (fn === 'unaryMinus' || fn === 'unaryPlus')) {
      if (fn === 'unaryMinus') sign = -sign
      current = (current as unknown as { args: MathNode[] }).args[0]
      continue
    }
    break
  }

  if (current.type !== 'ConstantNode') return null
  const value = Number(String((current as unknown as { value: unknown }).value))
  return Number.isFinite(value) ? sign * value : null
}

/**
 * 同上，但额外放行指定的未知数。
 *
 * 方程与微积分的表达式含 x，过不了纯求值的白名单，但**不能因此完全不校验**——
 * 否则 `f(x)` 里的未知函数 f 会一路走到 nerdamer，它把 f 当变量、
 * 求导得出一个无意义的 `f` 就端给用户了。
 */
export function validateAllowing(expression: string, variables: Set<string>): MathNode {
  if (!expression.trim()) {
    throw new ExpressionError('表达式为空')
  }

  let root: MathNode
  try {
    root = bigMath.parse(expression)
  } catch (error) {
    throw new ExpressionError('表达式语法错误', (error as Error).message)
  }

  walkForValidation(root, variables)
  assertWithinBudget(root, expression)
  return root
}

/**
 * 自顶向下校验。不用 node.forEach 的默认顺序，因为 FunctionNode 会把函数名
 * 当作子 SymbolNode 遍历，未知函数会先被报成"未知符号"，错误信息不准。
 */
function walkForValidation(node: MathNode, variables: Set<string>): void {
  assertNodeAllowed(node, variables)
  if (node.type === 'FunctionNode') {
    // 函数名已在 assertNodeAllowed 里校验过，只需继续检查实参。
    for (const arg of (node as unknown as { args: MathNode[] }).args) {
      walkForValidation(arg, variables)
    }
    return
  }
  node.forEach((child) => walkForValidation(child, variables))
}

function assertNodeAllowed(node: MathNode, variables: Set<string>): void {
  switch (node.type) {
    case 'ConstantNode':
    case 'ParenthesisNode':
      return

    case 'SymbolNode': {
      const name = (node as unknown as { name: string }).name
      // 函数名会同时以 SymbolNode 出现在 FunctionNode 下，两张白名单都放行。
      if (ALLOWED_CONSTANTS.has(name) || ALLOWED_FUNCTIONS.has(name)) return
      if (variables.has(name)) return
      throw new ExpressionError(`不支持的符号 "${name}"`)
    }

    case 'FunctionNode': {
      const name = (node as unknown as { fn: { name?: string } }).fn?.name
      if (name && ALLOWED_FUNCTIONS.has(name)) return
      throw new ExpressionError(`不支持的函数 "${name ?? '?'}"`)
    }

    case 'OperatorNode': {
      const fn = (node as unknown as { fn: string }).fn
      if (ALLOWED_OPERATORS.has(fn)) return
      throw new ExpressionError(`不支持的运算符 "${(node as unknown as { op: string }).op}"`)
    }

    default:
      // 赋值、函数定义、索引、数组、条件表达式等一律拒绝。
      throw new ExpressionError(`不支持的表达式结构 (${node.type})`)
  }
}

/**
 * 判断表达式是否为纯有理数运算——只有整数/小数字面量与四则、整数次幂。
 * 这类表达式走 Fraction 模式，好处是 1/3 能保持分数形而不是一串 0.333。
 */
function isPureRational(node: MathNode): boolean {
  let pure = true

  const walk = (n: MathNode): void => {
    if (!pure) return
    switch (n.type) {
      case 'ConstantNode':
      case 'ParenthesisNode':
        break
      case 'OperatorNode': {
        const fn = (n as unknown as { fn: string }).fn
        if (fn === 'pow') {
          const exponent = (n as unknown as { args: MathNode[] }).args[1]
          if (!isIntegerExponent(exponent)) pure = false
        } else if (!['add', 'subtract', 'multiply', 'divide', 'unaryMinus', 'unaryPlus'].includes(fn)) {
          pure = false
        }
        break
      }
      default:
        pure = false
    }
    if (pure) n.forEach(walk)
  }

  walk(node)
  return pure
}

/**
 * 指数是不是整数字面量（含负号与多余括号）。
 *
 * 曾经用 `Number.isInteger(constantNode.value)` 判断，但 BigNumber 模式下
 * `value` 是个 **BigNumber 对象**，`Number.isInteger(对象)` 恒为 false——
 * 于是所有幂运算都被排除出精确分数路径，`(1/3)^2` 从 `1/9` 退化成 0.111…。
 * 另一边负指数分支只检查了「是不是常量」，没检查是不是整数，
 * `10^-400.5` 会被错误地分到 Fraction 路径然后下溢成 0。
 */
function isIntegerExponent(node: MathNode): boolean {
  // 剥掉括号与一元正负号，取到真正的字面量
  let current = node
  for (let guard = 0; guard < 8; guard++) {
    if (current.type === 'ParenthesisNode') {
      current = (current as unknown as { content: MathNode }).content
      continue
    }
    const fn = (current as unknown as { fn?: string }).fn
    if (current.type === 'OperatorNode' && (fn === 'unaryMinus' || fn === 'unaryPlus')) {
      current = (current as unknown as { args: MathNode[] }).args[0]
      continue
    }
    break
  }

  if (current.type !== 'ConstantNode') return false

  const value = (current as unknown as { value: unknown }).value
  if (typeof value === 'number') return Number.isInteger(value)
  if (typeof value === 'bigint') return true
  // BigNumber 自带 isInteger()
  const asBig = value as { isInteger?: () => boolean }
  return typeof asBig?.isInteger === 'function' ? asBig.isInteger() : false
}

/** 表达式是否含超越函数或无理常量——决定是否启用零值吸附。 */
function hasTranscendental(node: MathNode): boolean {
  let found = false

  const walk = (n: MathNode): void => {
    if (found) return
    if (n.type === 'SymbolNode') {
      const name = (n as unknown as { name: string }).name
      if (name === 'pi' || name === 'e' || name === 'tau' || name === 'phi') found = true
    }
    if (n.type === 'FunctionNode') {
      const name = (n as unknown as { fn: { name?: string } }).fn?.name
      if (name && name !== 'abs' && name !== 'round' && name !== 'floor' && name !== 'ceil') {
        found = true
      }
    }
    if (!found) n.forEach(walk)
  }

  walk(node)
  return found
}

/** 求值一条规范表达式。 */
export function evaluate(expression: string): EvalOutcome {
  const root = validate(expression)
  const tex = toReadableTex(root)
  const useFraction = isPureRational(root)

  let raw: unknown
  try {
    const engine = useFraction ? fracMath : bigMath
    raw = engine.parse(expression).compile().evaluate({})
  } catch (error) {
    throw new MathError(translateEngineError((error as Error).message))
  }

  return {
    expression,
    tex,
    value: toEvalValue(raw, root, hasTranscendental(root) ? expression : null),
  }
}

/**
 * 实部、虚部各自那条通道上出现过的最大量级。
 *
 * 复数这边用不了实数那套「换更高精度重算」的判据：mathjs 的复数运算固定走 double，
 * 实测 precision 设 64 / 128 / 256 / 300 / 512，`e^(i*pi)` 的虚部都是同一个
 * 1.2246467991473532e-16，连 `complex(bignumber, bignumber)` 也会把分量降回 double。
 * 提高精度对复数**没有任何影响**，那条路是走不通的。
 *
 * 于是换一条同样是相对的判据：double 每步运算至多带来 2^-53 的相对误差，
 * 所以远小于「本通道自身量级」的分量只可能是舍入残渣。
 *
 * 两条通道必须分开算，这是关键：`10^20+i` 的虚部 1 相对于模长 1e20 小得离谱，
 * 但虚通道上压根没出现过大数（只有 i 自己），1 是真实数据。曾经按模长判断，
 * i 就凭空消失了。反过来 `1+i/10^13` 的虚部 1e-13 在虚通道上量级是 1，
 * 比舍入单位大三个数量级，同样必须留着。
 *
 * 已知盲区：被放大的复数噪声（`sin(pi)*i*10^100`）识别不了——它在虚通道上的
 * 量级就是被放大后的自己。实数那边靠提精度能识破，复数这边没有更高精度可用。
 * 这不是回退：改动前的固定阈值同样漏这一类。
 */
function channelScales(root: MathNode, result: { re: number; im: number }): { re: number; im: number } {
  // 结果自身也算一个量级样本，否则 sqrt(-4) 的虚通道量级会是 0
  let re = Math.abs(result.re)
  let im = Math.abs(result.im)
  let budget = SCALE_SAMPLE_LIMIT

  const walk = (node: MathNode): void => {
    if (budget <= 0) return
    budget -= 1
    const parts = componentsOf(evaluateQuietly(node))
    if (parts) {
      re = Math.max(re, Math.abs(parts.re))
      im = Math.max(im, Math.abs(parts.im))
    }
    node.forEach(walk)
  }

  walk(root)
  return { re, im }
}

/** 单独算一个子式，算不出来（定义域外、参数非法等）就当没这个样本。 */
function evaluateQuietly(node: MathNode): unknown {
  try {
    return bigMath.evaluate(node.toString())
  } catch {
    return null
  }
}

/** 取一个求值结果的实/虚分量；不是数就返回 null。 */
function componentsOf(value: unknown): { re: number; im: number } | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 're' in (value as object)) {
    const c = value as { re: number; im: number }
    return Number.isFinite(c.re) && Number.isFinite(c.im) ? { re: c.re, im: c.im } : null
  }
  const real = Number(String(value))
  return Number.isFinite(real) ? { re: real, im: 0 } : null
}

/**
 * 生成给人看的 LaTeX。
 *
 * 规范表达式为了锁死解读加满了括号，直接 toTex 会得到
 * `\left(\left(\left(1\right)+...` 这种没法读的东西。但括号只是文本层的防御，
 * AST 本身已无歧义——所以先摘掉显式括号节点，再让 mathjs 按运算优先级
 * 重新决定哪里真的需要括号。`(2^3)^2` 的那对括号会被正确保留。
 */
function toReadableTex(root: MathNode): string {
  const stripped = root.transform((node) =>
    node.type === 'ParenthesisNode'
      ? (node as unknown as { content: MathNode }).content
      : node,
  )
  return stripped.toTex({ parenthesis: 'auto' })
}

/**
 * 同上，但产出纯文本，用于复制与展示。
 *
 * 这里不做白名单校验——方程那一侧含未知数 x，本来就过不了白名单，
 * 但同样需要把括号收拾干净。安全边界由 validate 单独把守，
 * 这个函数只负责排版。
 */
export function toReadableText(expression: string): string {
  return simplifyParentheses(expression, (node) => node.toString({ parenthesis: 'auto' }))
}

/** 同上，产出 LaTeX。同样不校验，供方程等含变量的场合使用。 */
export function toReadableTexLoose(expression: string): string {
  return simplifyParentheses(expression, (node) => node.toTex({ parenthesis: 'auto' }))
}

function simplifyParentheses(expression: string, render: (node: MathNode) => string): string {
  const root = bigMath.parse(expression)
  const stripped = root.transform((node) =>
    node.type === 'ParenthesisNode'
      ? (node as unknown as { content: MathNode }).content
      : node,
  )
  return render(stripped)
}

function translateEngineError(message: string): string {
  if (/Division by Zero/i.test(message)) return '结果无穷大——除数不能为零'
  if (/non-negative/i.test(message)) return '阶乘只接受非负整数'
  if (/Integer expected/i.test(message)) return '这个运算需要整数参数'
  if (/Dimension|Matrix/i.test(message)) return '不支持矩阵运算'
  return message
}

/**
 * 高精度复核的三种结论。
 *
 * 只看「换精度后有没有缩小」是不够的——那只能区分「变了」和「没变」，
 * 而变小有两种截然不同的原因，答案一个是 0、一个是那个小量本身。
 */
type PrecisionVerdict =
  /** 精度越高越小，一路奔向零：这是数值噪声，真值就是 0。 */
  | { kind: 'noise' }
  /** 低精度那次被自身的舍入误差淹没了，高精度下收敛到一个稳定的小量。 */
  | { kind: 'converged'; decimal: string; approx: number }
  /** 换精度不改变结果：本来就不是噪声。 */
  | { kind: 'stable' }

/**
 * 判断结果是数值噪声、还是一个真实存在的极小量。
 *
 * 靠绝对阈值判断是错的，两个方向都会错：
 *   `(1/e)^200 = 1.4e-87` 极小但是真实的数
 *   `sin(pi)*10^100 = 3e36` 极大却是被放大的噪声
 * 所以判据是**换个精度再算一遍**：噪声会随精度提高而缩小，真值不会。
 *
 * 但「缩小了」还不足以判成噪声——这是本次修的洞。`sin(pi+10^-100)` 的真值
 * 约 -1e-100，64 位下被 pi 的舍入误差淹没、算出 3e-64，128 位才露出真身 -1e-100，
 * 相比之下缩了 1e-36 倍，于是被当成噪声吸附成 0：一个真实的答案被抹掉了。
 * 区分这两者要看第三次：噪声在 128→256 之间会继续按同样的量级缩小，
 * 真实的小量则纹丝不动（比值≈1）。
 *
 * 分辨率下限说清楚：真值若小到 128 位也认不出来（实测 `sin(pi+10^-250)` 在
 * 128 位下就是纯噪声 9.5e-129），这道复核仍会判成噪声、答 0。任何固定的精度阶梯
 * 都有这个底，只是把它从 64 位推到了 128 位。
 *
 * 代价是含超越函数的表达式要多算一到两次（128 / 256 位），毫秒级，交互场景可以接受。
 */
function classifyByPrecision(expression: string, baseValue: string): PrecisionVerdict {
  if (isZeroText(baseValue)) return { kind: 'stable' }

  const at128 = recomputeReal(checkMath, expression)
  if (at128 === null) return { kind: 'stable' }
  if (isZeroText(at128)) return { kind: 'noise' }
  // 比值算不出来（NaN）时也走 stable：复核不了就别乱动结果
  if (!(shrinkRatio(at128, baseValue) < ZERO_SHRINK_RATIO)) return { kind: 'stable' }

  const at256 = recomputeReal(deepMath(), expression)
  // 第三次算不出来（256 位下超出 Decimal 的表示范围等）就维持原判，
  // 与加这道复核之前的行为一致，不把能出结果的式子变成崩溃。
  if (at256 === null) return { kind: 'noise' }
  if (isZeroText(at256)) return { kind: 'noise' }
  if (shrinkRatio(at256, at128) < ZERO_SHRINK_RATIO) return { kind: 'noise' }

  // 128 ↔ 256 之间稳住了：这是真实的小量，用收敛后的值作答。
  // 它仍然是修约过的近似值，所以 exact=false 由调用方标注。
  const rounded = deepMath().bignumber(at256).toSignificantDigits(DISPLAY_PRECISION).toString()
  return { kind: 'converged', decimal: normalizeDecimalText(rounded), approx: Number(rounded) }
}

/** 用指定精度的实例重算，返回实数结果的字符串；复数/非数结果返回 null。 */
function recomputeReal(engine: ReturnType<typeof create>, expression: string): string | null {
  try {
    const raw = engine.evaluate(expression)
    // 复数结果不在这条路上处理
    if (typeof raw === 'object' && raw !== null && 're' in raw) return null
    const text = String(raw)
    return /^[+-]?(\d|\.\d)/.test(text) ? text : null
  } catch {
    return null
  }
}

/**
 * 两次结果的比值。刻意用 256 位实例做除法而不是转成 JS number——
 * 被比较的两个数可能是 3e-64 与 1e-100 这种超出 double 范围的量，
 * 转过去会双双下溢成 0，比值就成了没有意义的 NaN。比值本身总在正常范围内。
 */
function shrinkRatio(numerator: string, denominator: string): number {
  try {
    return Math.abs(Number(String(deepMath().evaluate(`(${numerator})/(${denominator})`))))
  } catch {
    return Number.NaN
  }
}

/** mathjs 打印出的精确零只有 "0" / "-0" / "0.000…" 这几种形态。 */
function isZeroText(text: string): boolean {
  return /^-?0(\.0+)?$/.test(text)
}

/**
 * 残差检查：`表达式 - 修约值` 若在高精度下趋近于零，说明修约没有损失真值。
 *
 * 判据必须是**相对**的。用绝对阈值会把 `(1/e)^200 = 1.38e-87` 误判成精确——
 * 它的修约残差约 1e-99，绝对值当然很小，但相对于 1e-87 的本体已经是 1e-12，
 * 正是 12 位有效数字修约该有的损失量。
 */
function roundingIsLossless(expression: string, rounded: string): boolean {
  try {
    const exact = checkMath.evaluate(expression)
    const residual = Number(String(checkMath.evaluate(`(${expression})-(${rounded})`)))
    const magnitude = Math.abs(Number(String(exact)))
    if (!Number.isFinite(residual) || !Number.isFinite(magnitude) || magnitude === 0) return false
    // 相对误差远小于展示精度（12 位）时，差额只可能来自截断噪声
    return Math.abs(residual) / magnitude < 1e-15
  } catch {
    return false
  }
}

/**
 * @param root      表达式的 AST，复数分量估算量级时要逐个子式重算
 * @param snapZero  传表达式表示「这个结果可能含数值噪声，值得复核」，传 null 表示不必
 */
function toEvalValue(raw: unknown, root: MathNode, snapZero: string | null): EvalValue {
  if (raw === null || raw === undefined) {
    throw new MathError('无法得到结果')
  }

  const typeName = bigMath.typeOf(raw)

  if (typeName === 'Complex') {
    const c = raw as { re: number; im: number }
    if (!Number.isFinite(c.re) || !Number.isFinite(c.im)) {
      throw new MathError('结果无穷大或未定义')
    }
    // 实部与虚部各自吸附噪声：(1+i)^2 的实部会算出 1.2e-16，
    // 应该显示成干净的 2i。判据见 channelScales 的注释——
    // 曾经用固定的 1e-12，于是 `1+i/10^13` 的虚部 1e-13 被当噪声删掉，
    // 答案从 `1+1e-13i` 缩水成 `1`：一条真实的数据凭空消失。
    const scales = channelScales(root, c)
    const snap = (part: number, scale: number) =>
      Math.abs(part) < scale * COMPLEX_NOISE_RATIO ? 0 : roundNumber(part)

    const re = snap(c.re, scales.re)
    const im = snap(c.im, scales.im)

    // 虚部被噪声淹没时整体降回实数
    const bothIntegers = Number.isInteger(re) && Number.isInteger(im)
    if (im === 0) {
      return { kind: 'real', decimal: formatNumber(re), approx: re, exact: Number.isInteger(re) }
    }
    return {
      kind: 'complex',
      re: formatNumber(re),
      im: formatNumber(im),
      text: formatComplex(re, im),
      approxRe: re,
      approxIm: im,
      exact: bothIntegers,
    }
  }

  if (typeName === 'Fraction') {
    const f = raw as { d: bigint | number; toFraction: () => string; valueOf: () => number }
    const approx = f.valueOf()
    const fraction = f.toFraction()
    // fraction.js 用 BigInt 存分母，直接和数字 1 比较恒为 false
    const isInteger = Number(f.d) === 1

    // 超过展示上限的有理数不再摆出「精确」的姿态——`2^100000` 的分数形有三万位，
    // 塞进气泡会把 KaTeX 拖死；而且 BigNumber 路径的 `100!` 早就按科学计数出了，
    // 两条路径必须一个标准。降成 real + 约等于，和 BigNumber 的超长整数同款处理。
    // 注意 approx 这时可能已经溢出成 Infinity（double 上限 1.8e308），
    // 科学计数必须从分数字符串本身推，不能指望 double。
    if (fraction.replace('-', '').length > EXACT_INTEGER_DIGITS) {
      return {
        kind: 'real',
        decimal: Number.isFinite(approx) ? formatNumber(roundNumber(approx)) : scientificFromFraction(fraction),
        approx,
        exact: false,
      }
    }

    return {
      kind: 'rational',
      fraction,
      // 整数的小数形必须从精确的分数形来，不能拿 approx 转字符串：
      // approx 是 JS double，`10^30+1` 转过去就成了 1e30，那个 +1 无声无息地没了。
      decimal: isInteger ? fraction : formatNumber(approx),
      approx,
      isInteger,
      exact: true,
    }
  }

  if (typeName === 'BigNumber') {
    const b = raw as {
      isFinite: () => boolean
      isNaN: () => boolean
      isInteger: () => boolean
      toFixed: () => string
      toSignificantDigits: (n: number) => {
        toString: () => string
        toNumber: () => number
        equals: (other: unknown) => boolean
      }
      toNumber: () => number
      toString: () => string
    }
    if (b.isNaN()) throw new MathError('结果未定义')
    if (!b.isFinite()) throw new MathError('结果无穷大——除数不能为零')

    // 精确整数不能被有效数字修约破坏：factorial(20) 必须原样给出，
    // 否则会退化成 2432902008180000000 这种看似精确实则错误的数。
    if (b.isInteger()) {
      const exact = b.toFixed()
      if (exact.replace('-', '').length <= EXACT_INTEGER_DIGITS) {
        return { kind: 'real', decimal: exact, approx: b.toNumber(), exact: true }
      }
    }

    const rounded = b.toSignificantDigits(DISPLAY_PRECISION)
    const approx = rounded.toNumber()
    if (snapZero) {
      // 比值用 64 位的完整结果去比，不用修约后的 double——
      // 被放大的噪声（sin(pi)*10^500）在 double 里已经是 Infinity 了，比不出来。
      const verdict = classifyByPrecision(snapZero, b.toString())
      if (verdict.kind === 'noise') {
        return { kind: 'real', decimal: '0', approx: 0, exact: true }
      }
      if (verdict.kind === 'converged') {
        // 真值是个极小量，64 位那次没算准。用收敛后的值作答，并诚实标成近似。
        return { kind: 'real', decimal: verdict.decimal, approx: verdict.approx, exact: false }
      }
    }
    // 判据是「修约有没有真的改变值」，而不是「结果是不是整数」：
    // sin(30°) 算出来正好是 0.5，修约不改变它，那就是精确的，
    // 标成近似反而是另一种不诚实。
    //
    // 改变了值的也再给一次机会：cos(pi)+sin(pi) 算出 -0.999…997，
    // 修约成 -1 确实改了值，但那点差额是数值噪声——真值就是 -1。
    const untouched = rounded.equals(b)
    const exact =
      untouched ||
      (snapZero !== null && roundingIsLossless(snapZero, rounded.toString()))

    return {
      kind: 'real',
      decimal: normalizeDecimalText(rounded.toString()),
      approx,
      exact,
    }
  }

  if (typeName === 'number') {
    const n = raw as number
    if (Number.isNaN(n)) throw new MathError('结果未定义')
    if (!Number.isFinite(n)) throw new MathError('结果无穷大——除数不能为零')
    const rounded = roundNumber(n)
    return {
      kind: 'real',
      decimal: formatNumber(rounded),
      approx: rounded,
      exact: Number.isInteger(rounded),
    }
  }

  throw new MathError(`不支持的结果类型：${typeName}`)
}

/**
 * 分数串（形如 `123456…` 或 `-a/b`）→ 12 位有效数字的科学计数。
 * 只在 double 已经溢出、拿不到 approx 时用：展示只要 12 位，
 * 各取分子分母前 17 位算商、位数差算指数就足够了。
 */
function scientificFromFraction(fraction: string): string {
  const [numRaw, denRaw = '1'] = fraction.split('/')
  const negative = numRaw.startsWith('-') !== denRaw.startsWith('-')
  const num = numRaw.replace('-', '')
  const den = denRaw.replace('-', '')
  const lead = (digits: string) => Number(`0.${digits.slice(0, 17)}`)
  const quotient = lead(num) / lead(den)
  // 规格化到 [1, 10)：商落在 (0.1, 10) 之间，最多挪一位
  const shift = Math.floor(Math.log10(quotient))
  const mantissa = (quotient / 10 ** shift).toPrecision(12).replace(/\.?0+$/, '')
  const exponent = num.length - den.length + shift
  return `${negative ? '-' : ''}${mantissa}e${exponent >= 0 ? '+' : ''}${exponent}`
}

function roundNumber(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value
  return Number(value.toPrecision(DISPLAY_PRECISION))
}

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)
  return normalizeDecimalText(String(value))
}

/** 去掉 1.2300000 这类修约后的尾随零，并统一指数写法。 */
function normalizeDecimalText(text: string): string {
  if (!text.includes('.')) return text
  if (text.includes('e') || text.includes('E')) {
    const [mantissa, exponent] = text.split(/[eE]/)
    return `${trimZeros(mantissa)}e${exponent}`
  }
  return trimZeros(text)
}

function trimZeros(text: string): string {
  if (!text.includes('.')) return text
  return text.replace(/\.?0+$/, '')
}

function formatComplex(re: number, im: number): string {
  const imPart = Math.abs(im) === 1 ? 'i' : `${formatNumber(Math.abs(im))}i`
  if (re === 0) return im < 0 ? `-${imPart}` : imPart
  return im < 0 ? `${formatNumber(re)} - ${imPart}` : `${formatNumber(re)} + ${imPart}`
}
