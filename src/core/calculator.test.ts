import { describe, expect, it } from 'vitest'
import { calculate, calculateExpression, calculateToolCall } from './calculator'
import { asFollowUp } from './steps'

async function answerOf(input: string): Promise<string> {
  const outcome = await calculate(input)
  if (outcome.kind !== 'answer') throw new Error(`期望得到答案，实际是 ${outcome.kind}`)
  return outcome.answer.text
}

describe('题目要求的核心行为', () => {
  it('一加一等于几 → 等于二', async () => {
    expect(await answerOf('一加一等于几')).toBe('等于二')
  })
})

describe('回答风格跟随输入', () => {
  it('中文数字提问用中文数字回答', async () => {
    expect(await answerOf('三加五')).toBe('等于八')
    expect(await answerOf('十二减五等于多少')).toBe('等于七')
  })

  it('阿拉伯数字提问用阿拉伯数字回答', async () => {
    expect(await answerOf('3+5')).toBe('等于 8')
    expect(await answerOf('100/4')).toBe('等于 25')
  })

  it('混合输入按中文回答', async () => {
    expect(await answerOf('3加五')).toBe('等于八')
  })
})

describe('算式回显', () => {
  it('每条回答都带规范算式', async () => {
    const outcome = await calculate('一加一等于几')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.formula).toBe('1+1 = 2')
  })

  it('回显用数学书写习惯的符号', async () => {
    const outcome = await calculate('根号九')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.formula).toContain('√')
  })
})

describe('大数与复数的可读回答', () => {
  it('超大数转科学计数法', async () => {
    expect(await answerOf('e的100次方')).toBe('约等于 2.68811714182 × 10⁴³')
  })

  it('复数直接给出 a+bi', async () => {
    expect(await answerOf('根号负四')).toBe('等于 2i')
  })

  it('分数给出精确形与近似值', async () => {
    expect(await answerOf('三分之一')).toBe('等于 1/3，约 0.333333')
  })
})

describe('歧义走候选卡，不替用户猜', () => {
  it('六除二给出两个带结果预览的选项', async () => {
    const outcome = await calculate('六除二')
    if (outcome.kind !== 'candidates') throw new Error('应给候选')

    expect(outcome.choices).toHaveLength(2)
    expect(outcome.choices.map((c) => c.preview)).toEqual(['三', '1/3，约 0.333333'])
    expect(outcome.choices.every((c) => c.reading.length > 0)).toBe(true)
  })

  it('用户点选后按选定读法作答', async () => {
    const outcome = await calculate('六除二')
    if (outcome.kind !== 'candidates') throw new Error('应给候选')

    // 规则给的候选一定带规范表达式（AI 候选才带工具调用）
    const expression = outcome.choices[1].expression
    expect(expression).toBeDefined()
    const picked = calculateExpression(expression as string, '六除二')
    if (picked.kind !== 'answer') throw new Error('应有答案')
    expect(picked.answer.text).toContain('1/3')
  })
})

describe('读不懂时明确失败', () => {
  it.each([
    '这是一段话',
    '今天天气不错',
    '一除以零',
  ])('"%s" 不会给出错误答案', async (input) => {
    const outcome = await calculate(input)
    expect(outcome.kind).toBe('failure')
  })

  it('除零给出可读原因', async () => {
    const outcome = await calculate('一除以零')
    if (outcome.kind !== 'failure') throw new Error('应失败')
    expect(outcome.reason).toContain('除数不能为零')
  })
})

describe('解方程（惰性加载 nerdamer）', () => {
  it('二次方程判别式小于零时给复根', async () => {
    const text = await answerOf('解方程x平方加一等于零')
    expect(text).toContain('i')
  }, 30000)

  it('一元一次方程', async () => {
    expect(await answerOf('解方程二乘x加三等于七')).toContain('x = 2')
  }, 30000)

  it('二次方程实根', async () => {
    const text = await answerOf('解方程x平方减四等于零')
    expect(text).toContain('2')
    expect(text).toContain('-2')
  }, 30000)

  it('无理根同时给精确形与近似值', async () => {
    const text = await answerOf('解方程x平方减二等于零')
    expect(text).toContain('√')
    expect(text).toContain('1.41')
  }, 30000)

  it('不带「解方程」也能按方程识别', async () => {
    expect(await answerOf('x加三等于十')).toContain('x = 7')
  }, 30000)
})

