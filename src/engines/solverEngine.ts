/**
 * 方程与微积分求解，基于 nerdamer-prime。
 *
 * 这一层是惰性加载的：nerdamer 打包后约 3MB 且无法 tree-shake，
 * 只有用户真的问了方程/导数/积分才拉进来，普通四则运算不受影响。
 *
 * 选 nerdamer-prime 而非上游 nerdamer：上游主线停在 2022，
 * 分叉仍在活跃维护（v1.5.0，2026-07）。
 */

export interface SolveOutcome {
  /** 展示用的结果文本。 */
  text: string
  /** 每个根/结果的精确形与数值近似。 */
  items: Array<{ exact: string; approx?: string }>
}

import type { MathNode } from 'mathjs'
import { ExpressionError, validateAllowing } from './mathEngine'

/**
 * mathjs 认识、nerdamer 却把它当成**变量**的函数。
 *
 * 这一类最危险：nerdamer 不报错，而是把 `gamma(x)` 读成 `gamma·x`，
 * 于是 `∫gamma(x)dx` 端出一个像模像样的 `gamma·x²/2` —— 一个理直气壮的错误答案。
 * 名单是逐个试出来的：这五个的 diff 都退化成裸标识符、integrate 都得到 `(1/2)·名字·x²`。
 * （`arg` 不在其列：nerdamer 认得它，diff 给 0、integrate 会留下未求值标记被另一道检查拦住。）
 *
 * 拦在调用 nerdamer **之前**，因为事后从结果反推「引擎是不是没真的算」并不总能看出来。
 */
const SOLVER_BLIND_FUNCTIONS = new Set(['gamma', 'fix', 're', 'im', 'conj'])

/**
 * 方程/微积分的表达式也要过白名单，只是额外放行未知数。
 * 不校验的话 `f(x)` 这类未知函数会一路走到 nerdamer——它把 f 当变量，
 * 求导得出一个无意义的 `f` 就当答案端出去了。
 *
 * 返回 AST 供后续检查复用（绝对值/偶次根的区间解风险），省一次重复解析。
 */
function assertSolvable(expression: string, variable: string): MathNode {
  let root: MathNode
  try {
    root = validateAllowing(expression, new Set([variable, 'x', 'y', 'z']))
  } catch (error) {
    throw new SolveError(
      error instanceof ExpressionError ? error.message : (error as Error).message,
    )
  }

  walkNodes(root, (node) => {
    if (node.type !== 'FunctionNode') return
    const name = (node as unknown as { fn: { name?: string } }).fn?.name
    if (name && SOLVER_BLIND_FUNCTIONS.has(name)) {
      throw new SolveError(
        `求解引擎不认识 ${name} 这个函数（它支持的函数比求值引擎少），换个写法试试`,
      )
    }
  })

  return root
}

/** 自顶向下遍历 AST。 */
function walkNodes(node: MathNode, visit: (node: MathNode) => void): void {
  visit(node)
  node.forEach((child) => walkNodes(child, visit))
}

export class SolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolveError'
  }
}

/** nerdamer 的类型定义很薄，这里只声明我们实际用到的部分。 */
interface NerdamerExpression {
  toString: () => string
  symbol?: { elements?: unknown[] }
}

interface NerdamerApi {
  (expression: string): {
    toString: () => string
    evaluate: () => { text: (format: string, decimals?: number) => string }
  }
  set?: (key: string, value: unknown) => void
  solve: (equation: string, variable: string) => NerdamerExpression
  diff: (expression: string, variable: string) => NerdamerExpression
  integrate: (expression: string, variable: string) => NerdamerExpression
}

let loading: Promise<NerdamerApi> | null = null

/**
 * nerdamer 是全局单例，一次内部异常会**永久破坏它的常量表**：
 * `diff(nthRoot(x,3))` 抛出 `w.updateHash is not a function` 之后，
 * 常量 e 变成了有理近似 325368125/119696244，于是 `diff(e^x)` 从 `e^x`
 * 变成 `119696244^(-x)·325368125^x` —— 一个看起来像模像样的错误答案。
 * 实测 `clear('all')` 也救不回来。
 *
 * 所以一旦发生内部异常就把整个实例判定为不可信，后续调用一律报错。
 * 宁可让用户刷新页面，也不能继续端出被污染的结果。
 */
