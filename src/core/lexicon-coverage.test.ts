/**
 * 词表覆盖与构式边界测试。
 *
 * 前面那些测试是「想到什么测什么」，发现不了这一类 bug：
 * 「二成一三」里的「成」被当成「三成=0.3」吞掉，剩下的数悬空——
 * 问题不在任何单个构式，而在**两个构式相邻时的边界**。
 *
 * 这个文件用组合的方式覆盖：
 *   一、词表里每个条目都至少被一条用例走到（防止加了词却没人用）
 *   二、构式两两相邻时不会互相吞噬
 *   三、核心属性：任何输入要么算对、要么明确失败，**绝不给出错误答案**
 */
import { describe, expect, it } from 'vitest'
import lexicon from './grammar/lexicon.json'
import { understand } from './nlu'
import { evaluate } from '../engines/mathEngine'

/** 算出数值；解析失败或算不出时返回 null。 */
function tryCompute(input: string): number | null {
  const result = understand(input)
  if (!result.ok || result.request.kind !== 'evaluate') return null
  try {
    const { value } = evaluate(result.request.candidates[0].expression)
    return value.kind === 'complex' ? null : value.approx
  } catch {
    return null
  }
}

describe('词表覆盖：每个条目都要有用例走到', () => {
  /**
   * 每个词条配一个最小可算的句子与期望值。
   * 加词表时必须同步加这里一行——否则测试会报缺失，词就不会悄悄躺在表里没人用。
   */
  const USAGE: Record<string, [string, number]> = {
    // 运算符
    加上: ['二加上三', 5], 加: ['二加三', 5], 累加: ['二累加三', 5],
    减去: ['五减去三', 2], 减掉: ['五减掉三', 2], 减: ['五减三', 2],
    乘以: ['二乘以三', 6], 乘上: ['二乘上三', 6], 乘: ['二乘三', 6],
    除以: ['六除以三', 2],
    取余: ['十对三取余', 1], 取模: ['十对三取模', 1], 模: ['十模三', 1],
    // 函数
    正弦: ['正弦零', 0], sin: ['sin零', 0],
    余弦: ['余弦零', 1], cos: ['cos零', 1],
    正切: ['正切零', 0], tan: ['tan零', 0],
    反正弦: ['反正弦零', 0], arcsin: ['arcsin零', 0], asin: ['asin零', 0],
    反余弦: ['反余弦一', 0], arccos: ['arccos一', 0], acos: ['acos一', 0],
    反正切: ['反正切零', 0], arctan: ['arctan零', 0], atan: ['atan零', 0],
    双曲正弦: ['双曲正弦零', 0], sinh: ['sinh零', 0],
    双曲余弦: ['双曲余弦零', 1], cosh: ['cosh零', 1],
    双曲正切: ['双曲正切零', 0], tanh: ['tanh零', 0],
    自然对数: ['一的自然对数', 0], ln: ['ln一', 0],
    常用对数: ['一百的常用对数', 2], lg: ['lg一百', 2], log: ['log一百', 2],
    // 英文函数名整体收词，防止被切成 log+数字（log10(x) 曾解析成 lg(10)×x）
    log10: ['log10(100)', 2], log2: ['log2(8)', 3],
    绝对值: ['负三的绝对值', 3], abs: ['abs负三', 3],
    根号: ['根号九', 3], sqrt: ['sqrt九', 3],
    // 常量
    圆周率: ['圆周率乘零', 0], 派: ['派乘零', 0], pi: ['pi乘零', 0], π: ['π乘零', 0],
    自然常数: ['自然常数的零次方', 1], e: ['e的零次方', 1],
    自然对数的底: ['自然对数的底的零次方', 1],
    // 虚数单位平方回到实数，才能用数值断言
    虚数单位: ['虚数单位乘以虚数单位', -1], i: ['i乘以i', -1],
    // 构式关键词
    次方: ['二的三次方', 8], 次幂: ['二的三次幂', 8],
    次方根: ['八的三次方根', 2],
    平方根: ['九的平方根', 3], 立方根: ['八的立方根', 2],
    平方: ['三的平方', 9], 立方: ['二的立方', 8],
    开平方: ['九开平方', 3], 开方: ['九开方', 3], 开: ['八开三次方', 2],
    阶乘: ['五的阶乘', 120],
    倒数: ['四的倒数', 0.25],
    余数: ['十除以三的余数', 1],
    百分之: ['百分之五十', 0.5], 分之: ['二分之一', 0.5],
    又: ['二又二分之一', 2.5],
    以: ['以二为底八的对数', 3],
    与: ['三与五的和', 8], 跟: ['三跟五的和', 8],
    和: ['三与五的和', 8], 差: ['五与三的差', 2],
    积: ['三与五的积', 15], 商: ['六与三的商', 2],
    倍: ['三的二倍', 6],
    度: ['正弦三十度', 0.5],
    折: ['一百打八折', 80], 打: ['一百打八折', 80],
    成: ['三成', 0.3],
    涨: ['一百涨百分之十', 110], 增加: ['一百增加百分之十', 110],
    降: ['一百降百分之十', 90], 减少: ['一百减少百分之十', 90],
    负: ['负三加五', 2],
    再: ['三加五再乘二', 16], 然后: ['三加五然后乘二', 16],
    对: ['十对三取余', 1],
  }

  const declared = [
    ...Object.keys(lexicon.operators),
    ...Object.keys(lexicon.functions),
    ...Object.keys(lexicon.constants),
    ...Object.keys(lexicon.keywords),
  ].filter((word) => !word.startsWith('$'))

  it('词表里没有未被用例覆盖的条目', () => {
    // 这些词只在特定位置有意义，由别处的用例间接覆盖
    const coveredElsewhere = new Set([
      '+', '-', '*', '/', '×', '÷', '=', '＝',
      '的', '为底', '对数', '接着', '涨了', '降了', '上涨', '下降', '等于',
    ])

    const missing = declared.filter(
      (word) => !(word in USAGE) && !coveredElsewhere.has(word),
    )
    expect(missing, `这些词表条目没有对应用例：${missing.join('、')}`).toEqual([])
  })

  it.each(Object.entries(USAGE))('「%s」：%s', (_word, [sentence, expected]) => {
    const got = tryCompute(sentence)
    expect(got, `「${sentence}」应算出 ${expected}`).toBeCloseTo(expected, 6)
  })
})

