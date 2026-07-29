/**
 * 回答生成的诚实性。
 *
 * 引擎已经分清了精确值与近似值（EvalValue.exact），这一层的责任是
 * **别把这个区分丢掉**。同一屏上公式写 `√2 ≈ 1.414…`、文案写
 * 「等于 1.41421356237」，用户该信哪个？
 */
import { describe, expect, it } from 'vitest'
import { describe as describeValue, displayExpression, formulaTex, prefersChineseStyle } from './nlg'
import { evaluate, type EvalValue } from '../engines/mathEngine'

/** 走真实引擎，避免手搓的 EvalValue 和引擎实际产出对不上。 */
const answerOf = (expression: string, useChinese = false) =>
  describeValue(evaluate(expression).value, useChinese).text

describe('精确值用等号，近似值用约等号', () => {
  it.each([
    ['1+1', '等于 2'],
    ['factorial(30)', '等于 265252859812191058636308480000000'],
    ['sin(30*pi/180)', '等于 0.5'],
    ['cos(pi)', '等于 -1'],
    ['sin(pi)', '等于 0'],
  ] as Array<[string, string]>)('%s → %s', (expression, expected) => {
    expect(answerOf(expression)).toBe(expected)
  })

  it.each([
    ['sqrt(2)', '约等于 1.41421356237'],
    ['2^0.5', '约等于 1.41421356237'],
    ['e^100', '约等于 2.68811714182 × 10⁴³'],
  ] as Array<[string, string]>)('%s → %s', (expression, expected) => {
    // 浏览器实测过：公式回显写 ≈、文案却写「等于 1.41421356237」，两处自相矛盾
    expect(answerOf(expression)).toBe(expected)
  })
})

describe('中文数字只用来念精确值', () => {
  it('精确值照常念中文', () => {
    expect(answerOf('1+1', true)).toBe('等于二')
    expect(answerOf('sin(pi)', true)).toBe('等于零')
  })

  it('近似值给数字而不是念成中文', () => {
    // 把修约过的近似值念成中文，读起来像在保证每一位都对
    const answer = answerOf('sqrt(2)', true)
    expect(answer).toBe('约等于 1.41421356237')
  })
})

describe('分数与复数的答句', () => {
  it('分数给精确形与近似值', () => {
    expect(answerOf('1/3')).toBe('等于 1/3，约 0.333333')
  })

  it('整数分数按整数说', () => {
    expect(answerOf('6/2')).toBe('等于 3')
    expect(answerOf('6/2', true)).toBe('等于三')
  })

  it('复数直接给 a+bi', () => {
    expect(answerOf('sqrt(-4)')).toBe('等于 2i')
  })

  it('复数的近似值同样用约等号', () => {
    // 公式回显那边按 exact 打了 ≈，文案不能另说一套
    expect(answerOf('sqrt(-2)')).toBe('约等于 1.41421356237i')
    expect(answerOf('1+i/10^13')).toBe('约等于 1 + 1e-13i')
  })
})

describe('回答风格跟随输入', () => {
  it.each(['一加一等于几', '3加五', 'sin派'])('「%s」用中文回答', (input) => {
    expect(prefersChineseStyle(input)).toBe(true)
  })

  it.each(['3+5', '100/4', 'sqrt(2)'])('「%s」用阿拉伯数字回答', (input) => {
    expect(prefersChineseStyle(input)).toBe(false)
  })
})

describe('算式回显', () => {
  it('近似值的公式用 ≈ 而不是 =', () => {
    expect(formulaTex('\\sqrt{2}', '1.41421356237', false)).toContain('\\approx')
    expect(formulaTex('1+1', '2', true)).toContain('=')
  })

  it('分数渲染成 \\frac，科学计数渲染成 ×10ⁿ', () => {
    expect(formulaTex('x', '1/3')).toContain('\\frac{1}{3}')
    expect(formulaTex('x', '2.68811714182e+43')).toContain('\\times 10^{43}')
  })

  it('规范表达式改写成数学书写习惯', () => {
    expect(displayExpression('(1)+(1)')).toBe('1+1')
    expect(displayExpression('sqrt(9)')).toBe('√(9)')
    expect(displayExpression('log(8,2)')).toBe('log₂(8)')
    expect(displayExpression('log10(100)')).toBe('lg(100)')
    expect(displayExpression('log(8)')).toBe('ln(8)')
  })
})

describe('exact 字段一路带到文案', () => {
  it('引擎说近似，文案就必须说近似', () => {
    // 这条守的是「展示层不许自己重新判断精确与否」——
    // 它没有引擎那些高精度复核的信息，判不准
    const approximate: EvalValue = {
      kind: 'real',
      decimal: '2',
      approx: 2,
      exact: false,
    }
    expect(describeValue(approximate, false).text).toBe('约等于 2')
    // 看起来是个整数，但引擎说它是近似的，就不能念成「等于二」
    expect(describeValue(approximate, true).text).toBe('约等于 2')
  })
})
