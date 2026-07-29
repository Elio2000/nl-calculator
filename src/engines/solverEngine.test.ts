/**
 * 求解引擎的正确性护栏。
 *
 * 这一层的失败模式和求值层不同：nerdamer 算不对时**不抛错**，
 * 而是端出一个格式漂亮、看起来像模像样的错误答案。所以这里的断言
 * 大多不是「能不能算」，而是「算错的时候有没有被拦下来」。
 *
 * nerdamer 是惰性加载的 3MB 包，首次调用要几秒，故每条都放宽超时。
 */
import { describe, expect, it } from 'vitest'
import { calculus, solveEquation } from './solverEngine'

const TIMEOUT = 30000

describe('解集是区间时要说清楚算不全', () => {
  it.each([
    ['绝对值', 'abs(x)', 'x'],
    ['偶次根', 'sqrt(x^2)', 'x'],
    ['偶数次 nthRoot', 'nthRoot(x^2,2)', 'x'],
  ] as Array<[string, string, string]>)('%s 方程附上「可能不完整」的注记', async (_case, left, right) => {
    // |x| = x 与 √(x²) = x 的实数解都是 x ≥ 0 一整段，
    // 求解器只找得到 x = 0。不说明的话，用户会以为 0 就是全部答案。
    const { text } = await solveEquation(left, right, 'x')
    expect(text).toContain('区间')
    expect(text).toContain('可能不完整')
  }, TIMEOUT)

  it.each([
    ['二次方程', 'x^2-2', '0'],
    ['奇数次根不产生区间', 'nthRoot(x^3,3)', '2'],
  ] as Array<[string, string, string]>)('%s 不挂这句注记', async (_case, left, right) => {
    // 给每个方程都加一句「可能不完整」，等于这句话什么也没说
    const { text } = await solveEquation(left, right, 'x')
    expect(text).not.toContain('可能不完整')
  }, TIMEOUT)
})

describe('对数的语义要和求值引擎对齐', () => {
  it('log10 求导给出符号形而不是有理近似', async () => {
    // nerdamer 自己的 log10 求导得到 (108796589/250513404)·x⁻¹ ——
    // 那是 1/ln10 的一个丑陋有理近似，既不精确也没法读
    const { text } = await calculus('diff', 'log10(x)', 'x')
    expect(text).toContain('log(10)')
    expect(text).not.toContain('108796589')
  }, TIMEOUT)

  it('双参 log(x,2) 是换底，导数不能丢掉 1/ln2', async () => {
    // nerdamer 不认双参 log，直接把底数丢了，导数成了 1/x —— 数值上错了 44%
    const { text } = await calculus('diff', 'log(x,2)', 'x')
    expect(text).toContain('log(2)')
  }, TIMEOUT)

  it('log2 同样能求导', async () => {
    const { text } = await calculus('diff', 'log2(x)', 'x')
    expect(text).toContain('log(2)')
  }, TIMEOUT)

  it('自然对数不受影响', async () => {
    const { text } = await calculus('diff', 'log(x)', 'x')
    expect(text).toBe('x^(-1)')
  }, TIMEOUT)
})

describe('裸标识符不再被一票否决', () => {
  it('对 x 求导得到 y 是正确答案', async () => {
    // 曾经的判据是「结果是裸标识符 → 引擎没认出函数」，
    // 于是 d(x·y)/dx = y 这道完全算对的题被报成「不认识这个函数」
    await expect(calculus('diff', 'x*y', 'x')).resolves.toMatchObject({ text: 'y' })
  }, TIMEOUT)
})

describe('求解引擎不认识的函数要挡在门外', () => {
  it.each([
    ['diff', 'gamma(x)'],
    ['integrate', 'gamma(x)'],
  ] as Array<['diff' | 'integrate', string]>)('%s(%s) 明确报错', async (kind, expression) => {
    // nerdamer 把 gamma 当成变量：∫gamma(x)dx 曾经端出 gamma·x²/2，
    // 一个格式完美的错误答案。diff 那条侥幸被「裸标识符」判据挡住，
    // integrate 的结果里带着 x，事后怎么看都看不出它没算
    await expect(calculus(kind, expression, 'x')).rejects.toThrow(/不认识/)
  }, TIMEOUT)

  it('未知函数同样进不来', async () => {
    await expect(calculus('diff', 'f(x)', 'x')).rejects.toThrow(/不支持的函数/)
  }, TIMEOUT)

  it('认识的函数不受影响', async () => {
    await expect(calculus('diff', 'sin(x)', 'x')).resolves.toMatchObject({ text: 'cos(x)' })
    await expect(calculus('integrate', 'x^2', 'x')).resolves.toMatchObject({ text: '(1/3)·x^3 + C' })
  }, TIMEOUT)
})

describe('数值根用约等号', () => {
  it('牛顿法解出的小数根写成 x ≈ …', async () => {
    // cos(x)=x 的根 0.7390851332 是截断到 10 位的近似值，用等号是在撒谎
    const { text } = await solveEquation('cos(x)', 'x', 'x')
    expect(text).toContain('x ≈ 0.739')
  }, TIMEOUT)

  it('精确根保持等号', async () => {
    expect((await solveEquation('2*x+3', '7', 'x')).text).toContain('x = 2')
  }, TIMEOUT)

  it('精确形加近似值的写法不变', async () => {
    // 「x = √(2) ≈ 1.414…」里的等号连的是精确形，本来就没撒谎
    expect((await solveEquation('x^2-2', '0', 'x')).text).toContain('x = √(2) ≈ 1.41')
  }, TIMEOUT)
})

describe('代回验证与复数根排序', () => {
  it('代回不成立的根被剔除，并说明剔除过', async () => {
    // nerdamer 给 x³=2 的三个根里有一个代回残差是 -4
    const { text } = await solveEquation('x^3-2', '0', 'x')
    expect(text).toContain('2^(1/3)')
    expect(text).toContain('已剔除')
  }, TIMEOUT)

  it('正确的复数根不因残差算不成数值而被误剔除', async () => {
    // -1+100i 代回后 nerdamer 只化简了一半，留下半符号串，
    // 解析不出数值就被当成「代回不成立」——一个正确的根被丢掉，
    // 还多出一句「已剔除」的假话。先 expand 一道就收成 0
    const { text } = await solveEquation(
      '(x-1)*(x-2)*(x-3)*(x^2+2*x+10001)',
      '0',
      'x',
    )
    expect(text).not.toContain('已剔除')
  }, TIMEOUT)

  it('按复数模长排序，不按实部', async () => {
    // 用 parseFloat 排序的话 "-1+100i" 只被读成 -1，
    // 一个距离原点 100 的根会排到最前面，把实根 3 挤出展示名额
    const { items } = await solveEquation(
      '(x-1)*(x-2)*(x-3)*(x^2+2*x+10001)',
      '0',
      'x',
    )
    expect(items.map((item) => item.exact).slice(0, 3)).toEqual(['1', '2', '3'])
  }, TIMEOUT)
})

describe('恒等式不当成方程作答', () => {
  it.each([['x', 'x'], ['x/x', '1']] as Array<[string, string]>)(
    '%s = %s 说明恒成立',
    async (left, right) => {
      // x/x=1 曾经答 x=0 —— 而 0 恰恰是唯一不成立的点
      await expect(solveEquation(left, right, 'x')).rejects.toThrow(/恒等式/)
    },
    TIMEOUT,
  )
})
