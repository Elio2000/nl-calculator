/**
 * LLM 归一化效果评测。
 *
 * 衡量的是「模型提议的读法有没有用」，不是「模型算得对不对」——它根本不算。
 * 每个候选都会过白名单校验并在本地真跑一遍，这里只对比跑出来的结果。
 *
 *   node scripts/eval-llm.mjs                                        # 默认 DeepSeek + deepseek-v4-flash
 *   node scripts/eval-llm.mjs --model deepseek-v4-pro
 *   node scripts/eval-llm.mjs --base-url http://localhost:11434/v1 --model qwen2.5:1.5b
 *   node scripts/eval-llm.mjs qwen2.5:7b --base-url http://localhost:11434/v1
 *
 * key 只来自运行环境（环境变量 DEEPSEEK_API_KEY，或项目根目录的 .deepseek.key），
 * 脚本里不写死，也不打印。本机 Ollama 不需要 key。
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * 让 node 直接跑 src 里的 TypeScript 源码，不额外引入一套构建。
 *
 * 两处差异要补：src 内部的相对 import 不写扩展名（按 vite 的解析规则写的），
 * node 的 ESM 解析器不认；`lexicon.json` 还需要 import attributes。
 * 一对同步 hook 解决，评测脚本就能跟应用跑同一份代码——这正是它的意义所在。
 */
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

// hook 注册之后才能加载源码，所以这里是动态 import
const { translate, NotMathError } = await import('../src/services/llm.ts')
const { calculate } = await import('../src/core/calculator.ts')

const args = process.argv.slice(2)

function flag(name, fallback) {
  const at = args.indexOf(`--${name}`)
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback
}

// 兼容老用法：第一个不以 -- 开头的位置参数当模型名
const positional = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'))

const baseUrl = flag('base-url', 'https://api.deepseek.com/v1')
const model = flag('model', positional ?? 'deepseek-v4-flash')

if (baseUrl.startsWith('/')) {
  // 页面里的默认值是相对路径（走同源转发代理），Node 的 fetch 认不了
  console.error(`--base-url 需要绝对地址，${baseUrl} 是给浏览器用的同源路径`)
  process.exit(1)
}

function readApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    return readFileSync(fileURLToPath(new URL('../.deepseek.key', import.meta.url)), 'utf8').trim()
  } catch {
    return ''
  }
}

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl)
// 本地服务不需要凭据，也就不该把 key 递过去——凭据只发给它本来的归属方
const apiKey = isLocal ? '' : readApiKey()
if (!apiKey && !isLocal) {
  console.error('没有 API key：设环境变量 DEEPSEEK_API_KEY，或把 key 写进项目根目录的 .deepseek.key')
  process.exit(1)
}

const settings = {
  voiceModel: 'turbo',
  strategy: 'rule-first',
  llmProvider: 'endpoint',
  baseUrl,
  apiKey,
  chatModel: model,
}

/**
 * 14 条用例，覆盖 LLM 在这个架构里要担的全部职责：
 *   基础对照 —— 规则也能读懂的句子，模型不该读岔
 *   语音误识 —— turbo 实测会把「根号九」听成「根号酒」
 *   口语绕弯 —— 规则词表覆盖不到的说法
 *   真歧义　 —— 该给两个候选，而不是替用户拍板
 *   符号计算 —— 解方程 / 求导 / 积分
 *   拒答　　 —— 不是数学问题时必须说不知道，不能硬凑算式
 *
 * 判据写成字符串（preview 精确相等）或正则（匹配「算式 → 结果」整行）。
 * 全部可判定，所以「过了几条」是算出来的，不是看出来的。
 */