/**
 * 构式相邻边界。
 *
 * 「二成一三」的 bug 就出在这里：单看「三成」没问题，单看「一三」没问题，
 * 但「成」后面紧跟数字时，TENTH 规则把前半截吞了，后半截无处安放。
 */
describe('构式相邻时不互相吞噬', () => {
  it.each([
    // 「成」后面跟数字时不能当「三成」处理（语音把「乘以」听成「成一」）
    ['二成一三', null],
    ['e的平方加上二成一三', null],
    // 「打折」「涨跌」需要完整结构，残缺时不能吞掉左操作数
    ['一百打', null],
    ['一百涨', null],
    // 「的」后面必须跟得上构式
    ['三的', null],
    ['三的什么', null],
    // 「与…的」名词形残缺
    ['三与五', null],
    ['三与五的', null],
    // 「以…为底」残缺
    ['以二为底', null],
    // 「又…分之」残缺
    ['二又三', null],
    // 顺序词后面必须有运算
    ['三加五再', null],
  ] as Array<[string, null]>)('残缺输入「%s」明确失败而不是给个数', (input) => {
    expect(tryCompute(input)).toBe(null)
  })

  it.each([
    // 相邻构式都完整时要各自成立
    ['三成加二成', 0.5],
    ['三的平方加二的平方', 13],
    ['二分之一加三分之一', 5 / 6],
    ['根号九加根号四', 5],
    ['五的阶乘减四的阶乘', 96],
    ['一百打八折再加二十', 100],
    ['正弦三十度加余弦零度', 1.5],
  ] as Array<[string, number]>)('相邻的完整构式「%s」= %d', (input, expected) => {
    expect(tryCompute(input)).toBeCloseTo(expected, 6)
  })
})

/**
 * 核心属性：绝不给出错误答案。
 *
 * 这是整个项目最重要的不变量——比「功能覆盖率」重要得多。
 * 计算器算错比报错糟糕，因为用户不会去核对。
 */
