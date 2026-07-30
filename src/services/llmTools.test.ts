/**
 * LLM 契约的离线测试。
 *
 * 全部不碰网络——请求体构造与响应解析都是纯函数，这正是 pi 的 130 多个测试
 * 能全离线跑的前提：payload 构造与 IO 严格分离。
 * 之前这条路径零测试覆盖，模型翻译错了只能靠手工发现。
 */
import { describe, expect, it } from 'vitest'
import { buildRequest } from './llm'
import { buildToolsPayload, toToolCall, TOOLS } from './llmTools'
import type { Settings } from '../state/settings'

const settings: Settings = {
  voiceModel: 'turbo',
  strategy: 'llm-first',
  llmProvider: 'endpoint',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  chatModel: 'qwen3:8b',
}

/** tools 模式的请求体一定带工具声明，取出来断言。 */
function toolsRequest() {
  const request = buildRequest('一加一', settings, 'tools')
  if (!('tools' in request)) throw new Error('tools 模式应带工具声明')
  return request
}

describe('请求体构造（tools 模式）', () => {
  it('四个计算工具加一个拒绝出口都声明出去了', () => {
    expect(toolsRequest().tools.map((tool) => tool.function.name)).toEqual([
      'evaluate',
      'solve',
      'diff',
      'integrate',
      'reject',
    ])
  })

  it('保留 reject 工具——非数学输入要有诚实的出口，而不是硬凑算式', () => {
    const names = toolsRequest().tools.map((tool) => tool.function.name)
    expect(names).toContain('reject')
  })

  it('strict 真的发出去了——约束解码全靠这个字段', () => {
    for (const tool of toolsRequest().tools) {
      expect(tool.function, `${tool.function.name} 缺 strict`).toHaveProperty('strict', true)
    }
  })

  it('tool_choice 是 auto——required 在 DeepSeek 思考模型上直接 400，Ollama 收下也不强制', () => {
    expect(toolsRequest().tool_choice).toBe('auto')
  })

  it('每个计算工具都要求带 reading——原生 FC 一趟就把中文复述带回来', () => {
    for (const tool of toolsRequest().tools) {
      if (tool.function.name === 'reject') continue
      expect(tool.function.parameters.required, `${tool.function.name} 缺 reading`).toContain(
        'reading',
      )
    }
  })

  it('temperature 为 0——同样输入要给同样翻译', () => {
    expect(toolsRequest().temperature).toBe(0)
  })
})

/**
 * 文本降级。实测 Ollama 的 tool_choice:"required" 并不真的强制——
 * 模型会返回一段自由文本、tool_calls 为 null。这条路是那种情况的退路。
 */
describe('请求体构造（文本降级模式）', () => {
  it('不带 tools 参数——给完全不认这个字段的服务用', () => {
    expect(buildRequest('一加一', settings, 'text')).not.toHaveProperty('tools')
  })

  it('把工具契约写进 system prompt', () => {
    const request = buildRequest('一加一', settings, 'text')
    const system = request.messages[0].content
    for (const tool of TOOLS) {
      expect(system, `${tool.name} 没写进文本契约`).toContain(tool.name)
    }
  })

  it('不支持 strict 的服务可以关掉这个字段', () => {
    for (const tool of buildToolsPayload(false)) {
      expect(tool.function).not.toHaveProperty('strict')
    }
  })

  it('每个参数都带描述——语义靠 schema 承载，不靠 prompt 解释', () => {
    for (const tool of TOOLS) {
      for (const [name, spec] of Object.entries(tool.parameters.properties)) {
        expect(
          (spec as { description?: string }).description,
          `${tool.name}.${name} 缺描述`,
        ).toBeTruthy()
      }
    }
  })
})