let poisoned = false

/**
 * nerdamer 不认识的语法，调用前先转成等价写法。
 * 这是治本的一半——`nthRoot(x,3)` 会触发上面那个异常，而 `x^(1/3)` 一切正常。
 */
function toNerdamerSyntax(expression: string): string {
  let out = expression
  // nthRoot(a, b) → (a)^(1/(b))
  for (let guard = 0; guard < 8; guard++) {
    const next = out.replace(
      /\bnthRoot\(([^,()]+(?:\([^()]*\))?[^,()]*),([^,()]+)\)/g,
      '($1)^(1/($2))',
    )
    if (next === out) break
    out = next
  }
  // cbrt(a) → (a)^(1/3)：nerdamer 认识这个名字但算不出来，会原样返回
  out = out.replace(/\bcbrt\(([^()]+(?:\([^()]*\))?[^()]*)\)/g, '($1)^(1/3)')

  // 对数的语义两边对不上，而且是**静默**对不上：
  //   log10(x)  mathjs 里是常用对数；nerdamer 有自己的实现，求导给出
  //             (108796589/250513404)·x⁻¹ —— 把 1/ln10 写成了丑陋的有理近似
  //   log(x,2)  mathjs 里是换底；nerdamer 不认双参，直接把底数丢掉，
  //             导数成了 1/x，少了 1/ln2 —— 数值上错了 44%
  //   log2(x)   nerdamer 压根不认，返回未求值的自身
  // 统一换成 log(a)/log(b)（nerdamer 的 log 是自然对数），语义对齐，
  // 导数也回到 log(10)⁻¹·x⁻¹ 这种符号形。
  out = rewriteCalls(out, 'log10', (args) => (args.length === 1 ? `(log(${args[0]})/log(10))` : null))
  out = rewriteCalls(out, 'log2', (args) => (args.length === 1 ? `(log(${args[0]})/log(2))` : null))
  out = rewriteCalls(out, 'log', (args) => (args.length === 2 ? `(log(${args[0]})/log(${args[1]}))` : null))
  return out
}

/**
 * 把 `name(...)` 形式的调用交给 build 重写，build 返回 null 表示原样保留。
 *
 * 用扫描而不是正则：正则数不了嵌套括号，`log(nthRoot(x,3),2)` 会被切在错误的逗号上。
 * 参数先递归处理，所以 `log10(log10(x))` 这种套娃也认得。
 */
function rewriteCalls(
  text: string,
  name: string,
  build: (args: string[]) => string | null,
): string {
  let out = ''
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(`${name}(`, cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }

    // 必须是完整的标识符：`x_log(…)` 里的 log 不是一个调用
    if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
      out += text.slice(cursor, start + name.length + 1)
      cursor = start + name.length + 1
      continue
    }

    const close = matchingParen(text, start + name.length)
    if (close < 0) {
      // 括号不配对，交给 nerdamer 自己报错，别在这里改坏它
      out += text.slice(cursor)
      break
    }

    const args = splitArguments(text.slice(start + name.length + 1, close)).map((argument) =>
      rewriteCalls(argument, name, build),
    )
    out += text.slice(cursor, start) + (build(args) ?? `${name}(${args.join(',')})`)
    cursor = close + 1
  }

  return out
}

/** 找 open 位置那个左括号的配对右括号；不配对返回 -1。 */
function matchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 按顶层逗号切分实参，括号里的逗号不算分隔符。 */
function splitArguments(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      args.push(text.slice(start, i))
      start = i + 1
    }
  }
  args.push(text.slice(start))
  return args
}

