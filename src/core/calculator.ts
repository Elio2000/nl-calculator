/**
 * 对外入口：一句中文进，一条回答出。
 *
 * 四种结局，对应架构里的四条路径：
 *   answer     —— 唯一读法，直接回答
 *   candidates —— 多种读法，交给用户点选（永不替用户猜）
 *   failure    —— 读不懂，可由上层转交 LLM 归一化后重来
 *   （方程/微积分走 solverEngine，惰性加载，因此接口是异步的）
 */
import { understand, type Candidate } from './nlu'
import { asFollowUp, splitSteps } from './steps'
import { describe, displayExpression, formulaTex, prefersChineseStyle } from './nlg'
import { evaluate, ExpressionError, MathError, toReadableTexLoose } from '../engines/mathEngine'
import { calculus, solveEquation, SolveError } from '../engines/solverEngine'
import type { ToolCall } from '../services/llmTools'
import { runToolCall } from '../services/toolRunner'

export type Source = 'rule' | 'llm'

export interface Answer {
  /** 主答句。 */
  text: string
  /** 算式的纯文本形态，供复制。 */
  formula: string
  /** 送进引擎的规范表达式，供调试。 */
  expression: string
  /**
   * 这个结果能否作为下一轮追问的起点。
   *
   * 只有单值求值可以。方程与微积分的 `expression` 存的是展示用的公式
   * （`x²-2 = 0`、`d/dx [x²]`），把它当算式接着算会拼出
   * `x^2-2 = 0×5` 这种畸形串——曾经就是这样，而且还煞有介事地给了答案。
   */
  continuable: boolean
  /** 完整算式的 LaTeX（含结果），UI 用它渲染成真正的数学排版。 */
  tex: string
  source: Source
}

export interface Choice {
  /** 规则给出的候选带规范表达式；模型给出的候选带工具调用。 */
  expression?: string
  call?: ToolCall
  /** 这条读法的中文说明。 */
  reading: string
  /** 该读法算出的结果，让用户看着结果做选择。 */
  preview: string
  formula: string
  /** 算式的 LaTeX，候选卡里也用数学排版显示。 */
  tex?: string
}

/**
 * 失败的来源。这个区分是有用的：理解失败可以交给 LLM 重新翻译，
 * 数学失败（除零、定义域）已经有准确的解释了，再翻译一遍只会让用户
 * 白等一轮网络，还拿不到那句本来写得很清楚的提示。
 */
export type FailureCause = 'comprehension' | 'math'

/** 多步连续提问里的一步。 */
export interface Step {
  /** 用户这一步的原话。 */
  question: string
  answer: Answer
}

/** 多步里中断的那一步。有值就说明后面的步骤没算。 */
export interface StoppedStep {
  question: string
  reason: string
}

export type CalcOutcome =
  | { kind: 'answer'; answer: Answer }
  | { kind: 'steps'; steps: Step[]; stopped?: StoppedStep }
  | { kind: 'candidates'; choices: Choice[]; question: string }
  | { kind: 'failure'; reason: string; cause: FailureCause }

/**
 * 计算一句中文。方程与微积分需要惰性加载求解器，故为异步。
 *
 * 先看是不是多步连续提问（「…等于几？再乘5呢？」）——那种句子的每一步都对，
 * 要逐条回答，而不是当成互斥候选让用户二选一。
 */
export async function calculate(
  input: string,
  source: Source = 'rule',
  /** 上一轮的规范表达式。句子缺左操作数时会接在它后面。 */
  previousExpression?: string | null,
): Promise<CalcOutcome> {
  const steps = splitSteps(input)
  if (steps.length > 1 && steps.some((step) => step.continuesPrevious)) {
    return calculateSteps(steps, source, previousExpression)
  }

  // 跨轮追问：「那在这个基础上再乘以5」缺左操作数，补上一轮的结果
  const followUp = asFollowUp(input)
  if (followUp) {
    if (previousExpression) {
      const outcome = await calculateOne(`${previousExpression}${followUp}`, source)
      if (outcome.kind === 'answer' || outcome.kind === 'candidates') return outcome
      // 承接解释不通就退回按独立算式处理，让错误信息贴合用户真正说的话
    } else {
      // 明显是在追问，但上一步的结果接不上（方程给的是一组解、
      // 微积分给的是一个式子）。说清楚比让他对着「读不通」发懵好。
      return {
        kind: 'failure',
        reason: '这句话是接着上一步问的，但上一步的结果不是一个数，接不上。可以把完整算式说一遍',
        cause: 'comprehension',
      }
    }
  }

  return calculateOne(input, source)
}

