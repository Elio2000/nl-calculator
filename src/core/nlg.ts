/**
 * 回答生成。
 *
 * 风格跟随输入：用中文数字提问就用中文数字回答（一加一 → 等于二），
 * 用阿拉伯数字提问就用阿拉伯数字（1+1 → 等于 2）。
 * 每条回答都附规范算式回显，让用户看得见系统的理解——
 * 这是"理解可以有歧义，计算不可以"这条原则在界面上的落点。
 */
import { toReadableText, type EvalValue } from '../engines/mathEngine'
import { formatChineseNumber } from './cnNumber'

export interface Answer {
  /** 主答句，直接展示给用户。 */
  text: string
  /** 结果的纯数值/表达式形式，供复制。 */
  plain: string
}

/**
 * 回答用中文数字还是阿拉伯数字，跟随提问方式。
 * 判定看的是有没有中文字符（不限于数字）：用中文说「cos派加sin派」，
 * 回答「等于负一」才自然；写「3+5」这种纯符号式子则回答「等于 8」。
 */
export function prefersChineseStyle(input: string): boolean {
  return /[一-鿿〇]/.test(input)
}

export function describe(value: EvalValue, useChinese: boolean): Answer {
  switch (value.kind) {
    case 'rational':
      return describeRational(value, useChinese)
    case 'complex':
      // 复数同样要区分精确与近似：`√-2 = 1.41421356237i` 的等号和实数那边一样在撒谎，
      // 而公式回显那边已经按 exact 打了 ≈，两处不能各说各话
      return { text: `${value.exact ? '等于' : '约等于'} ${value.text}`, plain: value.text }
    case 'real':
      return describeReal(value, useChinese)
  }
}

function describeRational(
  value: Extract<EvalValue, { kind: 'rational' }>,
  useChinese: boolean,
): Answer {
  if (value.isInteger) {
    const chinese = useChinese ? formatChineseNumber(value.approx) : null
    return {
      text: chinese ? `等于${chinese}` : `等于 ${value.fraction}`,
      plain: value.fraction,
    }
  }

  // 分数保留精确形，同时给出小数近似——「三分之一」既要显示 1/3 也要能看到 0.333…
  const approx = trimApprox(value.approx)
  return {
    text: `等于 ${value.fraction}${approx ? `，约 ${approx}` : ''}`,
    plain: value.fraction,
  }
}

/**
 * 实数的答句。
 *
 * 「等于」还是「约等于」由 exact 决定，不由长得像不像整数决定——
 * 引擎已经知道 √2 的 1.41421356237 是修约过的近似值，说「等于」就是在撒谎。
 * 公式回显那边早就用 ≈ 了，文案却还写「等于 1.41421356237」，
 * 同一屏上两种说法自相矛盾，用户信哪个？
 */
function describeReal(
  value: Extract<EvalValue, { kind: 'real' }>,
  useChinese: boolean,
): Answer {
  const relation = value.exact ? '等于' : '约等于'

  if (value.decimal.includes('e')) {
    return { text: `${relation} ${formatScientific(value.decimal)}`, plain: value.decimal }
  }

  // 中文数字只用来念精确值。把近似值念成中文，读起来像在保证每一位都对，
  // 而它本来就只是修约后的展示形。
  const chinese = value.exact && useChinese ? formatChineseNumber(value.approx) : null
  if (chinese) return { text: `${relation}${chinese}`, plain: value.decimal }

  return { text: `${relation} ${value.decimal}`, plain: value.decimal }
}

/** 2.68811714182e+43 → 2.68811714182 × 10⁴³ */
function formatScientific(text: string): string {
  const [mantissa, exponent] = text.split('e')
  const power = Number(exponent)
  return `${mantissa} × 10${toSuperscript(power)}`
}

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
}

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
}

/** log(8,2) 里的底数写成下标，读起来才像数学书。 */
function toSubscript(text: string): string {
  return [...text.trim()].every((ch) => ch in SUBSCRIPTS)
    ? [...text.trim()].map((ch) => SUBSCRIPTS[ch]).join('')
    : `_${text.trim()}`
}

function toSuperscript(value: number): string {
  return [...String(value)].map((ch) => SUPERSCRIPTS[ch] ?? ch).join('')
}

function trimApprox(value: number): string | null {
  if (Number.isInteger(value)) return null
  const text = value.toPrecision(6).replace(/\.?0+$/, '')
  return text
}

/**
 * 拼出完整算式的 LaTeX：`表达式 = 结果`。
 *
 * 回显的意义是让人一眼看出系统有没有理解对，所以要渲染成真正的数学排版，
 * 而不是一串代码——`\frac{1}{3}` 显示成分数线，比 `1/3` 更快确认。
 */
export function formulaTex(expressionTex: string, result: string, exact = true): string {
  // 近似值用 ≈。`√2 = 1.41421356237` 里的等号是在撒谎——那是修约过的值。
  return `${expressionTex} ${exact ? '=' : '\\approx'} ${resultToTex(result)}`
}

/** 结果文本转 LaTeX：分数写成 \frac，科学计数法写成 \times 10^{n}。 */
function resultToTex(result: string): string {
  const fraction = result.match(/^(-?)(\d+)\/(\d+)$/)
  if (fraction) {
    const [, sign, numerator, denominator] = fraction
    return `${sign}\\frac{${numerator}}{${denominator}}`
  }

  const scientific = result.match(/^(-?[\d.]+)e([+-]?\d+)$/i)
  if (scientific) {
    return `${scientific[1]} \\times 10^{${Number(scientific[2])}}`
  }

  // 复数与普通数直接用，只把虚数单位排成正体
  return result.replace(/\bi\b/g, '\\mathrm{i}')
}

/**
 * 把规范表达式改写成更接近数学书写习惯的形式，用于纯文本场合（复制、测试）。
 * 规范表达式为了锁死解读会加满括号，但那是给引擎看的；给人看要干净。
 */
export function displayExpression(expression: string): string {
  // 交给引擎按运算优先级重排括号，比在字符串上剥括号可靠得多
  let text: string
  try {
    text = toReadableText(expression)
  } catch {
    text = expression
  }

  return text
    .replace(/\s+/g, '')
    .replace(/\bsqrt\(/g, '√(')
    .replace(/\bnthRoot\(/g, 'ⁿ√(')
    // 引擎里 log 是自然对数，但中文习惯读作常用对数——显示成 ln 才不会误解。
    // 顺序要紧：先处理带底数的两参数形式，再处理 log10，最后才是单参数的 log。
    .replace(/\blog\(([^,()]+),([^,()]+)\)/g, (_, value, base) => `log${toSubscript(base)}(${value})`)
    .replace(/\blog10\(/g, 'lg(')
    .replace(/\blog2\(/g, 'log₂(')
    .replace(/\blog\(/g, 'ln(')
    .replace(/\bpi\b/g, 'π')
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
}
