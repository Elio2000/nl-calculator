/**
 * 中文数字解析（规则移植自 cn2an，MIT）。
 *
 * 计算器的底线是**宁可报错也不猜**：非法写法（百十一、十一十二、零点）一律抛错，
 * 而不是像多数格式化库那样静默返回一个看似合理的错数。用户看到报错会改口，
 * 看到错数则不会。
 *
 * 三档模式构成信任边界：
 *   strict —— 严格书面写法，用于校验 LLM 归一化后的输出
 *   normal —— 加上口语（三万五 / 两千六）与「两、幺、廿」等异体
 *   smart  —— 再加上中阿混写（3千2百 / 10.1万），用于用户原始输入
 */

import Nzh from 'nzh'

const nzhCn = Nzh.cn

/** 数字字符 → 数值。简体、繁体、大写、口语异体合并在同一张表里。 */
const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 洞: 0, 壹: 1, 一: 1, 幺: 1, 贰: 2, 贰1: 2, 二: 2, 两: 2, 兩: 2, 俩: 2,
  叁: 3, 三: 3, 仨: 3, 肆: 4, 四: 4, 伍: 5, 五: 5, 陆: 6, 陸: 6, 六: 6,
  柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9,
}

/** 单位字符 → 倍数。上限到亿，与 cn2an 一致。 */
const UNITS: Record<string, number> = {
  十: 10, 拾: 10, 什: 10,
  百: 100, 佰: 100,
  千: 1000, 仟: 1000,
  万: 10000, 萬: 10000,
  亿: 100000000, 億: 100000000,
}

/** 古语数词，直接展开成等价写法。 */
const ARCHAIC: Record<string, string> = { 廿: '二十', 卅: '三十', 卌: '四十' }

/** strict 档不接受的口语/异体字符。 */
const NON_STRICT_DIGITS = new Set(['〇', '幺', '两', '兩', '俩', '仨', '洞'])

const DIGIT_CHARS = Object.keys(DIGITS).join('')
const UNIT_CHARS = Object.keys(UNITS).join('')
/** 非零数字。补零规则必须排除「零」，否则「一千零十」会被补成「一千零零十」。 */
const NONZERO_DIGIT_CHARS = Object.keys(DIGITS).filter((ch) => DIGITS[ch] !== 0).join('')

export type ParseMode = 'strict' | 'normal' | 'smart'

export class ChineseNumberError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChineseNumberError'
  }
}

/** 全角数字与标点转半角，繁体单位不动（DIGITS/UNITS 已收录）。 */
function toHalfWidth(text: string): string {
  return text.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  ).replace(/　/g, ' ')
}

/**
 * 合法中文数字的白名单正则，按万进制递归构造（cn2an 的核心可靠性来源）。
 * 用它把「百十一」「十一十二」这类非法写法挡在累加算法之外。
 */
function buildIntegerPattern(): RegExp {
  const d = `[${DIGIT_CHARS}]`
  const d19 = `[${DIGIT_CHARS.replace(/[零〇洞]/g, '')}]`
  const ten = '[十拾什]'
  const hundred = '[百佰]'
  const thousand = '[千仟]'
  const tenThousand = '[万萬]'
  const hundredMillion = '[亿億]'

  const p1_9 = d19
  // 十一 / 二十 / 二十一，允许首位省略「一」
  const p10_99 = `(?:${d19})?${ten}(?:${d19})?`
  const p1_99 = `(?:${p10_99}|${p1_9})`
  const p100_999 = `${d19}${hundred}(?:零${p1_9}|${p10_99})?`
  const p1_999 = `(?:${p100_999}|${p1_99})`
  const p1000_9999 = `${d19}${thousand}(?:零${p1_99}|${p100_999})?`
  const p1_9999 = `(?:${p1000_9999}|${p1_999})`
  // 万/亿 后的余数允许带一个「零」占位：十万零一千、一亿零五百
  const p1w_1y = `${p1_9999}${tenThousand}(?:零?${p1_9999})?`
  const p1_1y = `(?:${p1w_1y}|${p1_9999})`
  const p1y_up = `${p1_1y}${hundredMillion}(?:零?${p1_1y})?`

  return new RegExp(`^(?:${p1y_up}|${p1w_1y}|${p1_9999}|${d}+)$`)
}

const INTEGER_PATTERN = buildIntegerPattern()

/** 口语省略末位单位：一万二 → 一万二千、两百五 → 两百五十。 */
const SPOKEN_PATTERN = new RegExp(
  `^(?:[${DIGIT_CHARS}]{0,2}[${UNIT_CHARS}])+[${DIGIT_CHARS}]$`,
)

/** 单位倍数 → 中文字符，用于补出省略的末位单位。 */
const UNIT_BY_VALUE: Record<number, string> = { 10: '十', 100: '百', 1000: '千', 10000: '万' }

/**
 * 把中文数字串解析成数值。
 * @throws ChineseNumberError 输入不是合法中文数字时
 */
