import { describe, expect, it } from 'vitest'
import { evaluate, validate, ExpressionError, MathError } from './mathEngine'

const decimalOf = (expression: string) => {
  const { value } = evaluate(expression)
  if (value.kind === 'complex') return value.text
  return value.kind === 'rational' ? value.fraction : value.decimal
}

/** 取结果的数值近似，复数取实部。 */
const approxOf = (expression: string) => {
  const { value } = evaluate(expression)
  return value.kind === 'complex' ? value.approxRe : value.approx
}

describe('精度', () => {
  it('浮点经典问题得到精确结果', () => {
    expect(decimalOf('0.1+0.2')).toBe('3/10')
    expect(approxOf('0.1+0.2')).toBe(0.3)
  })

  it('纯有理数表达式保持分数形', () => {
    expect(decimalOf('1/3')).toBe('1/3')
    expect(decimalOf('2+1/2')).toBe('5/2')
    expect(decimalOf('6/2')).toBe('3')
  })

  it('含超越函数时切换到高精度浮点', () => {
    expect(decimalOf('sin(30*pi/180)')).toBe('0.5')
    expect(decimalOf('log(8,2)')).toBe('3')
  })
})

describe('运算优先级与结合性', () => {
  it('乘除优先于加减', () => {
    expect(decimalOf('1+2*3')).toBe('7')
  })

  it('幂运算右结合', () => {
    expect(decimalOf('2^3^2')).toBe('512')
  })

  it('幂运算优先于一元负号', () => {
    expect(decimalOf('-2^2')).toBe('-4')
    expect(decimalOf('(-2)^2')).toBe('4')
  })
})

describe('数值噪声修约', () => {
  it('cos(pi)+sin(pi) 干净地得到 -1', () => {
    expect(decimalOf('cos(pi)+sin(pi)')).toBe('-1')
  })

  it('sin(pi) 吸附为 0', () => {
    expect(decimalOf('sin(pi)')).toBe('0')
  })

  it('纯算术表达式不做零值吸附', () => {
    expect(approxOf('1/10000000000000000000000')).toBeGreaterThan(0)
  })
})

describe('复数', () => {
  it('负数开方提升为复数', () => {
    expect(decimalOf('sqrt(-4)')).toBe('2i')
  })

  it('复数四则运算', () => {
    expect(decimalOf('sqrt(-4)+2')).toBe('2 + 2i')
    expect(decimalOf('i*i')).toBe('-1')
  })

  it('虚部为噪声时降回实数', () => {
    expect(evaluate('(1+i)^2-2i').value.kind).toBe('real')
  })
})

describe('大数与科学计数', () => {
  it('e 的 100 次幂', () => {
    expect(decimalOf('e^100')).toBe('2.68811714182e+43')
  })

  it('阶乘', () => {
    expect(decimalOf('factorial(20)')).toBe('2432902008176640000')
  })
})

describe('错误处理', () => {
  it('除零给出可读信息', () => {
    expect(() => evaluate('1/0')).toThrow(MathError)
    expect(() => evaluate('1/0')).toThrow(/除数不能为零/)
  })

  it('负数阶乘被拒绝', () => {
    expect(() => evaluate('factorial(-1)')).toThrow(/非负整数/)
  })
})

describe('白名单边界', () => {
  it('拒绝赋值', () => {
    expect(() => validate('a=5')).toThrow(ExpressionError)
  })

  it('拒绝函数定义', () => {
    expect(() => validate('f(x)=x^2')).toThrow(ExpressionError)
  })

  it('拒绝未知函数', () => {
    expect(() => validate('foo(2)')).toThrow(/不支持的函数/)
  })

  it('拒绝未知符号', () => {
    expect(() => validate('x+1')).toThrow(/不支持的符号/)
  })

  it('拒绝数组与索引', () => {
    expect(() => validate('[1,2,3]')).toThrow(ExpressionError)
  })

  it('拒绝语句块', () => {
    expect(() => validate('1;2')).toThrow(ExpressionError)
  })

  it('放行白名单内的函数与常量', () => {
    expect(() => validate('sin(pi)+nthRoot(27,3)+log10(100)')).not.toThrow()
  })
})