/** 判断异常是不是 nerdamer 内部崩了（而非它主动报告的业务失败）。 */
function isInternalFailure(error: unknown): boolean {
  if (error instanceof SolveError) return false
  const message = (error as Error)?.message ?? ''
  // 它主动报告的业务失败有明确措辞，其余（TypeError 之类）都算内部崩溃
  return !/Unable to compute|Cannot solve|unable|timed out|non-negative|Division by Zero/i.test(
    message,
  )
}

/**
 * 首次调用时加载，之后复用。
 * nerdamer-prime 的 ESM 入口（all.esm.min.mjs）已经打包了 Algebra/Calculus/Solve，
 * 不必再逐个引子模块。
 */
async function loadNerdamer(): Promise<NerdamerApi> {
  if (poisoned) {
    throw new SolveError('求解引擎之前遇到内部错误、状态已不可信，请刷新页面后重试')
  }
  loading ??= import('nerdamer-prime').then(
    (module) => (module.default ?? module) as unknown as NerdamerApi,
  )
  return loading
}

/** 解方程：左右两边都是规范表达式，变量默认 x。 */
export async function solveEquation(
  left: string,
  right: string,
  variable = 'x',
): Promise<SolveOutcome> {
  const nerdamer = await loadNerdamer()

  const leftRoot = assertSolvable(left, variable)
  const rightRoot = assertSolvable(right, variable)
  const mayBeInterval =
    hasIntervalRisk(leftRoot, variable) || hasIntervalRisk(rightRoot, variable)

  const difference = toNerdamerSyntax(`${left}-(${right})`)

  // 恒等式先挡下来。`x=x`、`x/x=1` 对（几乎）任意 x 都成立，
  // 而 nerdamer 会返回 [0] —— 对 x/x=1 来说，0 恰恰是**唯一不成立**的点。
  // 把这种情况当成普通方程作答，等于给出一个理直气壮的错误答案。
  if (isIdentity(nerdamer, difference)) {
    throw new SolveError(
      `这是恒等式，${variable} 取任何值都成立（除非某处分母为零），没有特定的解`,
    )
  }

  let roots: unknown[]
  try {
    const solved = nerdamer.solve(difference, variable)
    roots = solved.symbol?.elements ?? []
  } catch (error) {
    if (isInternalFailure(error)) {
      poisoned = true
      throw new SolveError('求解引擎遇到内部错误，已停用以免给出错误结果。请刷新页面。')
    }
    throw new SolveError(translate((error as Error).message))
  }

  if (roots.length === 0) {
    throw new SolveError(`在实数与复数范围内都没有找到 ${variable} 的解`)
  }

  // 代回原式验证。nerdamer 会返回错误的根——`x^3-2=0` 的第二个根代回残差是 -4，
  // 不验证就直接端给用户了。
  const verified: Array<{ text: string; magnitude: number }> = []
  let rejected = 0
  for (const root of roots) {
    const candidate = String(root)
    if (!satisfies(nerdamer, difference, variable, candidate)) {
      rejected += 1
      continue
    }
    verified.push({ text: candidate, magnitude: magnitudeOf(nerdamer, candidate) })
  }

  if (verified.length === 0) {
    throw new SolveError(
      rejected > 0
        ? '求解引擎给出的解代回原方程都不成立，这个方程它解不对'
        : `在实数与复数范围内都没有找到 ${variable} 的解`,
    )
  }

  // 按到原点的距离排序。用模长而不是 parseFloat——后者对 "-1+100i" 只拿到 -1，
  // 会把一个很远的根排到最前面。
  verified.sort((a, b) => a.magnitude - b.magnitude)

  const shown = verified.slice(0, MAX_SHOWN_ROOTS)
  const items = shown.map((root) => describeRoot(nerdamer, root.text))
  const omitted = verified.length - shown.length

  const body = items
    .map(
      (item) =>
        `${variable} ${relationOf(item)} ${item.exact}${item.approx ? ` ≈ ${item.approx}` : ''}`,
    )
    .join('，或 ')

  const notes: string[] = []
  if (omitted > 0) notes.push('还有其他解，这里只列最接近零的几个')
  if (rejected > 0) notes.push(`求解引擎另给了 ${rejected} 个代回不成立的解，已剔除`)
  // 区间解的诚实交代：算不全就说算不全，不能让「x = 0」看起来像是全部答案
  if (mayBeInterval) {
    notes.push(
      '方程含绝对值或偶次根，解可能是整段区间；这里只列出求解器找到的点，结果可能不完整',
    )
  }

  return {
    text: notes.length > 0 ? `${body}（${notes.join('；')}）` : body,
    items,
  }
}

