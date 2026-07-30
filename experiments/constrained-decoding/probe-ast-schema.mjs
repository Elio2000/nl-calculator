/**
 * 方案一实测：strict 递归 JSON Schema，让模型在约束解码下直接建表达式树。
 *
 * 节点只有四种（num/const/op/fn），函数名与算符全是 enum——
 * 白名单从「事后校验」前移到「采样时物理不可违反」；
 * schema 里不存在变量节点，a、b 这类符号无法表达，模型被迫先消元。
 *
 * key 来自环境变量 DEEPSEEK_API_KEY 或项目根目录 .deepseek.key（不进 git）。
 * 运行：
 *   node experiments/constrained-decoding/probe-ast-schema.mjs 一加二乘三等于几
 */
import { readDeepseekKey, DEEPSEEK_UPSTREAM } from '../../scripts/lib/deepseek.mjs'

const apiKey = readDeepseekKey()
if (!apiKey) {
  console.error('缺 key：设 DEEPSEEK_API_KEY 或在项目根放 .deepseek.key')
  process.exit(1)
}

const NODE = {
  anyOf: [
    {
      type: 'object',
      properties: { kind: { const: 'num' }, value: { type: 'number' } },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { const: 'const' }, name: { enum: ['pi', 'e', 'i'] } },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'op' },
        op: { enum: ['+', '-', '*', '/', '^'] },
        left: { $ref: '#/$defs/node' },
        right: { $ref: '#/$defs/node' },
      },
      required: ['kind', 'op', 'left', 'right'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'fn' },
        name: {
          enum: [
            'sqrt', 'cbrt', 'abs', 'factorial', 'exp', 'log', 'log10', 'log2',
            'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
            'nthRoot', 'mod',
          ],
        },
        args: { type: 'array', items: { $ref: '#/$defs/node' }, minItems: 1, maxItems: 2 },
      },
      required: ['kind', 'name', 'args'],
      additionalProperties: false,
    },
  ],
}

const body = {
  model: process.env.MODEL || 'deepseek-v4-flash',
  temperature: 0,
  messages: [
    { role: 'system', content: '把中文数学问题翻译成表达式树后调用工具。' },
    { role: 'user', content: process.argv[2] || '一加二乘三等于几' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'evaluate_ast',
        strict: true,
        description: '计算一棵表达式树的值',
        parameters: {
          type: 'object',
          properties: {
            expr: { $ref: '#/$defs/node' },
            reading: { type: 'string', description: '中文复述' },
          },
          required: ['expr', 'reading'],
          additionalProperties: false,
          $defs: { node: NODE },
        },
      },
    },
  ],
  tool_choice: 'auto',
}

const res = await fetch(`${DEEPSEEK_UPSTREAM}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(body),
})
console.log('HTTP', res.status)
const data = await res.json()
if (!res.ok) {
  console.log(JSON.stringify(data).slice(0, 400))
  process.exit(0)
}
const call = data.choices?.[0]?.message?.tool_calls?.[0]
console.log('finish:', data.choices?.[0]?.finish_reason, ' tool:', call?.function?.name)
if (call) {
  const args = JSON.parse(call.function.arguments)
  console.log(JSON.stringify(args, null, 1))
  const render = (n) =>
    n.kind === 'num' ? String(n.value)
    : n.kind === 'const' ? n.name
    : n.kind === 'op' ? `(${render(n.left)}${n.op}${render(n.right)})`
    : `${n.name}(${n.args.map(render).join(',')})`
  console.log('渲染:', render(args.expr))
}