/**
 * Codex 审阅发现的一批正确性缺陷。
 * 前两条会直接产出错误答案，后一条是「用等号展示近似值」的诚实性问题。
 */
describe('Codex 审阅回归', () => {
  it('整数指数的判断要认得 BigNumber', () => {
    // 曾经用 Number.isInteger(constantNode.value)，但 BigNumber 模式下
    // value 是个对象，恒为 false，于是所有幂运算都被排除出精确分数路径
    expect(decimalOf('(1/3)^2')).toBe('1/9')
    expect(decimalOf('(1/2)^3')).toBe('1/8')
  })

  it('非整数指数不能被分到精确分数路径', () => {
    // 曾经负指数分支只检查「是不是常量」，10^-400.5 走 Fraction 后整个下溢成 0。
    // 注意断言 decimal 而不是 approx——approx 是 JS number，
    // 而 3.16e-401 小于 Number.MIN_VALUE(5e-324)，转过去必然是 0。
    expect(decimalOf('10^(-400.5)')).toContain('e-401')
  })

  it('精确整数不被有效数字修约', () => {
    // 30! = 265252859812191058636308480000000，曾被修约成 2.65e+32
    expect(decimalOf('factorial(30)')).toBe('265252859812191058636308480000000')
  })

  describe('精确与近似必须区分', () => {
    it.each([
      ['1+1', true],
      ['1/3', true],
      ['factorial(30)', true],
      ['cos(pi)', true],
      ['sin(30*pi/180)', true],
    ] as Array<[string, boolean]>)('%s 是精确值', (expression) => {
      expect(evaluate(expression).value.exact).toBe(true)
    })

    it.each([
      ['sqrt(2)'],
      ['2^0.5'],
      ['factorial(100)'],
    ])('%s 是近似值', (expression) => {
      expect(evaluate(expression).value.exact).toBe(false)
    })
  })
})

/** 计算量预算：白名单管「能不能算」，这里管「算多久」。 */
describe('计算量预算', () => {
  it.each([
    ['一亿的阶乘', 'factorial(100000000)'],
    ['指数塔', '9^(9^9)'],
    ['巨大指数', '2^(10^10)'],
    ['阶乘后缀写法', '100000!'],
  ])('挡住 %s', (_case, expression) => {
    // 这些都是合法表达式，但会在 UI 主线程上算到浏览器卡死
    expect(() => validate(expression)).toThrow(ExpressionError)
  })

  it.each([
    ['factorial(20)'],
    ['factorial(1000)'],
    ['2^100000'],
    ['2^(5*2)'],
    ['sqrt(2)^2'],
  ])('不误伤 %s', (expression) => {
    expect(() => validate(expression)).not.toThrow()
  })

  it('指数是表达式时也能估出大小', () => {
    // 光看字面量不够——9^(9^9) 的指数是个表达式，要算一遍才知道有多大
    expect(() => validate('9^(9^9)')).toThrow(/指数.*太大/)
  })
})

describe('数值噪声判据不看绝对大小', () => {
  it('被放大的噪声也能识别', () => {
    // 曾经先用「结果 < 1e-10」筛一道再复核，于是 sin(pi)*10^100
    // 的噪声被放大到 3e36、压根不触发复核，答成了三万亿亿亿亿
    expect(decimalOf('sin(pi)*10^100')).toBe('0')
    expect(decimalOf('sin(pi)*10^40')).toBe('0')
  })

  it('极小的真值不被误杀', () => {
    expect(decimalOf('(1/e)^200')).toContain('e-87')
  })
})

/**
 * 零值吸附的反向洞：「换精度后缩小了」不等于「是噪声」。
 * 真实的极小量在低精度下会被自身的舍入误差淹没，提高精度时同样会「缩小」——
 * 只看一次复核分不开这两者，会把真实的答案抹成 0。
 */