describe('模型输出的形状收敛', () => {
  it('参数嵌在 args 里', () => {
    expect(toToolCall({ tool: 'evaluate', args: { expression: '(1+1)' } })).toEqual({
      tool: 'evaluate',
      expression: '(1+1)',
    })
  })

  it('参数扁平铺开也认', () => {
    expect(toToolCall({ tool: 'evaluate', expression: '(1+1)' })).toEqual({
      tool: 'evaluate',
      expression: '(1+1)',
    })
  })

  it('native tool_calls 用 name 而非 tool 字段', () => {
    expect(toToolCall({ name: 'diff', arguments: { expression: 'x^2', variable: 'x' } })).toEqual({
      tool: 'diff',
      expression: 'x^2',
      variable: 'x',
    })
  })

  it('数值被包成字符串时照样接受（模型最高频的软错误）', () => {
    expect(toToolCall({ tool: 'evaluate', args: { expression: 42 } })).toEqual({
      tool: 'evaluate',
      expression: '42',
    })
  })

  it('variable 缺省时补 x', () => {
    expect(toToolCall({ tool: 'diff', args: { expression: 'x^2' } })).toEqual({
      tool: 'diff',
      expression: 'x^2',
      variable: 'x',
    })
  })

  describe('方程的等号归一', () => {
    it('带 =0 的移项掉', () => {
      expect(toToolCall({ tool: 'solve', args: { equation: 'x^2+1=0', variable: 'x' } })).toEqual({
        tool: 'solve',
        equation: 'x^2+1',
        variable: 'x',
      })
    })

    it('右边非零时整体移项', () => {
      expect(toToolCall({ tool: 'solve', args: { equation: '2*x+3=7', variable: 'x' } })).toEqual({
        tool: 'solve',
        equation: '2*x+3-(7)',
        variable: 'x',
      })
    })

    it('已经是单边式子就原样保留', () => {
      expect(toToolCall({ tool: 'solve', args: { equation: 'x^2-4', variable: 'x' } })).toEqual({
        tool: 'solve',
        equation: 'x^2-4',
        variable: 'x',
      })
    })

    it('solve 误填 expression 字段也认', () => {
      expect(toToolCall({ tool: 'solve', args: { expression: 'x-1', variable: 'x' } })).toEqual({
        tool: 'solve',
        equation: 'x-1',
        variable: 'x',
      })
    })
  })

  describe('形状不对时返回 null，绝不猜', () => {
    it.each([
      ['未知工具名', { tool: 'plot', args: { expression: 'x' } }],
      ['缺必填参数', { tool: 'evaluate', args: {} }],
      ['参数是空串', { tool: 'evaluate', args: { expression: '   ' } }],
      ['参数是对象', { tool: 'evaluate', args: { expression: { a: 1 } } }],
      ['整个是 null', null],
      ['整个是字符串', 'evaluate(1+1)'],
      ['方程只有等号右边', { tool: 'solve', args: { equation: '=0', variable: 'x' } }],
    ])('%s', (_case, raw) => {
      expect(toToolCall(raw)).toBeNull()
    })
  })
})

/** Codex 实证发现的畸形输入。共同点：曾经产出畸形表达式却仍给出答案。 */
describe('畸形方程一律拒绝', () => {
  it.each([
    ['多个等号', 'x=2=2'],
    ['连续等号', 'x==2'],
    ['右边空', 'x='],
    ['左边空', '=x'],
  ])('%s：%s', (_case, equation) => {
    // 曾经 x=2=2 被拼成 x-(2=2)，下游居然还答了 x = 0
    expect(toToolCall({ tool: 'solve', args: { equation, variable: 'x' } })).toBeNull()
  })

  it('正常的单等号方程不受影响', () => {
    expect(toToolCall({ tool: 'solve', args: { equation: 'x^2+1=0', variable: 'x' } })).toEqual({
      tool: 'solve',
      equation: 'x^2+1',
      variable: 'x',
    })
  })
})

/**
 * ln/lg 别名归一。CFG 实验（experiments/）实测：qwen3:8b 想写 ln 被文法堵死时，
 * 滑进了「合法但丢了对数」的式子——高频别名要纳入表面语言，在边界归一。
 */
describe('表面别名在 LLM 边界归一', () => {
  it('ln → log（自然对数）', () => {
    expect(toToolCall({ tool: 'evaluate', args: { expression: 'ln(e)' } })).toEqual({
      tool: 'evaluate',
      expression: 'log(e)',
    })
  })

  it('lg → log10（常用对数）', () => {
    expect(toToolCall({ tool: 'evaluate', args: { expression: 'lg(100)+lg(10)' } })).toEqual({
      tool: 'evaluate',
      expression: 'log10(100)+log10(10)',
    })
  })

  it('方程与微积分参数同样归一', () => {
    expect(toToolCall({ tool: 'solve', args: { equation: 'ln(x)=1', variable: 'x' } })).toEqual({
      tool: 'solve',
      equation: 'log(x)-(1)',
      variable: 'x',
    })
    expect(toToolCall({ tool: 'diff', args: { expression: 'ln(x)', variable: 'x' } })).toEqual({
      tool: 'diff',
      expression: 'log(x)',
      variable: 'x',
    })
  })

  it('不误伤：blng(x) 这类只是包含 ln 字样的名字不动', () => {
    expect(toToolCall({ tool: 'evaluate', args: { expression: 'blng(2)' } })).toEqual({
      tool: 'evaluate',
      expression: 'blng(2)',
    })
  })
})

describe('拒绝出口', () => {
  it('模型说这不是数学问题时能被识别', () => {
    expect(toToolCall({ tool: 'reject', args: { why: '这是在问天气' } })).toEqual({
      tool: 'reject',
      why: '这是在问天气',
    })
  })

  it('没给理由时有兜底文案', () => {
    expect(toToolCall({ tool: 'reject', args: {} })).toEqual({
      tool: 'reject',
      why: '这不是一个数学问题',
    })
  })
})
