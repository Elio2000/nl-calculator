/** 对话状态。消息是纯数据，渲染层只负责显示。 */
import type { Choice, Source } from '../core/calculator'

export interface UserMessage {
  id: string
  role: 'user'
  text: string
  /** 由语音识别得到，UI 上标一个小话筒。 */
  fromVoice?: boolean
}

export interface AnswerMessage {
  id: string
  role: 'assistant'
  kind: 'answer'
  text: string
  /** 纯文本算式，LaTeX 渲染失败时兜底。 */
  formula: string
  /** 完整算式的 LaTeX，含结果。 */
  tex: string
  source: Source
  /**
   * 用户原话。有值时答案下方显示「理解得不对？」入口——
   * 只有一个理解时直接给答案更自然，但仍要留一条纠偏的路。
   */
  retryInput?: string
  /** 已经点过「不对」的答案不再显示入口。 */
  retried?: boolean
}

/** 多步连续提问的回答。每一步都对，逐条列出。 */
export interface StepsMessage {
  id: string
  role: 'assistant'
  kind: 'steps'
  steps: Array<{ question: string; text: string; formula: string; tex: string }>
  /** 中断说明。有值表示后面的步骤没算完。 */
  stopped?: { question: string; reason: string }
  source: Source
}

export interface CandidatesMessage {
  id: string
  role: 'assistant'
  kind: 'candidates'
  question: string
  choices: Choice[]
  /** 用户原话，点选后要用它决定回答风格；点「都不是」时转交 LLM。 */
  originalInput: string
  /** 已经做过选择的候选卡不再可点。 */
  resolved?: boolean
}

export interface NoticeMessage {
  id: string
  role: 'assistant'
  kind: 'notice'
  text: string
  /** 提示用户去设置里配置 AI 时显示入口按钮。 */
  action?: 'open-settings'
}

export interface PendingMessage {
  id: string
  role: 'assistant'
  kind: 'pending'
  text: string
}

export type Message =
  | UserMessage
  | AnswerMessage
  | StepsMessage
  | CandidatesMessage
  | NoticeMessage
  | PendingMessage

let counter = 0
export function nextId(): string {
  counter += 1
  return `m${counter}`
}
