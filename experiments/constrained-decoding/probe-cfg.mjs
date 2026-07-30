/**
 * 方案二实测：llama.cpp + GBNF 约束解码。
 *
 * 对照组同一模型不带 grammar，实验组带 grammar；
 * 两组输出都送进应用**真实的** validate()/evaluate()，检验是否落在规范语言内。
 *
 * 准备（模型 blob 直接复用 Ollama 的存储，不用重复下载）：
 *   brew install llama.cpp && ollama pull qwen3:8b
 *   llama-server -m "$(ollama show qwen3:8b --modelfile | grep -m1 '^FROM' | awk '{print $2}')" \
 *     --port 8081 -ngl 99 -c 8192 --jinja
 * 运行：
 *   node experiments/constrained-decoding/probe-cfg.mjs           # 默认打 localhost:8081
 *   BASE=http://localhost:8081 node experiments/constrained-decoding/probe-cfg.mjs
 *
 * 文法注意：llama.cpp 的 GBNF 解析器按行敏感——规则必须单行、纯 ASCII 注释，
 * 多行续写的备选分支会直接 "failed to parse grammar"（实测踩过）。
 */
import '../../scripts/lib/ts-source-hooks.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const GRAMMAR = readFileSync(join(here, 'canonical-expr.gbnf'), 'utf8')
const engine = await import(pathToFileURL(join(here, '../../src/engines/mathEngine.ts')).href)
const { normalizeAliases } = await import(
  pathToFileURL(join(here, '../../src/services/llmTools.ts')).href
)

const BASE = process.env.BASE || 'http://localhost:8081'
const SYSTEM =
  '你是中文数学问题的翻译器。把用户的话翻译成一个规范数学表达式，只输出表达式本身，' +
  '不要任何解释。可用函数：sqrt cbrt nthRoot abs factorial exp log log10 log2 sin cos tan ' +
  'asin acos atan sinh cosh tanh mod；常量 pi e i。log 是自然对数。乘号必须显式写出。'

const CASES = [
  '一加二乘三等于几',
  '六除以二',
  '根号下三的平方加四的平方，再取自然对数',
  '我买了三斤苹果每斤五块二一共多少钱',
  'e的100次幂',
  '以2为底8的对数乘以派',
  '负八的三次方根',
  '二的十次方的阶乘的绝对值', // 文法合法但超预算：文法锁不住数值大小，事后闸门必须保留
]

async function ask(input, useGrammar) {
  const body = {
    model: 'local',
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: input },
    ],
    // qwen3 是思考模型：思考 token 会撞上文法，这里关掉。
    // 若想保留推理，见 README「思考区」文法：root ::= "<scratch>" [^<]* "</scratch>" expr
    chat_template_kwargs: { enable_thinking: false },
    ...(useGrammar ? { grammar: GRAMMAR } : {}),
  }
  const t0 = Date.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  if (!res.ok) return { ms, text: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` }
  const data = await res.json()
  return { ms, text: (data.choices?.[0]?.message?.content ?? '').trim() }
}

function check(raw) {
  const text = normalizeAliases(raw)
  try {
    engine.validate(text)
    const { value } = engine.evaluate(text)
    const shown =
      value.kind === 'complex' ? value.text : value.kind === 'rational' ? value.fraction : value.decimal
    return `✓ 在规范语言内，算得 ${shown}`
  } catch (error) {
    return `✗ 校验不过：${String(error.message).slice(0, 60)}`
  }
}

for (const input of CASES) {
  console.log(`\n【${input}】`)
  for (const useGrammar of [false, true]) {
    const { ms, text } = await ask(input, useGrammar)
    const label = useGrammar ? 'CFG约束' : '无约束'
    console.log(`  ${label} [${ms}ms] ${text.replace(/\n/g, '⏎').slice(0, 90)}`)
    console.log(`         ${check(text)}`)
  }
}