/** 残差的容忍上限。数值根本身只保证 7 位小数，卡太紧会误杀。 */
const RESIDUAL_TOLERANCE = 1e-6

/**
 * 显示解的关系符。
 *
 * 数值根（牛顿法解出来的小数）要用 ≈：`x = 0.7390851332` 里的等号是在撒谎，
 * 那是个截断到 10 位的近似值。整数、分数、根式、纯虚数形式才配得上等号。
 * 已经带了 approx 的（`√(2) ≈ 1.414…`）本来就是「精确形 ≈ 近似值」，等号连的是精确形。
 */
function relationOf(item: { exact: string; approx?: string }): string {
  if (item.approx) return '='
  return /\d\.\d/.test(item.exact) ? '≈' : '='
}

/** 把根代回原式，看等式是否真的成立。 */
function satisfies(
  nerdamer: NerdamerApi,
  difference: string,
  variable: string,
  root: string,
): boolean {
  const residual = evaluateNumerically(nerdamer, difference.replaceAll(variable, `(${root})`))
  // 代回算不出来（定义域外等）也视为不成立
  return residual !== null && residual <= RESIDUAL_TOLERANCE
}

/**
 * 把 nerdamer 的表达式求成一个数值模长，算不出来返回 null。
 *
 * 必须先 expand 一道。直接 evaluate 有时只化简一半，留下
 * `2.55e-13*(-2+100i)*(-3+100i)*(-4+100i)*i` 这种半符号串——解析不出数值，
 * 于是 `(x-1)(x-2)(x-3)(x²+2x+10001)=0` 的**正确根** -1+100i 被判成「代回不成立」剔除，
 * 答案还多出一句「另给了 1 个不成立的解，已剔除」的假话。expand 之后同一个式子收成 0。
 */
function evaluateNumerically(nerdamer: NerdamerApi, expression: string): number | null {
  for (const form of [`expand(${expression})`, expression]) {
    try {
      const magnitude = complexMagnitude(nerdamer(form).evaluate().text('decimals', 12))
      if (Number.isFinite(magnitude)) return magnitude
    } catch {
      // 这种写法算不出来就换下一种
    }
  }
  return null
}

/** 根到原点的距离，复数取模长。 */
function magnitudeOf(nerdamer: NerdamerApi, root: string): number {
  // 解析不了的排到最后，而不是当成距离 0
  return evaluateNumerically(nerdamer, root) ?? Number.MAX_VALUE
}

/**
 * 变量落在绝对值或偶次根里 —— 这类方程的解常常是**整段区间**：
 * `|x| = x` 与 `√(x²) = x` 的实数解都是 x ≥ 0，而 nerdamer 只会给出离散的点（x = 0）。
 *
 * 我们的求解器表达不了区间，那就别假装答完了。检测到就在答案后面挂一句说明，
 * 让用户知道这里只是「找到的点」而不是「全部的解」。
 *
 * 只认 abs / sqrt / 偶数次 nthRoot 这三种确定的形态；`(...)^(1/2)` 这类写法认不出来，
 * 宁可漏报也不误报——给普通方程挂上「可能不完整」同样是噪音。
 */
function hasIntervalRisk(node: MathNode, variable: string): boolean {
  let risky = false

  walkNodes(node, (current) => {
    if (risky || current.type !== 'FunctionNode') return
    const name = (current as unknown as { fn: { name?: string } }).fn?.name
    const args = (current as unknown as { args: MathNode[] }).args
    if (!name || args.length === 0) return

    const wraps = containsVariable(args[0], variable)
    if (!wraps) return
    if (name === 'abs' || name === 'sqrt') risky = true
    if (name === 'nthRoot' && args.length > 1 && isEvenDegree(args[1])) risky = true
  })

  return risky
}