describe('属性：要么算对，要么明确失败', () => {
  /** 用词表零件随机拼句子，验证结果要么正确要么失败，不会是别的数。 */
  const NUMBERS = ['一', '二', '三', '五', '十', '2', '7']
  const BINARY: Array<[string, (a: number, b: number) => number]> = [
    ['加', (a, b) => a + b],
    ['减', (a, b) => a - b],
    ['乘以', (a, b) => a * b],
    ['除以', (a, b) => a / b],
  ]
  const VALUE: Record<string, number> = { 一: 1, 二: 2, 三: 3, 五: 5, 十: 10, '2': 2, '7': 7 }

  it('两操作数的四则运算全组合都算对', () => {
    const wrong: string[] = []
    for (const left of NUMBERS) {
      for (const [word, apply] of BINARY) {
        for (const right of NUMBERS) {
          const input = `${left}${word}${right}`
          const expected = apply(VALUE[left], VALUE[right])
          const got = tryCompute(input)
          // 允许失败（明确报错），但不允许算成别的数
          if (got !== null && Math.abs(got - expected) > 1e-9) {
            wrong.push(`${input} → ${got}，应为 ${expected}`)
          }
        }
      }
    }
    expect(wrong, `这些组合算错了：\n${wrong.join('\n')}`).toEqual([])
  })

  it('三操作数运算遵守优先级', () => {
    const wrong: string[] = []
    for (const a of ['二', '三']) {
      for (const [w1, f1] of BINARY) {
        for (const b of ['二', '五']) {
          for (const [w2, f2] of BINARY) {
            for (const c of ['二', '三']) {
              const input = `${a}${w1}${b}${w2}${c}`
              const got = tryCompute(input)
              if (got === null) continue

              const [x, y, z] = [VALUE[a], VALUE[b], VALUE[c]]
              const highFirst = ['乘以', '除以'].includes(w2) && ['加', '减'].includes(w1)
              const expected = highFirst ? f1(x, f2(y, z)) : f2(f1(x, y), z)
              if (Math.abs(got - expected) > 1e-9) {
                wrong.push(`${input} → ${got}，应为 ${expected}`)
              }
            }
          }
        }
      }
    }
    expect(wrong, `优先级算错：\n${wrong.join('\n')}`).toEqual([])
  })

  it('非数学输入一律失败，不会凑出一个数', () => {
    const nonsense = [
      '今天天气不错', '你好呀', '这是一段话', '苹果香蕉',
      '我想吃饭', '帮我订个机票', '一二三四五上山打老虎',
      '成成成', '的的的', '加加加', '再再再',
    ]
    for (const input of nonsense) {
      expect(tryCompute(input), `「${input}」不该算出数`).toBe(null)
    }
  })
})

/**
 * 实测中发现的 bug 回归。
 * 每条都对应一次真实的手工测试，注明当初错在哪——这类用例最值钱，
 * 因为它们证明的是「同样的坑不会再踩第二次」。
 */
describe('bug 回归', () => {
  it('「成」后跟数字不再吞掉左操作数', () => {
    // 曾经：「成」按「三成=0.3」处理，吞掉「二成」，剩下「一三」悬空，
    // 报出与真实原因无关的错。现在明确失败并可转 AI 纠音。
    expect(tryCompute('e的平方加上二成一三')).toBe(null)
    expect(tryCompute('二成一三')).toBe(null)
    // 但正常的「三成」不受影响
    expect(tryCompute('三成')).toBeCloseTo(0.3, 9)
    expect(tryCompute('一百涨三成')).toBeCloseTo(130, 9)
  })

  it('ASCII 负号可解析（语音识别常这么输出）', () => {
    expect(tryCompute('3.5乘以-2')).toBeCloseTo(-7, 9)
    expect(tryCompute('-2的平方')).toBeCloseTo(4, 9)
    expect(tryCompute('10-3')).toBeCloseTo(7, 9)
  })

  it('上标与隐式乘法（课本写法）', () => {
    expect(tryCompute('2²')).toBeCloseTo(4, 9)
    expect(tryCompute('2x²')).toBe(null) // 含未知数，走方程通道而非求值
    expect(tryCompute('3(2+1)')).toBeCloseTo(9, 9)
  })

  it('链式幂按中文从左往右读', () => {
    // 曾经少一层括号，被 mathjs 的右结合读成 2^(3^2)=512
    expect(tryCompute('二的三次方的二次方')).toBeCloseTo(64, 9)
  })

  it('整数结果不被有效数字修约破坏', () => {
    // 曾经 factorial(20) 被 12 位修约成 2432902008180000000
    expect(tryCompute('二十的阶乘')).toBe(2432902008176640000)
  })
})
