/**
 * 中文算式分词。
 *
 * 策略：词表最长匹配优先，未命中再贪婪吃中文/阿拉伯数字。
 * 词表按长度降序排列，因此「除以」必然先于「除」、「次方根」先于「次方」命中——
 * 这类顺序依赖用数据结构保证，而不是散落在代码里的 if 顺序。
 */
import lexicon from './grammar/lexicon.json'
import { CHINESE_NUMBER_CHARS, ChineseNumberError, parseChineseNumber } from './cnNumber'

export type Token =
  /** 数值字面量。 */
  | { kind: 'number'; value: number; text: string }
  /** 二元运算符，op 为规范符号。 */
  | { kind: 'operator'; op: string; text: string }
  /** 歧义运算符，两种读法都保留，由候选层展开。 */
  | { kind: 'ambiguous'; ops: string[]; text: string }
  /** 函数名，name 为 mathjs 函数名。 */
  | { kind: 'function'; name: string; text: string }
  /** 常量。 */
  | { kind: 'constant'; name: string; text: string }
  /** 构式关键词，tag 见 lexicon.keywords。 */
  | { kind: 'keyword'; tag: string; text: string }
  | { kind: 'paren'; value: '(' | ')'; text: string }
  /** 已生成好的规范子表达式，由模板 pass 产出。 */
  | { kind: 'expr'; canonical: string; text: string }
  /** 未知数，只在方程/微积分通道里合法。 */
  | { kind: 'variable'; name: string; text: string }
  /** 意图词（解方程、求导…），出现即改走求解通道。 */
  | { kind: 'intent'; intent: string; text: string }

export class TokenizeError extends Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(message)
    this.name = 'TokenizeError'
    this.position = position
  }
}

interface LexEntry {
  text: string
  make: (text: string) => Token
}

/** 全部词条按长度降序，保证最长匹配。 */
const ENTRIES: LexEntry[] = buildEntries()

function buildEntries(): LexEntry[] {
  const entries: LexEntry[] = []

  for (const [text, op] of Object.entries(lexicon.operators)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'operator', op, text: t }) })
  }
  for (const [text, ops] of Object.entries(lexicon.ambiguousOperators)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'ambiguous', ops: ops as string[], text: t }) })
  }
  for (const [text, name] of Object.entries(lexicon.functions)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'function', name, text: t }) })
  }
  for (const [text, name] of Object.entries(lexicon.constants)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'constant', name, text: t }) })
  }
  for (const [text, tag] of Object.entries(lexicon.keywords)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'keyword', tag, text: t }) })
  }
  for (const [text, intent] of Object.entries(lexicon.intents)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'intent', intent, text: t }) })
  }
  for (const text of lexicon.variables) {
    entries.push({ text, make: (t) => ({ kind: 'variable', name: normalizeVariable(text), text: t }) })
  }
  for (const [text, value] of Object.entries(lexicon.parentheses)) {
    if (text.startsWith('$')) continue
    entries.push({ text, make: (t) => ({ kind: 'paren', value: value as '(' | ')', text: t }) })
  }

  return entries.sort((a, b) => b.text.length - a.text.length)
}

/** 「未知数」「X」都归一到小写 x，下游只见一种写法。 */
function normalizeVariable(text: string): string {
  if (text === '未知数') return 'x'
  return text.toLowerCase()
}

/**
 * 剥离填充词。只剥多字短语与明确的句末虚词，绝不剥单字数词——
 * 「一」「二」既是填充不了的数字，误剥会把「一加一」变成「加」。
 */
export function stripFillers(input: string): string {
  let text = input
  for (const filler of [...lexicon.fillers].sort((a, b) => b.length - a.length)) {
    text = text.split(filler).join('')
  }
  return text.trim()
}

/** 上标数字 → 中文次方构式，这样 `X²` 能复用已有的幂文法。 */
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
}

/** 全角转半角，并统一常见的数学符号写法。 */
export function normalize(input: string): string {
  let text = input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[　\s]+/g, ' ')
    .trim()

  // X² → X的2次方；连续上标一起处理（x¹² 是 12 次方，不是 1 次方再 2 次方）
  text = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (run) => {
    const digits = [...run].map((ch) => SUPERSCRIPT_DIGITS[ch]).join('')
    return `的${digits}次方`
  })

  // 键盘写法 X^2 同样归一到中文构式，下游只需认一种形式
  text = text.replace(/\^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*\)?/g, '的$1次方')

  return text
}