function containsVariable(node: MathNode, variable: string): boolean {
  let found = false
  walkNodes(node, (current) => {
    if (
      current.type === 'SymbolNode' &&
      (current as unknown as { name: string }).name === variable
    ) {
      found = true
    }
  })
  return found
}

/** nthRoot 的次数是不是偶数字面量。看不出来（表达式次数）就当不是。 */
function isEvenDegree(node: MathNode): boolean {
  if (node.type !== 'ConstantNode') return false
  const degree = Number(String((node as unknown as { value: unknown }).value))
  return Number.isInteger(degree) && degree % 2 === 0
}

/**
 * 解析 nerdamer 的数值输出并求模长。
 * 形如 `1.5`、`-2`、`0.5+0.86i`、`-1.28e-15*i` 都要认。
 */
function complexMagnitude(text: string): number {
  const cleaned = text.replace(/\s|\*/g, '')
  if (!cleaned) return Number.NaN

  // 纯实数
  if (!cleaned.includes('i')) {
    const real = Number(cleaned)
    return Number.isFinite(real) ? Math.abs(real) : Number.NaN
  }

  // a±bi：从末尾的 i 往前找分隔符号（跳过科学计数法里的 e+/e-）
  const withoutI = cleaned.slice(0, cleaned.lastIndexOf('i'))
  let splitAt = -1
  for (let i = withoutI.length - 1; i > 0; i--) {
    const ch = withoutI[i]
    if ((ch === '+' || ch === '-') && !'eE'.includes(withoutI[i - 1])) {
      splitAt = i
      break
    }
  }

  if (splitAt === -1) {
    const imaginary = parseImaginary(withoutI)
    return Number.isFinite(imaginary) ? Math.abs(imaginary) : Number.NaN
  }

  const real = Number(withoutI.slice(0, splitAt))
  const imaginary = parseImaginary(withoutI.slice(splitAt))
  if (!Number.isFinite(real) || !Number.isFinite(imaginary)) return Number.NaN
  return Math.hypot(real, imaginary)
}

/** `+`、`-`、`` 这几种省略系数的写法都当作 ±1。 */
function parseImaginary(text: string): number {
  const trimmed = text.replace(/\*$/, '')
  if (trimmed === '' || trimmed === '+') return 1
  if (trimmed === '-') return -1
  return Number(trimmed)
}

/** 方程两边化简后恒等 → 不是「求解」而是「恒成立」。 */
function isIdentity(nerdamer: NerdamerApi, difference: string): boolean {
  try {
    return nerdamer(`simplify(${difference})`).toString().trim() === '0'
  } catch {
    return false
  }
}

/** 展示上限。超过这个数量再列下去，用户已经读不完了。 */
const MAX_SHOWN_ROOTS = 4