const CASES = [
  { input: '一加一等于几', note: '基础对照', kind: 'value', want: '2' },
  { input: '二加二乘二等于几呀', note: '优先级对照', kind: 'value', want: '6' },
  { input: 'e的100次幂是多少', note: '大数 / 科学计数', kind: 'value', want: /2\.688/ },
  { input: '根号酒是多少', note: '语音同音字（酒→九）', kind: 'value', want: '3' },
  { input: '三个苹果加五个梨一共几个', note: '口语绕弯', kind: 'value', want: '8' },
  { input: '一百块打七折再减二十', note: '生活场景', kind: 'value', want: '50' },
  { input: '把十二平分成四份每份多少', note: '口语除法', kind: 'value', want: '3' },
  { input: '五的立方再开平方', note: '嵌套运算（括号规范性）', kind: 'value', want: /11\.18/ },
  { input: '六除二', note: '真歧义：该给两个读法', kind: 'ambiguous', want: ['3', /0\.3333|1\/3/] },
  { input: '解方程x平方加一等于零', note: '解方程（复数根）', kind: 'value', want: /i/ },
  { input: 'x平方求导', note: '求导', kind: 'value', want: /2\s*[*·×]?\s*x/ },
  { input: '二x的积分', note: '积分', kind: 'value', want: /x\s*\^?\s*2|x²/ },
  { input: '今天天气怎么样', note: '非数学输入：必须拒答', kind: 'reject' },
  { input: '帮我写一首诗', note: '非数学输入：必须拒答', kind: 'reject' },
]

/** 一个候选是否命中判据。正则匹配「算式 → 结果」整行，字符串则精确比对结果。 */
function hits(candidate, want) {
  const line = `${candidate.formula ?? candidate.expression ?? ''} → ${candidate.preview}`
  return want instanceof RegExp ? want.test(line) : candidate.preview === want
}

console.log(`模型：${model}　服务：${baseUrl}　凭据：${apiKey ? '已加载（不打印）' : '本地服务，不需要'}\n`)

let passed = 0
const failures = []

for (const testCase of CASES) {
  console.log(`「${testCase.input}」  — ${testCase.note}`)

  // 规则能不能独立搞定是**附带信息**：默认策略下规则优先，
  // 但这个脚本量的是模型，所以每条都照样送去 translate()
  const direct = await calculate(testCase.input)
  console.log(
    direct.kind === 'answer'
      ? `  规则可独立处理：${direct.answer.formula}`
      : `  规则读不懂（${direct.kind === 'failure' ? direct.reason : direct.kind}）→ 正是 LLM 该接手的场景`,
  )

  const started = Date.now()
  let candidates = []
  let rejected = null
  try {
    candidates = await translate(testCase.input, settings)
  } catch (error) {
    if (error instanceof NotMathError) {
      rejected = error.message
    } else {
      console.log(`  ✗ 调用失败：${error.message}\n`)
      failures.push(`${testCase.input}（调用失败）`)
      continue
    }
  }
  const ms = Date.now() - started

  if (rejected !== null) {
    const ok = testCase.kind === 'reject'
    if (ok) passed += 1
    else failures.push(`${testCase.input}（被误拒）`)
    console.log(`  ${ok ? '✓' : '✗'} 模型拒答：「${rejected}」  ${ms}ms\n`)
    continue
  }

  for (const candidate of candidates) {
    console.log(`    ${candidate.formula ?? candidate.expression}　「${candidate.reading}」`)
  }

  let ok
  if (testCase.kind === 'reject') {
    // 判据是「没有硬凑出算式」。理想是调 reject 工具说明原因（上面那条分支），
    // 退一步给不出任何候选也算过——用户看到的同样是「读不懂」，不是一个错答案。
    ok = candidates.length === 0
    if (ok) console.log('    （没有给出候选，等同于读不懂；不如显式 reject 好，但不会给错答案）')
  } else if (testCase.kind === 'ambiguous') {
    ok = candidates.length >= 2 && testCase.want.every((w) => candidates.some((c) => hits(c, w)))
  } else {
    ok = candidates.some((c) => hits(c, testCase.want))
  }

  if (ok) passed += 1
  else failures.push(`${testCase.input}（${candidates.length} 个候选都不满足判据）`)
  console.log(`  ${ok ? '✓' : '✗'} ${candidates.length} 个候选  ${ms}ms\n`)
}

console.log('─'.repeat(56))
console.log(`通过　${passed}/${CASES.length}`)
for (const item of failures) console.log(`　✗ ${item}`)
console.log('\n注：候选一律要用户点选后才作数，模型给错不会产生错误答案。')
