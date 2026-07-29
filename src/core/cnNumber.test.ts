import { describe, expect, it } from 'vitest'
import { ChineseNumberError, formatChineseNumber, parseChineseNumber } from './cnNumber'

/** 用例取自 cn2an 测试集，是这套规则的验收基准。 */
describe('规范书面写法', () => {
  const cases: Array<[string, number]> = [
    ['一', 1],
    ['十一', 11],
    ['一十一', 11],
    ['一百零三', 103],
    ['一千零十', 1010],
    ['一千零十一', 1011],
    ['一万零一百一十一', 10111],
    ['十万零一千', 101000],
    ['一亿五千万六千三百五十五', 150006355],
    ['一百二十三', 123],
    ['九千九百九十九', 9999],
  ]

  it.each(cases)('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })
})

describe('负数与小数', () => {
  const cases: Array<[string, number]> = [
    ['负一', -1],
    ['负十', -10],
    ['负十一', -11],
    ['三点五', 3.5],
    ['零点一', 0.1],
    ['零点零一', 0.01],
    ['负三点五', -3.5],
    ['一百点二五', 100.25],
  ]

  it.each(cases)('%s = %d', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })
})

describe('口语省略写法', () => {
  const cases: Array<[string, number]> = [
    ['一万二', 12000],
    ['两百五', 250],
    ['三万五', 35000],
    ['两千六', 2600],
    ['一百二', 120],
    ['十三万五', 135000],
  ]

  it.each(cases)('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })

  it('strict 模式拒绝口语写法', () => {
    expect(() => parseChineseNumber('一万二', 'strict')).toThrow(ChineseNumberError)
  })
})

describe('异体字与古语', () => {
  const cases: Array<[string, number]> = [
    ['两百', 200],
    ['兩千六', 2600],
    ['〇', 0],
    ['壹拾壹', 11],
    ['壹佰贰拾叁', 123],
    ['廿二', 22],
    ['卅', 30],
    ['幺', 1],
  ]

  it.each(cases)('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })

  it('strict 模式拒绝口语异体字', () => {
    expect(() => parseChineseNumber('两百', 'strict')).toThrow(/口语写法/)
  })
})

describe('中阿混写（smart 档）', () => {
  const cases: Array<[string, number]> = [
    ['3千2百', 3200],
    ['1百01', 101],
    ['10.1万', 101000],
    ['100万', 1000000],
    ['1万600', 10600],
  ]

  it.each(cases)('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })

  it('normal 模式拒绝混写', () => {
    expect(() => parseChineseNumber('3千2百', 'normal')).toThrow(/smart/)
  })
})

describe('纯数码串', () => {
  it.each([
    ['一二三', 123],
    ['三五八', 358],
  ] as Array<[string, number]>)('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected)
  })
})

/** 底线用例：这些必须抛错，绝不能静默返回一个错数。 */
describe('非法输入必须抛错', () => {
  const invalid = [
    '百十一',
    '十一十二',
    '十七十八',
    '零点',
    '点零',
    '十..一',
    '一二三四五六七八九十百',
    '',
    '苹果',
  ]

  it.each(invalid)('拒绝 "%s"', (input) => {
    expect(() => parseChineseNumber(input)).toThrow(ChineseNumberError)
  })
})

describe('全角输入', () => {
  it('全角数字归一化后可解析', () => {
    expect(parseChineseNumber('１００万')).toBe(1000000)
  })
})

describe('数值 → 中文（回答生成用）', () => {
  const cases: Array<[number, string]> = [
    [2, '二'],
    [0.5, '零点五'],
    [11, '十一'],
    [-3, '负三'],
    [103, '一百零三'],
    [3.5, '三点五'],
    [12000, '一万二千'],
    [0, '零'],
  ]

  it.each(cases)('%d → %s', (value, expected) => {
    expect(formatChineseNumber(value)).toBe(expected)
  })

  it('超出可读范围时不转中文', () => {
    expect(formatChineseNumber(2.68811714182e43)).toBeNull()
    expect(formatChineseNumber(0.333333333333)).toBeNull()
  })

  it('与解析方向可往返', () => {
    for (const value of [1, 11, 103, 250, 12000, 3.5, -3]) {
      const chinese = formatChineseNumber(value)
      expect(chinese).not.toBeNull()
      expect(parseChineseNumber(chinese as string)).toBe(value)
    }
  })
})
