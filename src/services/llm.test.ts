/**
 * 翻译层的离线测试。
 *
 * 网络那一段用 stub 顶掉，剩下的都是纯逻辑：候选解析、本地验证、去重。
 * 这一层最值得测的是**去重**——它是唯一会「悄悄删掉一个正确答案」的地方，
 * 而删掉之后界面上什么痕迹都不留，靠手工点是发现不了的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { candidateKey, translate } from './llm'
import type { Settings } from '../state/settings'

const settings: Settings = {
  voiceModel: 'turbo',
  strategy: 'llm-first',
  llmProvider: 'endpoint',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  chatModel: 'qwen3:8b',
}

/** 顶掉网络：返回一次原生 function calling 的响应。 */
function stubToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: calls.map((call) => ({
              // 服务端给的 arguments 永远是 JSON 字符串，不是对象
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
    }),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 去重键。Codex 复现：模型对「x加y等于零」同时给出解 x 和解 y，
 * 两条的展示公式都是 `x+y = 0`，按公式去重会把第二条（y = -x）当重复删掉。
 */
describe('候选去重看的是工具调用，不是展示公式', () => {
  it('同一个式子解不同未知数，是两条不同的候选', () => {
    expect(candidateKey({ tool: 'solve', equation: 'x+y', variable: 'x' })).not.toBe(
      candidateKey({ tool: 'solve', equation: 'x+y', variable: 'y' }),
    )
  })

  it('只有空白不同的同一次调用算重复', () => {
    expect(candidateKey({ tool: 'evaluate', expression: ' 1+1 ' })).toBe(
      candidateKey({ tool: 'evaluate', expression: '1+1' }),
    )
  })

  it('工具不同就是不同的候选，哪怕表达式一样', () => {
    expect(candidateKey({ tool: 'diff', expression: 'x^2', variable: 'x' })).not.toBe(
      candidateKey({ tool: 'integrate', expression: 'x^2', variable: 'x' }),
    )
  })

  it('大小写不同的未知数不合并——对求解引擎 X 和 x 是两个符号', () => {
    expect(candidateKey({ tool: 'solve', equation: 'x+y', variable: 'X' })).not.toBe(
      candidateKey({ tool: 'solve', equation: 'x+y', variable: 'x' }),
    )
  })
})

describe('本地验证后的候选', () => {
  it('展示公式撞车但语义不同的两条都要留下', async () => {
    stubToolCalls([
      { name: 'solve', args: { equation: 'x+y', variable: 'x', reading: '解出 x' } },
      { name: 'solve', args: { equation: 'x+y', variable: 'y', reading: '解出 y' } },
    ])

    const candidates = await translate('x加y等于零', settings)
    expect(candidates).toHaveLength(2)
    // 关键：两条的展示公式确实是同一串——曾经据此去重，第二条被删掉了
    expect(candidates[0].formula).toBe(candidates[1].formula)
    // 而算出来的结果完全不同：x = -y 与 y = -x
    expect(candidates[0].preview).not.toBe(candidates[1].preview)
  }, 30000)

  it('真正重复的调用仍然只留一条', async () => {
    stubToolCalls([
      { name: 'evaluate', args: { expression: '1+1', reading: '一加一' } },
      { name: 'evaluate', args: { expression: ' 1+1 ', reading: '一加一' } },
    ])

    expect(await translate('一加一', settings)).toHaveLength(1)
  })

  it('跑不通的候选被丢弃，跑得通的照常保留', async () => {
    stubToolCalls([
      { name: 'evaluate', args: { expression: '1/0', reading: '一除以零' } },
      { name: 'evaluate', args: { expression: '6/2', reading: '六除以二' } },
    ])

    const candidates = await translate('六除二', settings)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].preview).toBe('3')
  })
})