describe('零值吸附要看收敛而不只看缩小', () => {
  it('被噪声淹没的极小真值收敛后如实给出', () => {
    // sin(pi+1e-100) 的真值约 -1e-100：
    //   64 位算出 3.1e-64（全是 pi 的舍入误差）
    //   128 位算出 -1.0e-100，比 64 位小了 1e-36 倍 → 单看这一步像噪声
    //   256 位仍是 -1.0e-100，和 128 位一致 → 收敛了，这是真实的数
    // 两种写法都要，`1e-100` 是科学计数字面量、`10^(-100)` 是幂运算，走的解析路径不同
    for (const expression of ['sin(pi+1e-100)', 'sin(pi+10^(-100))']) {
      const { value } = evaluate(expression)
      expect(value.kind).toBe('real')
      if (value.kind !== 'real') return
      expect(value.decimal.startsWith('-1')).toBe(true)
      expect(value.decimal).toContain('e-100')
      // 收敛值仍是修约过的近似值，不能标成精确
      expect(value.exact).toBe(false)
    }
  })

  it.each([
    ['sin(pi)*10^100', '0'],
    ['sin(pi)', '0'],
    ['cos(pi)+sin(pi)', '-1'],
    ['tan(pi)', '0'],
  ] as Array<[string, string]>)('%s 仍然吸附成 %s', (expression, expected) => {
    // 真噪声在 128→256 之间会**继续**按同样量级缩小，和上面那条分得开
    expect(decimalOf(expression)).toBe(expected)
    expect(evaluate(expression).value.exact).toBe(true)
  })

  it('极小的真值仍然不被误杀', () => {
    // 这一条 64/128 位算出来一模一样，压根不触发第三次复核
    expect(decimalOf('(1/e)^200')).toContain('e-87')
    expect(evaluate('(1/e)^200').value.exact).toBe(false)
  })
})

/**
 * 复数分量的噪声判据。
 * mathjs 的复数运算固定走 double（提高 precision 对它毫无影响），
 * 所以实数那套「换高精度重算」用不了，判据是「和本通道自身量级比」。
 */
describe('复数分量的噪声判据', () => {
  it('真实的极小虚部必须保留', () => {
    // 曾经用固定的 1e-12 吸附，1+i/10^13 的虚部被整个删掉，答案缩水成 1
    const { value } = evaluate('1+i/10^13')
    expect(value.kind).toBe('complex')
    if (value.kind !== 'complex') return
    expect(value.text).toContain('1e-13')
    expect(value.approxIm).toBeGreaterThan(0)
  })

  it('大数旁边的虚部不被量级压掉', () => {
    // 虚部 1 相对模长 1e20 小得离谱，但虚通道上根本没出现过大数
    expect(decimalOf('10^20+i')).toContain('i')
  })

  it.each([
    ['sqrt(-4)', '2i'],
    ['(2+3i)*(2-3i)', '13'],
    ['e^(i*pi)', '-1'],
    ['i*i', '-1'],
    ['(1+i)^2', '2i'],
    ['sqrt(-4)+2', '2 + 2i'],
  ] as Array<[string, string]>)('%s 的噪声分量仍被清掉：%s', (expression, expected) => {
    expect(decimalOf(expression)).toBe(expected)
  })
})

describe('整数结果不被 double 修约', () => {
  it('精确整数给出完整数字串', () => {
    // 10^30+1 走的是精确分数通道，小数形曾经取自 JS double 的 1e30——
    // 那个 +1 无声无息地消失了
    const { value } = evaluate('10^30+1')
    expect(value.kind).toBe('rational')
    if (value.kind !== 'rational') return
    expect(value.decimal).toBe('1000000000000000000000000000001')
    expect(value.fraction).toBe('1000000000000000000000000000001')
  })

  it('30! 的 33 位精确整数原样给出', () => {
    const { value } = evaluate('factorial(30)')
    expect(value.kind).toBe('real')
    if (value.kind !== 'real') return
    expect(value.decimal).toBe('265252859812191058636308480000000')
    expect(value.exact).toBe(true)
  })

  it('超过展示上限才转科学计数并标成近似', () => {
    // 100! 有 158 位，全列出来对读者没有价值
    const { value } = evaluate('factorial(100)')
    expect(value.kind).toBe('real')
    if (value.kind !== 'real') return
    expect(value.decimal).toContain('e+157')
    expect(value.exact).toBe(false)
  })
})
