/**
 * 意图识别。
 *
 * 判定发生在分词之后：看 token 流里有没有未知数、等号、意图词，
 * 而不是对原始文本做关键词匹配——「解」在「解方程」里是意图词，
 * 在别处可能只是普通字，token 化后这层歧义已经消掉了。
 */
import type { Token } from './tokenizer'

export type Intent =
  /** 普通求值，走 mathjs。 */
  | { kind: 'evaluate'; tokens: Token[] }
  /** 解方程，左右两侧 token 分开。 */
  | {
      kind: 'solve'
      left: Token[]
      right: Token[]
      variable: string
      /** 式子里出现的其它未知数。非空时解只能用它们表示。 */
      otherVariables: string[]
    }
  /** 求导 / 积分。 */
  | { kind: 'calculus'; operation: 'diff' | 'integrate'; tokens: Token[]; variable: string }

export function classify(tokens: Token[]): Intent {
  const stripped = tokens.filter((token) => token.kind !== 'intent')
  const intents = tokens.filter((token): token is Extract<Token, { kind: 'intent' }> =>
    token.kind === 'intent',
  )
  const variable = firstVariable(stripped)

  const calculusIntent = intents.find((token) => token.intent === 'DIFF' || token.intent === 'INTEGRATE')
  if (calculusIntent && variable) {
    return {
      kind: 'calculus',
      operation: calculusIntent.intent === 'DIFF' ? 'diff' : 'integrate',
      tokens: stripped,
      variable,
    }
  }

  const equalsAt = stripped.findIndex(
    (token) => token.kind === 'keyword' && token.tag === 'EQUALS',
  )

  // 有未知数又有等号，才是方程。缺一个就当普通算式，让下游给出清楚的失败原因。
  if (variable && equalsAt !== -1) {
    return {
      kind: 'solve',
      left: stripped.slice(0, equalsAt),
      right: stripped.slice(equalsAt + 1),
      variable,
      // 多个未知数时只能解出「用另一个未知数表示」的形式，
      // 回答里要讲明白，不能让用户以为解出了具体的数
      otherVariables: allVariables(stripped).filter((name) => name !== variable),
    }
  }

  // 「一加一等于」这类句尾悬空的「等于」直接丢掉，它是语气不是运算
  const withoutTrailingEquals =
    equalsAt === stripped.length - 1 ? stripped.slice(0, equalsAt) : stripped

  return { kind: 'evaluate', tokens: withoutTrailingEquals }
}

function firstVariable(tokens: Token[]): string | null {
  return allVariables(tokens)[0] ?? null
}

function allVariables(tokens: Token[]): string[] {
  const names = tokens
    .filter((token): token is Extract<Token, { kind: 'variable' }> => token.kind === 'variable')
    .map((token) => token.name)
  return [...new Set(names)]
}
