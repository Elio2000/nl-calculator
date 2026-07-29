/**
 * 工具执行器：把一次工具调用交给本地引擎跑出来。
 *
 * 模型选工具、填参数，执行永远在这里——这是「模型只翻译不计算」这条边界的
 * 落点。同一个入口也用于候选卡的结果预览：摆到用户面前的每个选项都是真跑过的，
 * 不会出现点下去才报错的按钮。
 */
import { evaluate, toReadableTexLoose, validate } from '../engines/mathEngine'
import { calculus, solveEquation } from '../engines/solverEngine'
import { displayExpression, formulaTex } from '../core/nlg'
import type { ToolCall } from './llmTools'

export interface ToolOutcome {
  /** 结果文本。 */
  preview: string
  /** 展示用算式（纯文本兜底）。 */
  formula: string
  /** 算式的 LaTeX。候选卡也要用数学排版显示——
   *  让人一眼看出 AI 理解得对不对，`x^2+1` 这种写法普通人读不出是不是自己要的。 */
  tex: string
}

export async function runToolCall(call: ToolCall): Promise<ToolOutcome> {
  switch (call.tool) {
    case 'evaluate': {
      // 白名单校验挡住越权构造，模型再被诱导也执行不了别的东西
      validate(call.expression)
      const outcome = evaluate(call.expression)
      const value = outcome.value
      const preview =
        value.kind === 'complex'
          ? value.text
          : value.kind === 'rational'
            ? value.fraction
            : value.decimal
      const sign = value.exact ? '=' : '≈'
      return {
        preview,
        formula: `${displayExpression(call.expression)} ${sign} ${preview}`,
        tex: formulaTex(outcome.tex, preview, value.exact),
      }
    }

    case 'solve': {
      const outcome = await solveEquation(call.equation, '0', call.variable)
      return {
        preview: outcome.text,
        formula: `${displayExpression(call.equation)} = 0`,
        tex: `${safeTex(call.equation)} = 0`,
      }
    }

    case 'diff':
    case 'integrate': {
      const outcome = await calculus(call.tool, call.expression, call.variable)
      const inner = safeTex(call.expression)
      return {
        preview: outcome.text,
        formula:
          call.tool === 'diff'
            ? `d/d${call.variable} [ ${displayExpression(call.expression)} ]`
            : `∫ ${displayExpression(call.expression)} d${call.variable}`,
        tex:
          call.tool === 'diff'
            ? `\\frac{d}{d${call.variable}}\\left(${inner}\\right)`
            : `\\int ${inner}\\, d${call.variable}`,
      }
    }
  }
}

/** 含变量的表达式转 LaTeX，失败时退回原串——回显不该拖垮计算。 */
function safeTex(expression: string): string {
  try {
    return toReadableTexLoose(expression)
  } catch {
    return expression
  }
}