export function parseChineseNumber(input: string, mode: ParseMode = 'smart'): number {
  let text = toHalfWidth(input).trim()
  if (!text) throw new ChineseNumberError('输入为空')

  for (const [archaic, expanded] of Object.entries(ARCHAIC)) {
    text = text.replaceAll(archaic, expanded)
  }

  let negative = false
  if (text.startsWith('负') || text.startsWith('-')) {
    negative = true
    text = text.slice(1)
  }

  if (mode === 'strict') {
    for (const ch of text) {
      if (NON_STRICT_DIGITS.has(ch)) {
        throw new ChineseNumberError(`"${ch}" 属于口语写法，strict 模式不接受`)
      }
    }
  }

  // 「10.1万」这类中阿混写的小数带单位，走精确乘法，避免中文通道的浮点误差。
  const mixedDecimalUnit = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)([${UNIT_CHARS}])$`))
  if (mixedDecimalUnit) {
    if (mode !== 'smart') {
      throw new ChineseNumberError(`"${input}" 是中阿混写，仅 smart 模式支持`)
    }
    const scaled = Number(mixedDecimalUnit[1]) * UNITS[mixedDecimalUnit[2]]
    return negative ? -scaled : scaled
  }

  if (mode === 'smart') {
    // 阿拉伯数字段先转成中文，之后统一走中文通道：3千2百 → 三千二百
    text = text.replace(/\d+/g, (segment) => arabicToChinese(segment))
  } else if (/\d/.test(text)) {
    throw new ChineseNumberError(`"${input}" 含阿拉伯数字，仅 smart 模式支持`)
  }

  const [integerPart, ...decimalParts] = text.split(/[点點.]/)
  if (decimalParts.length > 1) {
    throw new ChineseNumberError(`"${input}" 含多个小数点`)
  }

  const decimalText = decimalParts[0]
  if (decimalParts.length === 1 && !decimalText) {
    throw new ChineseNumberError(`"${input}" 小数点后缺少数字`)
  }
  if (decimalParts.length === 1 && !integerPart) {
    throw new ChineseNumberError(`"${input}" 小数点前缺少数字`)
  }

  const integer = parseInteger(integerPart, mode, input)
  if (decimalText === undefined) {
    return negative ? -integer : integer
  }

  const decimal = parseDecimalDigits(decimalText, input)
  const value = Number((integer + decimal).toPrecision(15))
  return negative ? -value : value
}

function parseInteger(text: string, mode: ParseMode, original: string): number {
  // 纯数码串（无任何单位）按位拼读：一二三 = 123，而不是累加成 6。
  // 电话号码、年份常是这种写法。
  if (text.length > 1 && ![...text].some((ch) => UNITS[ch] !== undefined)) {
    let digits = ''
    for (const ch of text) {
      const digit = DIGITS[ch]
      if (digit === undefined) {
        throw new ChineseNumberError(`"${original}" 不是合法的中文数字`)
      }
      digits += digit
    }
    return Number(digits)
  }

  let normalized = normalizeInteger(text)

  // 口语补位优先于书面解释。「一万二」在书面上也能读成 10002，
  // 但中文口语里几乎总是 12000——nzh 正是在这里给出 10002 而不报错。
  // 只有末位单位降级后仍有意义（≥百）才补：「二十一」的十降级到个位，无需补位。
  if (SPOKEN_PATTERN.test(normalized) && lastUnitOf(normalized) >= 100) {
    if (mode === 'strict') {
      throw new ChineseNumberError(`"${original}" 是口语省略写法，strict 模式不接受`)
    }
    normalized = completeSpokenUnit(normalized, original)
  }

  if (!INTEGER_PATTERN.test(normalized)) {
    throw new ChineseNumberError(`"${original}" 不是合法的中文数字`)
  }

  return accumulate(normalized)
}

/** 补零补一，把口语省略的结构还原成规范写法。 */
function normalizeInteger(text: string): string {
  const nz = NONZERO_DIGIT_CHARS
  return text
    // 万/亿 后直接跟「非零数字+十/百」缺零：一万三十 → 一万零三十
    .replace(new RegExp(`([万萬亿億])([${nz}][十拾百佰])`, 'g'), '$1零$2')
    // 千 后直接跟十位：一千十 → 一千零十（已有「零」的写法不受影响）
    .replace(new RegExp(`([千仟])([${nz}]?[十拾])`, 'g'), '$1零$2')
    // 百 后直接跟十：一百十一 → 一百一十一
    .replace(/([百佰])([十拾])/g, '$1一$2')
    // 零十 → 零一十，零百 → 零一百
    .replace(/零([十拾])/g, '零一$1')
    .replace(/零([百佰])/g, '零一$1')
}

function lastUnitOf(text: string): number {
  let lastUnit = 0
  for (const ch of text) {
    if (UNITS[ch] !== undefined) lastUnit = UNITS[ch]
  }
  return lastUnit
}

/**
 * 口语补位：取末位单位，降一级补在最后。
 * 一万二 → 万(10000) → 千 → 一万二千 = 12000
 * 两百五 → 百(100)   → 十 → 两百五十 = 250
 */
function completeSpokenUnit(text: string, original: string): string {
  const nextUnit = UNIT_BY_VALUE[lastUnitOf(text) / 10]
  if (!nextUnit) {
    throw new ChineseNumberError(`"${original}" 的省略写法无法还原`)
  }
  return text + nextUnit
}

/**
 * 倒序位置累加。`tenThousandUnit` 负责万进制的嵌套：
 * 「亿」出现后，其右侧的「万」要乘上亿的倍率。
 */
function accumulate(text: string): number {
  const chars = [...text]
  let total = 0
  let unit = 1
  let tenThousandUnit = 1

  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const digit = DIGITS[ch]

    if (digit !== undefined) {
      total += digit * unit
      continue
    }

    unit = UNITS[ch]
    if (unit % 10000 === 0) {
      if (unit > tenThousandUnit) {
        tenThousandUnit = unit
      } else {
        tenThousandUnit = unit * tenThousandUnit
        unit = tenThousandUnit
      }
    }
    if (unit < tenThousandUnit) {
      unit *= tenThousandUnit
    }
    // 单位出现在最高位时自身补 1：十一 = 11
    if (i === 0) total += unit
  }

  return total
}

function parseDecimalDigits(text: string, original: string): number {
  let value = 0
  let scale = 0.1
  for (const ch of text) {
    const digit = DIGITS[ch]
    if (digit === undefined) {
      throw new ChineseNumberError(`"${original}" 小数部分含非数字字符 "${ch}"`)
    }
    value += digit * scale
    scale /= 10
  }
  return value
}

const SIMPLE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const SIMPLE_UNITS = ['', '十', '百', '千']

/**
 * 把阿拉伯数字段转成中文，供 smart 模式的混写通道使用。
 * 带前导零的段按位读（"1百01" 的 "01" → 零一），其余按数值读（"1万600" 的 "600" → 六百），
 * 否则 600 会变成「六零零」而算错。
 */
function arabicToChinese(segment: string): string {
  if (segment.length > 1 && segment.startsWith('0')) {
    return [...segment].map((ch) => SIMPLE_DIGITS[Number(ch)]).join('')
  }
  return integerToChinese(Number(segment))
}

/** 数值 → 中文（万进制，仅供混写通道内部使用）。 */
function integerToChinese(value: number): string {
  if (value === 0) return '零'
  if (value >= 100000000) {
    const high = Math.floor(value / 100000000)
    const rest = value % 100000000
    return integerToChinese(high) + '亿' + (rest ? joinRemainder(rest, 100000000) : '')
  }
  if (value >= 10000) {
    const high = Math.floor(value / 10000)
    const rest = value % 10000
    return integerToChinese(high) + '万' + (rest ? joinRemainder(rest, 10000) : '')
  }

  const digits = [...String(value)].map(Number)
  let out = ''
  let pendingZero = false
  digits.forEach((digit, index) => {
    const unitIndex = digits.length - 1 - index
    if (digit === 0) {
      pendingZero = true
      return
    }
    if (pendingZero && out) out += '零'
    pendingZero = false
    out += SIMPLE_DIGITS[digit] + SIMPLE_UNITS[unitIndex]
  })
  return out
}

/** 余数不足一个数量级时补「零」：一万零六百。 */
function joinRemainder(rest: number, scale: number): string {
  const needsZero = rest < scale / 10
  return (needsZero ? '零' : '') + integerToChinese(rest)
}

/**
 * 数值 → 中文，用于回答生成。
 * 这个方向直接用 nzh：它全程字符串运算、无精度上限，比反过来解析可靠得多
 * （nzh 的解析方向在口语写法上会静默给出错数，所以本模块自研了解析）。
 *
 * 超出可读范围的数（极大、极小、位数过多）保持阿拉伯数字，
 * 硬转成中文只会更难读。
 */
export function formatChineseNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null
  if (value !== 0 && (Math.abs(value) >= 1e12 || Math.abs(value) < 1e-4)) return null

  const decimals = String(value).split('.')[1]
  if (decimals && decimals.length > 4) return null

  try {
    return nzhCn.encodeS(value)
  } catch {
    return null
  }
}

/** 输入是否可能是中文数字（用于分词层快速判定，不做合法性校验）。 */
export function looksLikeChineseNumber(text: string): boolean {
  if (!text) return false
  return [...text].every(
    (ch) => DIGITS[ch] !== undefined || UNITS[ch] !== undefined || ARCHAIC[ch] !== undefined || '点點负'.includes(ch),
  )
}

export const CHINESE_NUMBER_CHARS = DIGIT_CHARS + UNIT_CHARS + Object.keys(ARCHAIC).join('')