describe('求导与积分', () => {
  it('求导', async () => {
    expect(await answerOf('x平方求导')).toBe('2·x')
  }, 30000)

  it('积分带常数项', async () => {
    expect(await answerOf('二乘x求积分')).toContain('+ C')
  }, 30000)
})

/** 护栏：这两条守的是「永不静默猜」和「数学错误不当理解错误」两个不变量。 */
describe('不变量护栏', () => {
  it('多处歧义时明确拒绝，不静默选定其中一种读法', async () => {
    const outcome = await calculate('六除二除三')
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.cause).toBe('comprehension')
    expect(outcome.reason).toContain('除以')
  })

  it('数学错误标记为 math，不会被转交 AI 重新翻译', async () => {
    const outcome = await calculate('一除以零')
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.cause).toBe('math')
    expect(outcome.reason).toContain('除数不能为零')
  })

  it('读不懂标记为 comprehension，可以交给 AI', async () => {
    const outcome = await calculate('今天天气不错')
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.cause).toBe('comprehension')
  })
})

/**
 * 多步连续提问。这类句子的每一步都对，是步骤而非互斥候选——
 * 用「1+2×3等于几？再乘5等于几？再加3呢？」实测出来的场景。
 */
describe('多步连续提问', () => {
  it('三个步骤逐条作答，而不是让用户二选一', async () => {
    const outcome = await calculate('1+2*3等于几？后面如果再乘5等于几？后面如果再加3等于几？')
    expect(outcome.kind).toBe('steps')
    if (outcome.kind !== 'steps') return

    // 问句里有中文（「等于几」），回答也跟着用中文数字
    expect(outcome.steps).toHaveLength(3)
    expect(outcome.steps.map((s) => s.answer.text)).toEqual([
      '等于七',
      '等于三十五',
      '等于三十八',
    ])
  })

  it('中文说法同样成立', async () => {
    const outcome = await calculate('三加五等于几？再乘以二呢？')
    expect(outcome.kind).toBe('steps')
    if (outcome.kind !== 'steps') return

    expect(outcome.steps.map((s) => s.answer.text)).toEqual(['等于八', '等于十六'])
  })

  it('单个问句仍走普通回答', async () => {
    const outcome = await calculate('一加一等于几？')
    expect(outcome.kind).toBe('answer')
  })

  it('两个互不相干的问句不算多步', async () => {
    // 后一句不以运算词开头，各自独立，不该被串成一条链
    const outcome = await calculate('一加一等于几？三加五等于几？')
    expect(outcome.kind).not.toBe('steps')
  })
})

describe('算式回显是 LaTeX', () => {
  it('分数渲染成 \\frac', async () => {
    const outcome = await calculate('三分之一')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.tex).toContain('\\frac')
  })

  it('包含等号与结果', async () => {
    const outcome = await calculate('一加一等于几')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.tex).toMatch(/=\s*2/)
  })
})

/**
 * 跨轮追问。判定边界是「句子自己说不完整才承接」——
 * 这条规则决定了什么算继续、什么算新题。
 */
describe('跨轮追问', () => {
  it('「在这个基础上再乘以五」承接上一轮结果', async () => {
    const first = await calculate('一加一等于几')
    if (first.kind !== 'answer') throw new Error('应有答案')

    const second = await calculate('那在这个基础上再乘以五等于几', 'rule', first.answer.expression)
    if (second.kind !== 'answer') throw new Error('应有答案')
    expect(second.answer.text).toBe('等于十')
  })

  it.each([
    '再乘以五',
    '乘以五呢',
    '然后加三',
    '接着除以二',
    '的平方',
  ])('缺左操作数的「%s」承接上一轮', async (followUp) => {
    const outcome = await calculate(followUp, 'rule', '(4)')
    expect(outcome.kind).toBe('answer')
  })

  it.each([
    '三加五等于几',
    '一百除以四',
    '根号九',
  ])('句子完整的「%s」当作新题，不受上一轮影响', async (input) => {
    const withContext = await calculate(input, 'rule', '(999)')
    const without = await calculate(input)
    if (withContext.kind !== 'answer' || without.kind !== 'answer') throw new Error('应有答案')
    expect(withContext.answer.text).toBe(without.answer.text)
  })

  it('没有上一轮结果时，残缺句子照常报错而不是瞎猜', async () => {
    const outcome = await calculate('再乘以五')
    expect(outcome.kind).toBe('failure')
  })

  it('承接结果带完整算式回显，看得出拿哪个数接的', async () => {
    const outcome = await calculate('再乘以五', 'rule', '((1)+(1))')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.formula).toContain('1+1')
    expect(outcome.answer.formula).toContain('×5')
  })
})

