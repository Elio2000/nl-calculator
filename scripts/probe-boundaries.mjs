/**
 * 能力边界实测。
 *
 * 逐条跑边界用例，看**实际**能算什么、算到哪里失效——
 * 第一手结果比读文档可靠，而且这份输出直接就是 BOUNDARIES.md 的依据。
 *
 *   node scripts/probe-boundaries.mjs
 */
import { registerHooks } from 'node:module'

// 与 eval-llm.mjs 同一对 hook：src 的相对 import 不带扩展名、lexicon.json
// 需要 import attributes，node 的 ESM 解析器都不认，注册后才能加载源码。
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context)
      } catch {
        // 加 .ts 也找不到，就交回默认解析，让它报本来该报的错
      }
    }
    const resolved = next(specifier, context)
    return resolved.url.endsWith('.json')
      ? { ...resolved, importAttributes: { type: 'json' } }
      : resolved
  },
})

const { calculate } = await import('../src/core/calculator.ts')

/** 每组是一个能力维度，用例按「越往后越极端」排列，好看出在哪一档失效。 */
const GROUPS = [
  ['基础四则与精度', [
    ['1+1', '整数'],
    ['0.1+0.2', '浮点经典问题'],
    ['1/3', '无限循环小数'],
    ['1/3+1/6', '分数相加'],
    ['0.1+0.2-0.3', '精度累积'],
  ]],
  ['大数', [
    ['20的阶乘', '19 位整数'],
    ['30的阶乘', '33 位整数'],
    ['100的阶乘', '158 位整数'],
    ['2的1000次方', '302 位整数'],
    ['2的100000次方', '3 万位整数'],
  ]],
  ['小数精度', [
    ['1除以7', '循环小数'],
    ['pi', '无理数常量'],
    ['根号2', '无理数'],
    ['1除以3乘以3', '除后乘回，看是否精确'],
  ]],
  ['幂与根', [
    ['2的10次方', '整数幂'],
    ['2的0.5次方', '分数幂'],
    ['负8的三次方根', '负数奇次根'],
    ['根号负4', '负数平方根（复数）'],
    ['0的0次方', '未定义边界'],
  ]],
  ['三角与对数', [
    ['sin30度', '角度制'],
    ['cos派', '弧度制'],
    ['sin派', '应为 0（数值噪声）'],
    ['以2为底1024的对数', '任意底对数'],
    ['ln0', '定义域边界'],
    ['arcsin2', '定义域外（复数）'],
  ]],
  ['复数', [
    ['i乘以i', 'i² = -1'],
    ['根号负4加2', '复数加实数'],
    ['(1+i)的2次方', '复数幂'],
    ['ln负1', '负数对数'],
  ]],
  ['方程（按次数）', [
    ['解方程2x+3=7', '一次'],
    ['解方程x平方减4=0', '二次实根'],
    ['解方程x平方加1=0', '二次复根'],
    ['解方程x的3次方减1=0', '三次'],
    ['解方程x的4次方减16=0', '四次'],
    ['解方程x的5次方减32=0', '五次（无闭式解）'],
  ]],
  ['超越方程', [
    ['解方程2的x次方=8', '指数方程'],
    ['解方程lnx=1', '对数方程'],
    ['解方程sinx=0', '三角方程'],
    ['解方程cosx=x', '无闭式解，需数值'],
  ]],
  ['微积分', [
    ['x平方求导', '多项式求导'],
    ['sinx求导', '三角求导'],
    ['x平方求积分', '多项式积分'],
    ['sinx求积分', '三角积分'],
    ['e的x次方求积分', '指数积分'],
    ['lnx求积分', '对数积分（分部）'],
  ]],
  // 以下三组的失败原因性质完全不同，必须分开看
  ['A类：计算层做不到（硬边界）', [
    ['解方程y的导数等于y', '符号微分方程——JS 生态确实没有'],
  ]],
  ['B类：计算层能做，我们的翻译层没接', [
    ['1米加2厘米', 'mathjs 自带完整单位系统'],
    ['矩阵1,2;3,4的行列式', 'mathjs 有 det/inv/eigs'],
    ['求x趋近0时sinx除以x的极限', 'nerdamer 有 limit()'],
    ['x平方求二阶导', 'nerdamer 的 diff 支持阶数参数'],
    ['解方程组x加y=3且x减y=1', 'nerdamer 有 solveEquations()'],
  ]],
  ['C类：翻译层的主动取舍', [
    ['六除二除三', '多个裸「除」候选会爆炸，明确拒绝'],
    ['一与二的和与三的和', '名词形只支持简单操作数'],
    ['解方程x加y=3', '多未知数：能解，但会说明是用另一个表示'],
  ]],
]

const label = (r) => {
  if (r.kind === 'answer') {
    // 方程与微积分的 formula 是「算式 = 0」这种形式，答案在 text 里，
    // 不能统一从 formula 取右半边
    const value = r.answer.text.replace(/^等于\s*/, '').replace(/^约等于\s*/, '≈')
    return `✓ ${value.length > 46 ? value.slice(0, 44) + '…' : value}`
  }
  if (r.kind === 'candidates') return `? 出候选卡（${r.choices.length} 种读法）`
  if (r.kind === 'steps') return `✓ 多步：${r.steps.map((s) => s.answer.text).join(' → ')}`
  return `✗ ${r.reason}`
}

for (const [group, cases] of GROUPS) {
  console.log(`\n━━━ ${group} ━━━`)
  for (const [input, note] of cases) {
    let line
    try {
      line = label(await calculate(input))
    } catch (error) {
      line = `✗ 抛异常：${error.message.slice(0, 50)}`
    }
    console.log(`  ${input.padEnd(26)} ${line.padEnd(50)} ${note}`)
  }
}
