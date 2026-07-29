/**
 * 承接判定：这句话是新算式，还是接着上一个结果继续算？
 *
 * 两种场景共用一套规则：
 *   同句多步 —— 「1+2×3等于几？再乘5等于几？」一次说完
 *   跨轮追问 —— 「1+1等于几」→「那在这个基础上再乘以5」
 *
 * 判定原则是**只在句子自己说不完整时才承接**：剥掉承接语后如果以运算词开头
 * （「再乘以5」「加3」），那它缺左操作数，缺的就是上一个结果；
 * 如果句子本身完整（「三加五等于几」），无论前面说过什么都当新算式。
 *
 * 这条边界让误判的代价可控：承接的结果一定带算式回显，用户一眼能看出
 * 系统拿哪个数接的。
 */

/** 分句边界：问号、句号、分号，以及「然后/接着」这类顺承连词。 */
const SENTENCE_BREAK = /[?？。；;！!]+|(?=然后|接着)/

/**
 * 承接语。剥掉它们才能看出剩下的部分是不是以运算词起头。
 * 「在这个基础上」「那」「结果」这类词本身不参与计算。
 */
const LEADING_CONNECTIVES =
  /^(?:好的?|ok|OK|那么?|然后|接着|后面|之后|接下来|如果|在?(?:这个?|此)?基础上|这个?结果|上面的?|刚才的?|它|再|又|还|把)+/gi

/** 以运算词起头 = 这一步作用在上一步的结果上。 */
const LEADING_OPERATOR =
  /^(?:加上|加|减去|减|乘以|乘上|乘|除以|除|开方|开平方|取余|模)/

/** 以后缀构式起头，如「的平方」「的三次方」——同样承接上一个结果。 */
const LEADING_SUFFIX = /^的(?:平方|立方|阶乘|绝对值|倒数|平方根|立方根|\d+次方)/

export interface Step {
  /** 送去解析的文本。承接上一步时已剥掉承接语。 */
  text: string
  /** 用户原话，用于回显。 */
  original: string
  /** 是否承接上一步的结果。 */
  continuesPrevious: boolean
}

/**
 * 把输入切成若干步骤。单步输入返回长度为 1 的数组，
 * 调用方无须区分两种情况。
 */
export function splitSteps(input: string): Step[] {
  const pieces = input
    .split(SENTENCE_BREAK)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)

  if (pieces.length <= 1) {
    return [{ text: input, original: input, continuesPrevious: false }]
  }

  const steps: Step[] = []
  for (const piece of pieces) {
    const stripped = stripConnectives(piece)
    if (!stripped) continue

    // 第一句永远独立；之后缺左操作数的才算承接
    const continues = steps.length > 0 && needsPreviousResult(stripped)
    steps.push({
      text: continues ? stripped : piece,
      original: piece,
      continuesPrevious: continues,
    })
  }

  return steps.length > 0 ? steps : [{ text: input, original: input, continuesPrevious: false }]
}

/**
 * 跨轮判定：这句话是否接着上一轮的结果算。
 * 返回剥掉承接语后的文本，不承接则返回 null。
 */
export function asFollowUp(input: string): string | null {
  const stripped = stripConnectives(input.trim())
  if (!stripped || stripped === input.trim()) {
    // 一个字都没剥掉时，只有真的以运算词开头才算承接（「乘以5」）
    return needsPreviousResult(input.trim()) ? input.trim() : null
  }
  return needsPreviousResult(stripped) ? stripped : null
}

function stripConnectives(text: string): string {
  return text.replace(LEADING_CONNECTIVES, '').replace(/^[,，、\s]+/, '').trim()
}

/** 句子是否缺左操作数——缺的那个就是上一个结果。 */
function needsPreviousResult(text: string): boolean {
  return LEADING_OPERATOR.test(text) || LEADING_SUFFIX.test(text)
}