/** 求导 / 不定积分。 */
export async function calculus(
  kind: 'diff' | 'integrate',
  expression: string,
  variable = 'x',
): Promise<SolveOutcome> {
  const nerdamer = await loadNerdamer()
  assertSolvable(expression, variable)
  const compatible = toNerdamerSyntax(expression)

  try {
    const result = kind === 'diff'
      ? nerdamer.diff(compatible, variable)
      : nerdamer.integrate(compatible, variable)
    const raw = String(result)

    // nerdamer 算不出来时**不抛错**，而是把未求值的自身原样返回
    // （`integrate(cos(x^2),x)` 就是这样）。不检测的话我们会给它加个「+ C」
    // 当成答案端出去，把「没算出来」伪装成「算出来了」——比报错糟得多。
    if (containsUnevaluated(raw)) {
      throw new SolveError(
        kind === 'integrate'
          ? '这个积分算不出来（它可能没有初等原函数）'
          : '这个导数算不出来',
      )
    }

    // mathjs 认识但 nerdamer 不认识的函数（gamma 就是一例）会被当成变量，
    // `diff(gamma(x))` 于是退化成一个光秃秃的 `gamma`。
    // 判据：原式含变量、结果却只剩一个裸标识符，说明引擎没真的算。
    if (isDegenerate(raw, expression, variable)) {
      throw new SolveError(
        `求解引擎不认识这个式子里的某个函数（它支持的函数比求值引擎少），换个写法试试`,
      )
    }

    const exact = tidy(raw)
    return {
      text: kind === 'integrate' ? `${exact} + C` : exact,
      items: [{ exact }],
    }
  } catch (error) {
    if (error instanceof SolveError) throw error
    if (isInternalFailure(error)) {
      poisoned = true
      throw new SolveError('求解引擎遇到内部错误，已停用以免给出错误结果。请刷新页面。')
    }
    throw new SolveError(translate((error as Error).message))
  }
}

/**
 * 引擎没真的算——把某个函数名当成变量了。
 *
 * 判据不能是「结果是个裸标识符」：`d(x·y)/dx = y` 的正确答案就是裸标识符 y，
 * 曾经被这条规则一票否决，一道完全算得对的题报成了「不认识这个函数」。
 * 真正的信号有两个：结果原样回吐了输入（引擎压根没动它），
 * 或者结果这个标识符在原式里是**函数名**（`gamma(x)` → `gamma`）。
 *
 * 这只是兜底。已知会退化的函数在进 nerdamer 之前就被 SOLVER_BLIND_FUNCTIONS 拦掉了——
 * 事后检查看不出 `∫gamma(x)dx → gamma·x²/2` 这种「结果里还带着 x」的退化。
 */
function isDegenerate(result: string, expression: string, variable: string): boolean {
  const trimmed = result.trim()
  if (trimmed === expression.trim()) return true
  if (!expression.includes(variable)) return false
  if (trimmed.includes(variable)) return false
  if (!/^[A-Za-z_]\w*$/.test(trimmed)) return false
  return new RegExp(`\\b${trimmed}\\s*\\(`).test(expression)
}

/** 结果里还留着这些函数调用，说明求解器放弃了。 */
const UNEVALUATED_MARKERS = ['integrate(', 'defint(', 'limit(', 'diff(']

function containsUnevaluated(text: string): boolean {
  return UNEVALUATED_MARKERS.some((marker) => text.includes(marker))
}

/**
 * 精确形太长时只给数值。
 * 三次方程的根式解能长到两百多个字符，那种"精确"对读者毫无价值。
 */
const EXACT_FORM_LIMIT = 24

function describeRoot(nerdamer: NerdamerApi, raw: string): { exact: string; approx?: string } {
  const exact = tidy(raw)

  let approx: string | undefined
  try {
    const decimals = nerdamer(raw).evaluate().text('decimals', 10)
    const cleaned = tidy(decimals)
    // 数值和精确形一样时就不重复显示了
    if (cleaned !== exact) approx = cleaned
  } catch {
    approx = undefined
  }

  if (exact.length > EXACT_FORM_LIMIT && approx) {
    return { exact: approx }
  }

  // 牛顿法解出的无理根会被 nerdamer 表示成巨大的分数，此时数值才是有用的那个
  if (/^-?\d{5,}\/\d{5,}$/.test(exact) && approx) {
    return { exact: approx }
  }

  return { exact, approx }
}

/** 把 nerdamer 的输出改写得更像手写数学。 */
function tidy(text: string): string {
  return text
    .replace(/\*/g, '·')
    .replace(/\^/g, '^')
    .replace(/\bsqrt\(/g, '√(')
    .replace(/·i\b/g, 'i')
    .trim()
}

function translate(message: string): string {
  if (/timed out|timeout/i.test(message)) return '这个方程算得太久，先放弃了'
  if (/Cannot solve|unable/i.test(message)) return '这个方程我解不出来'
  return message
}