/** 符号写法的方程：X²+2X+1=0 这种键盘/课本写法。 */
describe('符号写法的方程', () => {
  it.each([
    ['解方程 X²+2X+1=0', '-1'],
    ['解方程 x^2-4=0', '2'],
    ['x²+1=0', 'i'],
    ['解方程 2x+3=7', '2'],
  ] as Array<[string, string]>)('%s 的解含 %s', async (input, expected) => {
    const text = await answerOf(input)
    expect(text).toContain(expected)
  }, 30000)

  it('上标与隐式乘法都被正确理解', async () => {
    const outcome = await calculate('解方程 X²+2X+1=0')
    if (outcome.kind !== 'answer') throw new Error(`应有答案，实际 ${outcome.kind}`)
    expect(outcome.answer.formula).toContain('x')
  }, 30000)
})

/**
 * 上游的静默失败模式。
 * nerdamer 算不出来时不抛错，而是返回未求值的自身——不检测就会把
 * 「没算出来」伪装成「算出来了」端给用户。
 */
describe('上游静默失败必须被拦住', () => {
  it('算不出的积分明确报错，不会加个「+ C」冒充答案', async () => {
    // ∫cos(x²)dx 没有初等原函数，nerdamer 返回 "integrate(cos(x^2),x)"
    const outcome = await calculate('cos(x平方)求积分')
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.reason).toContain('算不出来')
    expect(outcome.reason).not.toContain('integrate')
  }, 30000)

  it('能算的积分照常给结果', async () => {
    expect(await answerOf('x平方求积分')).toContain('+ C')
  }, 30000)
})

/**
 * Codex 审阅发现的两个真实缺陷。
 * 第一条尤其严重——它会给出一个看起来理直气壮的错误答案。
 */
describe('Codex 审阅回归', () => {
  it('歧义读法里有一个算不出来时，不能把另一个当成唯一答案', async () => {
    // 曾经：「六除零」把算不出的 6÷0 静默丢掉，只把 0÷6=0 端出去，
    // 用户会以为「六除零等于零」
    const outcome = await calculate('六除零')
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.answer.text).toContain('另一种读法')
    expect(outcome.answer.text).toContain('除数不能为零')
  })

  it('两种读法都算得出来时照常出候选卡', async () => {
    const outcome = await calculate('六除二')
    expect(outcome.kind).toBe('candidates')
  })
})

/**
 * Codex 用实证跑出来的三个正确性缺陷。
 * 共同点：都会给出一个看起来理直气壮的错误答案，而不是报错。
 */
describe('Codex 实证发现的正确性缺陷', () => {
  it('极小的真实结果不被零值吸附抹掉', async () => {
    // 曾经：(1/e)^200 ≈ 1.38e-87 小于当时的吸附阈值 1e-50，被显示成 0。
    // 判据改成「换双倍精度重算，噪声会缩小、真值不会」之后才分得开。
    const outcome = await calculate('e的倒数的二百次方')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.formula).toContain('e-87')
    expect(outcome.answer.formula).not.toMatch(/=\s*0$/)
  })

  it('数值噪声仍然被清理掉', async () => {
    // 上一条的反面：这些必须还是 0，不能因为放宽判据就漏过去
    expect((await calculate('sin派')).kind).toBe('answer')
    const outcome = await calculate('sin派')
    if (outcome.kind !== 'answer') return
    expect(outcome.answer.text).toBe('等于零')
  })

  it('大数加虚部时虚部不被当噪声吞掉', async () => {
    // 曾经：噪声阈值是 1e-12×量级，10^20 的阈值成了 1e8，
    // 真实的虚部 1 被判为噪声，答案里 i 凭空消失
    const outcome = await calculate('10的20次方加i')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.formula).toContain('i')
  })

  it.each([
    ['x等于x的解'],
    ['x除以x等于一的解'],
    ['x加x等于2x的解'],
  ])('恒等式「%s」说明恒成立，而不是给个具体的解', async (input) => {
    // 曾经 x/x=1 回答 x=0 —— 而 0 恰恰是唯一不成立的点
    const outcome = await calculate(input)
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.reason).toContain('恒等式')
  }, 30000)
})