/** 逐步计算，每一步把上一步的结果当作左操作数。 */
async function calculateSteps(
  steps: ReturnType<typeof splitSteps>,
  source: Source,
  previousExpression?: string | null,
): Promise<CalcOutcome> {
  const done: Step[] = []
  let previous: string | null = previousExpression ?? null

  for (const step of steps) {
    // 承接上一步时，把上一步的规范表达式补在前面，
    // 「再乘5」于是变成「(1+2*3)乘5」，仍然走同一套文法。
    const text = step.continuesPrevious && previous
      ? `${previous}${step.text}`
      : step.text

    const outcome = await calculateOne(text, source)
    if (outcome.kind !== 'answer') {
      // 某一步算不出来：已算出的部分仍然有价值，但**必须说明在哪一步停了**。
      // 曾经静默丢弃失败的步骤，用户看到前几步以为全部完成了。
      if (done.length > 0) {
        return {
          kind: 'steps',
          steps: done,
          stopped: {
            question: step.original,
            reason:
              outcome.kind === 'failure'
                ? outcome.reason
                : '这一步有多种读法，需要单独确认',
          },
        }
      }
      return outcome
    }

    done.push({ question: step.original, answer: outcome.answer })
    previous = outcome.answer.expression
  }

  if (done.length === 0) return { kind: 'failure', reason: '没有看到要计算的内容', cause: 'comprehension' }
  if (done.length === 1) return { kind: 'answer', answer: done[0].answer }
  return { kind: 'steps', steps: done }
}

async function calculateOne(input: string, source: Source): Promise<CalcOutcome> {
  const understood = understand(input)
  if (!understood.ok) {
    return { kind: 'failure', reason: understood.reason, cause: 'comprehension' }
  }

  const { request } = understood

  if (request.kind === 'solve') {
    // 多个未知数时只能解出「用另一个未知数表示」的形式，得说明白，
    // 免得用户以为解出了具体的数
    const note = request.otherVariables.length > 0
      ? `（式子里还有 ${request.otherVariables.join('、')}，所以只能用它表示 ${request.variable}）`
      : ''
    return runSolver(
      () => solveEquation(request.left, request.right, request.variable),
      `${displayExpression(request.left)} = ${displayExpression(request.right)}`,
      safeTex(request.left, request.right),
      source,
      note,
    )
  }

  if (request.kind === 'calculus') {
    const label = request.operation === 'diff' ? 'd/d' : '∫'
    const inner = safeTex(request.expression)
    return runSolver(
      () => calculus(request.operation, request.expression, request.variable),
      request.operation === 'diff'
        ? `${label}${request.variable} [ ${displayExpression(request.expression)} ]`
        : `${label} ${displayExpression(request.expression)} d${request.variable}`,
      request.operation === 'diff'
        ? `\\frac{d}{d${request.variable}}\\left(${inner}\\right)`
        : `\\int ${inner}\\, d${request.variable}`,
      source,
    )
  }

  return evaluateCandidates(request.candidates, input, source)
}

/** 直接计算一条已确定的规范表达式（用户从候选卡里点选后走这条）。 */
export function calculateExpression(
  expression: string,
  originalInput: string,
  source: Source = 'rule',
): CalcOutcome {
  try {
    const outcome = evaluate(expression)
    const answer = describe(outcome.value, prefersChineseStyle(originalInput))
    return {
      kind: 'answer',
      answer: {
        text: answer.text,
        formula: `${displayExpression(expression)} ${outcome.value.exact ? '=' : '≈'} ${answer.plain}`,
        expression,
        tex: formulaTex(outcome.tex, answer.plain, outcome.value.exact),
        source,
        continuable: true,
      },
    }
  } catch (error) {
    return { kind: 'failure', reason: readableError(error), cause: 'math' }
  }
}

/** 用户从 AI 候选卡里点选后走这条：执行模型选定的工具调用。 */
export async function calculateToolCall(
  call: ToolCall,
  originalInput: string,
): Promise<CalcOutcome> {
  // 求值候选和规则候选点选后要做的事一模一样，直接走同一条路：
  // 一次求值、一份拼装。曾经这里另起一套，同一个表达式被 runToolCall
  // 和外面的 evaluate() 各跑一遍——两份代码迟早会算出两种样子的回答。
  // （白名单校验不受影响：evaluate() 自己第一步就是 validate。）
  if (call.tool === 'evaluate') {
    return calculateExpression(call.expression, originalInput, 'llm')
  }

  try {
    // 方程与微积分：runToolCall 已经算完并生成了 formula/tex，全部直接复用。
    // 曾经在这里把它们的 tex 丢成空串，UI 只能退回纯文本。
    const outcome = await runToolCall(call)
    return {
      kind: 'answer',
      answer: {
        text: outcome.preview,
        formula: outcome.formula,
        expression: outcome.formula,
        tex: outcome.tex,
        source: 'llm',
        // 方程/微积分的结果不是一个数，接不上「再乘以五」这类追问
        continuable: false,
      },
    }
  } catch (error) {
    return { kind: 'failure', reason: readableError(error), cause: 'math' }
  }
}