/**
 * 补出隐式乘号：`2X` `2π` `3(x+1)` 里省略的乘法。
 *
 * 只在「数值紧跟变量/常量/左括号」时补——这是数学书写惯例里唯一无歧义的一种省略。
 * 不做 `xy → x*y` 那类拆分：中文场景里多字符标识符更可能是一个整体。
 */
function insertImplicitMultiplication(tokens: Token[]): Token[] {
  const out: Token[] = []

  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i]
    out.push(current)

    const next = tokens[i + 1]
    if (!next || current.kind !== 'number') continue

    const nextStartsOperand =
      next.kind === 'variable' ||
      next.kind === 'constant' ||
      (next.kind === 'paren' && next.value === '(')

    if (nextStartsOperand) {
      out.push({ kind: 'operator', op: '*', text: '' })
    }
  }

  return out
}

export function tokenize(input: string): Token[] {
  const tokens = tokenizeRaw(input)
  return insertImplicitMultiplication(tokens)
}

function tokenizeRaw(input: string): Token[] {
  const text = input
  const tokens: Token[] = []
  let i = 0

  while (i < text.length) {
    if (text[i] === ' ') {
      i += 1
      continue
    }

    const numberToken = matchNumber(text, i)
    const entry = matchLexicon(text, i)

    // 词表与数字同时命中时取更长的那个：「百分之二十」应整体读作 PERCENT_OF，
    // 而「一百二十」应整体读作数字。比较长度即可，无需特例。
    if (numberToken && (!entry || numberToken.text.length >= entry.text.length)) {
      tokens.push(numberToken.token)
      i += numberToken.text.length
      continue
    }

    if (entry) {
      tokens.push(entry.make(entry.text))
      i += entry.text.length
      continue
    }

    throw new TokenizeError(`看不懂 "${text[i]}"`, i)
  }

  return tokens
}

function matchLexicon(text: string, at: number): LexEntry | null {
  for (const entry of ENTRIES) {
    if (text.startsWith(entry.text, at)) return entry
  }
  return null
}

/** 贪婪吃数字字符，再交给 cnNumber 校验——非法写法在那里抛错，不在这里猜。 */
function matchNumber(text: string, at: number): { token: Token; text: string } | null {
  const arabic = /^\d+(?:\.\d+)?/.exec(text.slice(at))
  if (arabic) {
    // 「3千2百」这类混写：阿拉伯数字后面紧跟中文单位，整体交给 cnNumber。
    let end = at + arabic[0].length
    while (end < text.length && isNumberChar(text[end])) end += 1
    const slice = text.slice(at, end)
    const parsed = tryParseNumber(slice)
    if (parsed !== null) return { token: { kind: 'number', value: parsed, text: slice }, text: slice }
    return {
      token: { kind: 'number', value: Number(arabic[0]), text: arabic[0] },
      text: arabic[0],
    }
  }

  if (!isNumberChar(text[at])) return null

  let end = at
  while (end < text.length && isNumberChar(text[end])) end += 1

  // 数字串后面紧跟阿拉伯数字也算同一个数：「1百01」
  while (end < text.length && /[\d]/.test(text[end])) {
    end += 1
    while (end < text.length && isNumberChar(text[end])) end += 1
  }

  // 从最长开始回退，直到能解析成功。「五点」中的「点」应留给后续，
  // 「三点五」则整体成数。
  for (let stop = end; stop > at; stop--) {
    const slice = text.slice(at, stop)
    const parsed = tryParseNumber(slice)
    if (parsed !== null) return { token: { kind: 'number', value: parsed, text: slice }, text: slice }
  }

  return null
}

/** 中文数字字符集，加上小数点与负号。「负」由文法处理，不并进数字。 */
function isNumberChar(ch: string): boolean {
  return CHINESE_NUMBER_CHARS.includes(ch) || ch === '点' || ch === '點' || /[\d.]/.test(ch)
}

function tryParseNumber(slice: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(slice)) return Number(slice)
  try {
    return parseChineseNumber(slice, 'smart')
  } catch (error) {
    if (error instanceof ChineseNumberError) return null
    throw error
  }
}
