import { describe, expect, it } from 'vitest'
import { understand } from './nlu'
import { evaluate } from '../engines/mathEngine'

/** 取求值意图的候选列表；不是求值意图就报错，让测试失败得清楚。 */
function candidatesOf(input: string) {
  const result = understand(input)
  if (!result.ok) throw new Error(`解析失败：${result.reason}`)
  if (result.request.kind !== 'evaluate') {
    throw new Error(`期望求值意图，实际是 ${result.request.kind}`)
  }
  return result.request.candidates
}

/** 层一：中文 → 规范串。纯字符串进出，失败时定位精确。 */
function canonical(input: string): string {
  return candidatesOf(input)[0].expression
}

/** 层二：中文 → 数值。只跑演示清单里的端到端用例。 */
function compute(input: string): string {
  const { value } = evaluate(canonical(input))
  if (value.kind === 'complex') return value.text
  return value.kind === 'rational' ? value.fraction : value.decimal
}

describe('四则与问句', () => {
  it.each([
    ['一加一等于几', '2'],
    ['一加一', '2'],
    ['请问三加五等于多少', '8'],
    ['帮我算一下十二减五', '7'],
    ['3加五是多少', '8'],
    ['七乘以八', '56'],
    ['一百除以四', '25'],
    ['1+2*3', '7'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })

  it('运算优先级正确', () => {
    expect(canonical('一加二乘三')).toBe('((1)+((2)*(3)))')
  })
})

describe('负号绑定（决定文法形状的一对用例）', () => {
  it('负二的平方 = 4', () => {
    expect(compute('负二的平方')).toBe('4')
  })

  it('负的二的平方 = -4', () => {
    expect(compute('负的二的平方')).toBe('-4')
  })

  it('负二加三 = 1', () => {
    expect(compute('负二加三')).toBe('1')
  })
})

describe('幂与根', () => {
  it.each([
    ['二的三次方', '8'],
    ['二的十次幂', '1024'],
    ['三的平方', '9'],
    ['二的立方', '8'],
    ['根号九', '3'],
    ['九的平方根', '3'],
    ['二十七的立方根', '3'],
    ['八开三次方', '2'],
    ['九开方', '3'],
    ['八的三次方根', '2'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })

  it('链式幂按中文从左往右读', () => {
    // 二的三次方的二次方 = (2³)² = 64，而不是 2^(3²) = 512
    expect(compute('二的三次方的二次方')).toBe('64')
    expect(canonical('二的三次方的二次方')).toBe('(((2)^(3))^(2))')
  })

  it('负数的奇次方根取实根', () => {
    expect(compute('负八的三次方根')).toBe('-2')
  })

  it('负数的平方根提升为复数', () => {
    expect(compute('根号负四')).toBe('2i')
  })
})

describe('三段式不连续构式', () => {
  it.each([
    ['以二为底八的对数', '3'],
    ['以三为底九的对数', '2'],
    ['一百除以七的余数', '2'],
    ['十对三取余', '1'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })
})

describe('分数与百分比（展开成显式算式，不用引擎的 %）', () => {
  it.each([
    ['三分之一', '1/3'],
    ['二分之一加三分之一', '5/6'],
    ['百分之二十', '1/5'],
    ['二又二分之一', '5/2'],
    ['一百乘以百分之二十', '20'],
    ['一百打八折', '80'],
    ['一百涨百分之十', '110'],
    ['一百降两成', '80'],
    ['三成', '3/10'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })
})

describe('三角函数与角度制自动判断', () => {
  it('带「度」按角度制', () => {
    expect(compute('sin三十度')).toBe('0.5')
    expect(compute('正弦三十度')).toBe('0.5')
  })

  it('不带「度」按弧度制', () => {
    expect(compute('cos派')).toBe('-1')
    expect(compute('余弦圆周率')).toBe('-1')
  })

  it('修约后干净收敛', () => {
    expect(compute('cos派加sin派')).toBe('-1')
  })
})

describe('名词形分组——中文里的天然括号', () => {
  it('三与五的和乘以二 = 16', () => {
    expect(compute('三与五的和乘以二')).toBe('16')
    expect(canonical('三与五的和乘以二')).toBe('(((3)+(5))*(2))')
  })

  it.each([
    ['十与四的差', '6'],
    ['三与五的积', '15'],
    ['十与二的商', '5'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })
})

describe('就近绑定与三条扩大作用域的出口', () => {
  it('函数默认就近绑定', () => {
    expect(compute('根号四加五')).toBe('7')
  })

  it('出口一：显式括号', () => {
    expect(compute('根号（四加五）')).toBe('3')
  })

  it('出口二：名词形', () => {
    expect(compute('四与五的和的平方根')).toBe('3')
  })

  it('出口三：顺序词', () => {
    expect(compute('三加五再乘二')).toBe('16')
    expect(canonical('三加五再乘二')).toBe('(((3)+(5))*(2))')
  })
})

describe('裸「除」生成两个候选', () => {
  it('两种读法都给出，不替用户猜', () => {
    const candidates = candidatesOf('六除二')

    expect(candidates).toHaveLength(2)
    const values = candidates.map((c) => {
      const { value } = evaluate(c.expression)
      return value.kind === 'rational' ? value.fraction : (value as { decimal: string }).decimal
    })
    expect(values).toEqual(['3', '1/3'])
    expect(candidates.every((c) => c.reading.length > 0)).toBe(true)
  })
})

describe('阶乘、绝对值、倒数', () => {
  it.each([
    ['五的阶乘', '120'],
    ['五阶乘', '120'],
    ['负三的绝对值', '3'],
    ['四的倒数', '1/4'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })
})

/** 底线：宁可报错也不猜。这些必须解析失败，而不是算出一个数。 */
describe('无法理解时必须失败', () => {
  it.each([
    '这是一段话',
    '今天天气不错',
    '你好',
    '加加加',
    '三加',
  ])('拒绝 "%s"', (input) => {
    expect(understand(input).ok).toBe(false)
  })

  it('「的」后面接不认识的说法要报错', () => {
    const result = understand('三的什么')
    expect(result.ok).toBe(false)
  })
})

/** 不变量：文法产出的串重新解析后，结构必须与中文意图一致。 */
describe('全括号输出锁死解读', () => {
  it.each([
    '二的三次方的二次方',
    '三与五的和乘以二',
    '一加二乘三',
    '负二的平方',
  ])('%s 的输出可被引擎无歧义地重解', (input) => {
    const expression = canonical(input)
    const first = evaluate(expression)
    // 重新解析同一串，结果必须一致——括号足以锁死含义
    const second = evaluate(first.expression)
    expect(second.value).toEqual(first.value)
  })
})

/** 语音识别常把「负二」写成「-2」，ASCII 负号也要能解析。 */
describe('ASCII 负号（语音识别的常见输出）', () => {
  it.each([
    ['3.5乘以-2', '-7'],
    ['-2的平方', '4'],
    ['10加-3', '7'],
  ] as Array<[string, string]>)('%s → %s', (input, expected) => {
    expect(compute(input)).toBe(expected)
  })

  it('二元减法不受影响', () => {
    expect(compute('10-3')).toBe('7')
  })
})

/**
 * 对数的语义陷阱。
 * 引擎里 log 是自然对数，中文习惯里 log 是常用对数——差一个数量级。
 */
describe('对数：引擎语义与中文习惯不一致', () => {
  it('中文说 log 是常用对数', () => {
    expect(compute('log一百')).toBe('2')
    expect(compute('lg一百')).toBe('2')
    expect(compute('一百的常用对数')).toBe('2')
  })

  it('中文说 ln 才是自然对数', () => {
    expect(canonical('ln一百')).toBe('log((100))')
    expect(compute('e的自然对数')).toBe('1')
  })

  it('显示时按中文习惯改写，免得读者误解', async () => {
    const { calculate } = await import('./calculator')
    const common = await calculate('log一百')
    if (common.kind !== 'answer') throw new Error('应有答案')
    expect(common.answer.formula).toContain('lg(')

    const natural = await calculate('ln一百')
    if (natural.kind !== 'answer') throw new Error('应有答案')
    expect(natural.answer.formula).toContain('ln(')

    const based = await calculate('以二为底八的对数')
    if (based.kind !== 'answer') throw new Error('应有答案')
    expect(based.answer.formula).toContain('log₂(')
  })
})