describe('求解路径的白名单校验', () => {
  it('未知函数被挡在求解引擎之外', async () => {
    // 曾经 diff(f(x)) 一路走到 nerdamer，它把 f 当变量、返回一个无意义的 "f"
    const { calculus } = await import('../engines/solverEngine')
    await expect(calculus('diff', 'f(x)', 'x')).rejects.toThrow(/不支持的函数/)
  }, 30000)

  it('求值引擎认识但求解引擎不认识的函数会明确报错', async () => {
    // gamma 在 mathjs 白名单里，nerdamer 却不认识，会退化成裸标识符
    const { calculus } = await import('../engines/solverEngine')
    await expect(calculus('diff', 'gamma(x)', 'x')).rejects.toThrow(/不认识/)
  }, 30000)

  it('正常的求导不受影响', async () => {
    const { calculus } = await import('../engines/solverEngine')
    await expect(calculus('diff', 'sin(x)', 'x')).resolves.toMatchObject({ text: 'cos(x)' })
  }, 30000)
})

describe('多步中断要如实说明', () => {
  it('中间某步算不出来时，明确指出停在哪一步', async () => {
    // 曾经静默丢弃失败的步骤，用户看到前几步以为全部完成了
    const outcome = await calculate('一加一？再乘以五？然后胡说')
    expect(outcome.kind).toBe('steps')
    if (outcome.kind !== 'steps') return

    expect(outcome.steps).toHaveLength(2)
    expect(outcome.stopped).toBeDefined()
    expect(outcome.stopped?.question).toContain('胡说')
  })

  it('某步有歧义时也要说明，而不是当它不存在', async () => {
    const outcome = await calculate('一加一？再除三')
    expect(outcome.kind).toBe('steps')
    if (outcome.kind !== 'steps') return
    expect(outcome.stopped?.reason).toContain('多种读法')
  })

  it('全部成功时没有中断说明', async () => {
    const outcome = await calculate('一加一？再乘以五？再加三')
    expect(outcome.kind).toBe('steps')
    if (outcome.kind !== 'steps') return
    expect(outcome.steps).toHaveLength(3)
    expect(outcome.stopped).toBeUndefined()
  })
})

/**
 * 跨轮上下文：只有单值求值能作为下一轮的起点。
 * 方程和微积分的 expression 是展示公式，接着算会拼出畸形串。
 */
describe('续算上下文的边界', () => {
  it('求值结果可续算', async () => {
    const first = await calculate('一加一')
    if (first.kind !== 'answer') throw new Error('应有答案')
    expect(first.answer.continuable).toBe(true)

    const second = await calculate('再乘以五', 'rule', first.answer.expression)
    if (second.kind !== 'answer') throw new Error('应有答案')
    expect(second.answer.text).toBe('等于十')
  })

  it.each([
    ['解方程x平方减二等于零'],
    ['x平方求导'],
    ['x平方求积分'],
  ])('「%s」的结果不可续算', async (input) => {
    // 曾经解方程后追问「再乘以五」会拼成 x^2-2 = 0×5，还煞有介事地给了答案
    const outcome = await calculate(input)
    if (outcome.kind !== 'answer') throw new Error(`应有答案，实际 ${outcome.kind}`)
    expect(outcome.answer.continuable).toBe(false)
  }, 30000)

  it('接不上时说明原因，而不是拼出畸形表达式', async () => {
    const outcome = await calculate('再乘以五', 'rule', null)
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.reason).toContain('接不上')
  })
})