function evaluateCandidates(
  candidates: Candidate[],
  input: string,
  source: Source,
): CalcOutcome {
  const useChinese = prefersChineseStyle(input)
  const evaluated = candidates
    .map((candidate) => tryEvaluate(candidate, useChinese, source))
    .filter((item): item is EvaluatedCandidate => item !== null)

  if (evaluated.length === 0) {
    return { kind: 'failure', reason: firstFailureReason(candidates), cause: 'math' }
  }

  if (evaluated.length === 1) {
    // 本来有多种读法，只是别的算不出来——不能假装只有这一种。
    // 「六除零」若把算不出的 6÷0 悄悄丢掉、把 0÷6=0 当唯一答案端出去，
    // 用户会以为「六除零等于零」，这正是最该避免的那类错误答案。
    if (candidates.length > 1) {
      const failed = candidates.find(
        (candidate) => candidate.expression !== evaluated[0].answer.expression,
      )
      const why = failed ? failureReasonOf(failed) : null
      return {
        kind: 'answer',
        answer: {
          ...evaluated[0].answer,
          text: why
            ? `${evaluated[0].answer.text}（另一种读法 ${displayExpression(failed!.expression)} ${why}）`
            : evaluated[0].answer.text,
        },
      }
    }
    return { kind: 'answer', answer: evaluated[0].answer }
  }

  return {
    kind: 'candidates',
    question: '这句话有两种读法，你要哪一种？',
    choices: evaluated.map((item) => ({
      expression: item.answer.expression,
      reading: item.reading,
      preview: item.answer.text.replace(/^等于\s*/, '').replace(/^约等于\s*/, '约 '),
      formula: item.answer.formula,
      tex: item.answer.tex,
    })),
  }
}

async function runSolver(
  run: () => Promise<{ text: string }>,
  formula: string,
  tex: string,
  source: Source,
  note = '',
): Promise<CalcOutcome> {
  try {
    const outcome = await run()
    return {
      kind: 'answer',
      answer: {
        text: outcome.text + note,
        formula,
        expression: formula,
        tex,
        source,
        // 方程/微积分的结果不是单个数，接不上「再乘以五」这类追问
        continuable: false,
      },
    }
  } catch (error) {
    if (error instanceof SolveError) {
      return { kind: 'failure', reason: error.message, cause: 'math' }
    }
    return { kind: 'failure', reason: readableError(error), cause: 'math' }
  }
}

interface EvaluatedCandidate {
  answer: Answer
  reading: string
}

function tryEvaluate(
  candidate: Candidate,
  useChinese: boolean,
  source: Source,
): EvaluatedCandidate | null {
  try {
    const outcome = evaluate(candidate.expression)
    const answer = describe(outcome.value, useChinese)
    return {
      reading: candidate.reading,
      answer: {
        text: answer.text,
        formula: `${displayExpression(candidate.expression)} ${outcome.value.exact ? '=' : '≈'} ${answer.plain}`,
        expression: candidate.expression,
        tex: formulaTex(outcome.tex, answer.plain, outcome.value.exact),
        source,
        continuable: true,
      },
    }
  } catch {
    return null
  }
}

/** 单条候选算不出来的原因，算得出来则返回 null。 */
function failureReasonOf(candidate: Candidate): string | null {
  try {
    evaluate(candidate.expression)
    return null
  } catch (error) {
    return readableError(error)
  }
}

function firstFailureReason(candidates: Candidate[]): string {
  for (const candidate of candidates) {
    try {
      evaluate(candidate.expression)
    } catch (error) {
      return readableError(error)
    }
  }
  return '算不出结果'
}

/** 含变量的表达式转 LaTeX，失败时退回原串——回显不该拖垮计算。 */
function safeTex(left: string, right?: string): string {
  try {
    const leftTex = toReadableTexLoose(left)
    if (right === undefined) return leftTex
    return `${leftTex} = ${toReadableTexLoose(right)}`
  } catch {
    return ''
  }
}

function readableError(error: unknown): string {
  if (error instanceof MathError) return error.message
  if (error instanceof ExpressionError) return error.message
  if (error instanceof SolveError) return error.message
  return (error as Error).message ?? '算不出结果'
}