/**
 * 用户在 AI 候选卡里点了某一种读法之后走的那条路。
 *
 * 求值候选与规则候选本来就是同一件事，所以它委托给 calculateExpression——
 * 一条路只求值一次，回答的拼装也只有一份。曾经这里另起一套：
 * runToolCall 里算一次、外面再 evaluate() 一次，同一个表达式跑两遍。
 */
describe('AI 候选点选后的求值', () => {
  it('算式回显带「= 结果」，UI 优先渲染 tex 时不会只剩半个式子', async () => {
    const outcome = await calculateToolCall({ tool: 'evaluate', expression: '1+1' }, '1+1')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.tex).toMatch(/=\s*2/)
    expect(outcome.answer.formula).toBe('1+1 = 2')
  })

  it('与规则候选点选后的结果逐字一致——同一件事只能有一种算法', async () => {
    const viaTool = await calculateToolCall({ tool: 'evaluate', expression: '(6)/(2)' }, '六除二')
    const viaRule = calculateExpression('(6)/(2)', '六除二', 'llm')
    expect(viaTool).toEqual(viaRule)
  })

  it('回答风格仍然跟随用户原话', async () => {
    const outcome = await calculateToolCall({ tool: 'evaluate', expression: '1+1' }, '一加一')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.text).toBe('等于二')
    expect(outcome.answer.source).toBe('llm')
    // 求值结果是一个数，下一轮「再乘以五」接得上
    expect(outcome.answer.continuable).toBe(true)
  })

  it('白名单照旧挡住越权表达式', async () => {
    // 模型被诱导也执行不了别的东西：求值前一定过一遍规范子集校验
    const outcome = await calculateToolCall({ tool: 'evaluate', expression: 'x+1' }, 'x加一')
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') return
    expect(outcome.reason).toContain('不支持的符号')
  })

  it('解方程候选仍走工具执行器，结果不可续算', async () => {
    const outcome = await calculateToolCall({ tool: 'solve', equation: 'x-2', variable: 'x' }, '解方程')
    if (outcome.kind !== 'answer') throw new Error('应有答案')
    expect(outcome.answer.text).toContain('x = 2')
    expect(outcome.answer.tex).toContain('= 0')
    // 方程给的是一组解，不是一个数——接不上「再乘以五」
    expect(outcome.answer.continuable).toBe(false)
  }, 30000)
})

/**
 * llm-first 下追问要先走规则。
 *
 * App 用 `asFollowUp(text) !== null && 有上下文` 作为「跳过 LLM」的判据，
 * 动机是实测「一加一」→「再乘以五」被模型翻成方程 x×5=0，而不是接着上一步算。
 * 判据本身在这里钉住：句子自己说不完整才算追问。
 */
describe('追问判据（llm-first 的绕行开关）', () => {
  it.each([
    '再乘以五',
    '那在这个基础上再乘以五等于几',
    '然后加三',
    '接着除以二',
    '的平方',
  ])('「%s」缺左操作数，是追问', (input) => {
    expect(asFollowUp(input)).not.toBeNull()
  })

  it.each([
    '一加一等于几',
    '三与五的和乘以二',
    '解方程x平方加一等于零',
    '今天天气不错',
  ])('「%s」句子完整，不是追问——该交给模型的仍然交给模型', (input) => {
    expect(asFollowUp(input)).toBeNull()
  })

  it('判定只看句式，不看有没有上下文——上下文由调用方另行把关', () => {
    // App 里两个条件是与关系：没有上一轮结果时，「再乘以五」照样走模型，
    // 模型也翻不出来才退回规则，由规则给出「接不上」的说明
    expect(asFollowUp('再乘以五')).not.toBeNull()
  })

  it('有上下文时规则接得上，答案就是接着上一步算的', async () => {
    const first = await calculate('一加一')
    if (first.kind !== 'answer') throw new Error('应有答案')

    const second = await calculate('再乘以五', 'rule', first.answer.expression)
    if (second.kind !== 'answer') throw new Error('应有答案')
    // 模型曾把这句读成方程 x×5=0；规则读出的是 (1+1)×5
    expect(second.answer.text).toBe('等于十')
    expect(second.answer.formula).toContain('×5')
  })
})
