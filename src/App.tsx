import { useCallback, useEffect, useRef, useState } from 'react'
import {
  calculate,
  calculateExpression,
  calculateToolCall,
  type CalcOutcome,
} from './core/calculator'
import { MessageEntry } from './components/MessageEntry'
import { Composer } from './components/Composer'
import { SettingsDialog } from './components/SettingsDialog'
import { nextId, type Message } from './state/conversation'
import { asFollowUp } from './core/steps'
import { DEFAULT_SETTINGS, isLlmReady, loadSettings, saveSettings, type Settings } from './state/settings'
import { SttError, transcribe, VoiceRecorder, type SttState } from './services/stt'
import { LlmError, NotMathError, translate } from './services/llm'

const EXAMPLES = [
  '一加一等于几',
  '三与五的和乘以二',
  'cos派加sin派',
  'e的100次方',
  '根号负四',
  '六除二',
  '以二为底八的对数',
  '解方程x平方加一等于零',
]

type Theme = 'auto' | 'light' | 'dark'

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [theme, setTheme] = useState<Theme>('auto')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceState, setVoiceState] = useState<SttState>('idle')
  const [draft, setDraft] = useState('')
  const streamEnd = useRef<HTMLDivElement>(null)
  const recorder = useRef(new VoiceRecorder())
  /** 上一轮算出的规范表达式，供「在这个基础上再乘以5」这类追问接续。 */
  const lastExpression = useRef<string | null>(null)
  /**
   * 提交序号。快速连按时，慢的那次先发出、后完成，
   * 会把已经更新过的上下文覆盖回旧值——下一句追问就接错了对象。
   * 只有序号更大的结果才准写上下文。
   */
  const turnCounter = useRef(0)
  const lastContextTurn = useRef(0)

  useEffect(() => setSettings(loadSettings()), [])

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const append = useCallback((...items: Message[]) => {
    setMessages((current) => [...current, ...items])
  }, [])

  /**
   * 记住这一轮的结果供追问接续。
   * 只接受**可续算**的结果（单值求值）：方程与微积分的 expression 是展示公式，
   * 拿去接着算会拼出 `x^2-2 = 0×5` 这种畸形串。
   */
  const rememberContext = useCallback((outcome: CalcOutcome, turn: number) => {
    if (turn < lastContextTurn.current) return

    const answer =
      outcome.kind === 'answer'
        ? outcome.answer
        : outcome.kind === 'steps'
          ? outcome.steps[outcome.steps.length - 1]?.answer
          : null

    if (!answer) return
    lastContextTurn.current = turn
    lastExpression.current = answer.continuable ? answer.expression : null
  }, [])

  const replace = useCallback((id: string, message: Message) => {
    setMessages((current) => current.map((item) => (item.id === id ? message : item)))
  }, [])

  /**
   * 把一次计算结果转成消息。四种结局各有各的呈现方式。
   *
   * 降级说明不在这里拼：它曾经只拼进 answer 分支的正文，于是候选卡、
   * 分步、失败三种结局下用户根本看不到「AI 没能调用成功」。
   * 改成由调用方单独发一条 notice，四种结局就都带得上说明。
   */
  const render = useCallback(
    (outcome: CalcOutcome, originalInput: string, llmReady: boolean): Message => {
      switch (outcome.kind) {
        case 'answer':
          return {
            id: nextId(),
            role: 'assistant',
            kind: 'answer',
            text: outcome.answer.text,
            formula: outcome.answer.formula,
            tex: outcome.answer.tex,
            source: outcome.answer.source,
          }

        // 多步连续提问：每一步都对，逐条列出而不是让用户二选一
        case 'steps':
          return {
            id: nextId(),
            role: 'assistant',
            kind: 'steps',
            source: outcome.steps[0]?.answer.source ?? 'rule',
            steps: outcome.steps.map((step) => ({
              question: step.question,
              text: step.answer.text,
              formula: step.answer.formula,
              tex: step.answer.tex,
            })),
            stopped: outcome.stopped,
          }

        case 'candidates':
          return {
            id: nextId(),
            role: 'assistant',
            kind: 'candidates',
            question: outcome.question,
            choices: outcome.choices,
            originalInput,
          }

        case 'failure': {
          // 数学错误（除零、定义域）本身就是准确的答复，不需要再劝用户换说法
          const canRetry = outcome.cause === 'comprehension' && !llmReady
          return {
            id: nextId(),
            role: 'assistant',
            kind: 'notice',
            text: canRetry
              ? `${outcome.reason}。可以换个说法，或者启用 AI 归一化让我把这句话翻译成算式。`
              : `${outcome.reason}。`,
            action: canRetry ? 'open-settings' : undefined,
          }
        }
      }
    },
    [],
  )

  /**
   * 规则读不懂时转交 LLM 翻译。
   * 模型给的候选一律进候选卡由用户确认——它只负责提出读法，不负责算数。
   */
  /**
   * 让模型翻译。返回它到底发生了什么，而不是一个笼统的成功/失败——
   * 调用方需要据此决定「退回规则」时要不要告诉用户 AI 没用上。
   */
  const askLlm = useCallback(
    async (
      input: string,
      pendingId: string,
      /** 这次翻译属于哪一轮操作。写续算上下文时靠它挡住慢请求覆盖新结果。 */
      turn: number,
    ): Promise<{ status: 'candidates' } | { status: 'empty' } | { status: 'error'; message: string }> => {
      try {
        const candidates = await translate(input, settings)
        if (candidates.length === 0) return { status: 'empty' }

        // 只有一种理解时直接作答。让用户在唯一选项上「二选一」是很怪的交互，
        // 但仍要留纠偏的路——答案下方有「理解得不对？」入口。
        if (candidates.length === 1) {
          const only = candidates[0]
          const outcome = await calculateToolCall(only.call, input)
          if (outcome.kind === 'answer') {
            // 走 rememberContext 而不是直接赋值：可续算判断与防覆盖只有一份
            rememberContext(outcome, turn)
            replace(pendingId, {
              id: pendingId,
              role: 'assistant',
              kind: 'answer',
              text: outcome.answer.text,
              formula: outcome.answer.formula,
              tex: outcome.answer.tex,
              source: 'llm',
              retryInput: input,
            })
            return { status: 'candidates' }
          }
        }

        replace(pendingId, {
          id: pendingId,
          role: 'assistant',
          kind: 'candidates',
          question: 'AI 把这句话理解成了下面这样，你要哪一种？',
          originalInput: input,
          choices: candidates.map((candidate) => ({
            call: candidate.call,
            reading: candidate.reading,
            preview: candidate.preview,
            formula: candidate.formula,
            tex: candidate.tex,
          })),
        })
        return { status: 'candidates' }
      } catch (error) {
        // 模型明确说了这不是数学问题——转达它的理由，比笼统的「没读懂」有用
        if (error instanceof NotMathError) {
          replace(pendingId, {
            id: pendingId,
            role: 'assistant',
            kind: 'notice',
            text: error.message,
          })
          return { status: 'candidates' }
        }
        return {
          status: 'error',
          message: error instanceof LlmError ? error.message : '调用 AI 出错了',
        }
      }
    },
    [rememberContext, replace, settings],
  )

  const ask = useCallback(
    async (text: string, fromVoice = false) => {
      const turn = ++turnCounter.current
      const pendingId = nextId()
      append(
        { id: nextId(), role: 'user', text, fromVoice },
        // 方程与微积分要惰性加载求解器，先占个位，免得界面看起来卡住
        { id: pendingId, role: 'assistant', kind: 'pending', text: '正在计算' },
      )

      const llmReady = isLlmReady(settings)
      // 退回规则时要告诉用户 AI 为什么没用上——不说的话，
      // 用户明明选了「LLM 翻译优先」却看到「规则」角标，会以为设置没生效。
      let llmNote = ''

      // 追问先走规则：它的句式是固定的（「再乘以五」「然后加三」），
      // 规则解析既准又快。交给 LLM 反而会丢掉上下文——实测
      // 「再乘以五」被理解成方程 x×5=0，而不是接着上一步的 2 算。
      const isFollowUp = lastExpression.current !== null && asFollowUp(text) !== null

      if (llmReady && settings.strategy === 'llm-first' && !isFollowUp) {
        replace(pendingId, {
          id: pendingId,
          role: 'assistant',
          kind: 'pending',
          text: 'AI 正在翻译这句话',
        })

        const result = await askLlm(text, pendingId, turn)
        if (result.status === 'candidates') return
        llmNote = result.status === 'error'
          ? `AI 没能调用成功（${result.message}），下面是规则引擎的结果。`
          : 'AI 没能把这句话翻译成算式，下面是规则引擎的结果。'
      }

      const outcome = await calculate(text, 'rule', lastExpression.current)
      rememberContext(outcome, turn)

      // 只有「读不懂」才值得让 AI 重新翻译。除零这类数学错误已经有准确答复了，
      // 送去翻译只会让用户白等一轮网络，还丢掉那句写得清楚的提示。
      if (
        outcome.kind === 'failure' &&
        outcome.cause === 'comprehension' &&
        llmReady &&
        settings.strategy === 'rule-first'
      ) {
        replace(pendingId, {
          id: pendingId,
          role: 'assistant',
          kind: 'pending',
          text: '规则没读懂，交给 AI 翻译',
        })
        const result = await askLlm(text, pendingId, turn)
        if (result.status === 'candidates') return
        replace(pendingId, {
          id: pendingId,
          role: 'assistant',
          kind: 'notice',
          text: result.status === 'error'
            ? result.message
            : 'AI 也没能把这句话理解成算式。换个说法试试？',
          action: result.status === 'error' ? 'open-settings' : undefined,
        })
        return
      }

      // 降级说明单独成一条，摆在结果前面：无论这一轮的结局是答案、候选卡、
      // 分步还是失败，用户都先读到「AI 没用上」，再读规则引擎给的东西。
      if (llmNote) {
        replace(pendingId, { id: pendingId, role: 'assistant', kind: 'notice', text: llmNote })
        append(render(outcome, text, llmReady))
        return
      }

      replace(pendingId, render(outcome, text, llmReady))
    },
    [append, askLlm, rememberContext, render, replace, settings],
  )

  /**
   * 用户在候选卡里点了某一种读法。
   * 规则候选带规范表达式，AI 候选带工具调用，按下标取出后分别执行。
   */
  const pickCandidate = useCallback(
    async (messageId: string, choiceIndex: number) => {
      // 点选也是一次「产生新结果」的操作，同样占一个轮次：
      // 用户是在看到候选卡之后才点的，它就该压过还在路上的旧提交
      const turn = ++turnCounter.current
      const target = messages.find((message) => message.id === messageId)
      if (target?.role !== 'assistant' || target.kind !== 'candidates') return

      const choice = target.choices[choiceIndex]
      if (!choice) return

      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.role === 'assistant' && message.kind === 'candidates'
            ? { ...message, resolved: true }
            : message,
        ),
      )

      const outcome = choice.call
        ? await calculateToolCall(choice.call, target.originalInput)
        : calculateExpression(choice.expression as string, target.originalInput, 'rule')

      // 追问要接得上这一步的结果。可续算判断与慢请求防覆盖都在 rememberContext 里，
      // 这里曾经是一句裸赋值，绕开了防覆盖那一半
      rememberContext(outcome, turn)
      append(render(outcome, target.originalInput, isLlmReady(settings)))
    },
    [append, messages, rememberContext, render, settings],
  )

  /**
   * 用户说这个理解不对，让 AI 重来一次。
   * 与候选卡的「都不是」是同一条路，只是入口在单一答案下方。
   */
  const retryAnswer = useCallback(
    async (messageId: string, input: string) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.role === 'assistant' && message.kind === 'answer'
            ? { ...message, retried: true }
            : message,
        ),
      )

      if (!isLlmReady(settings)) {
        append({
          id: nextId(),
          role: 'assistant',
          kind: 'notice',
          text: '启用 AI 归一化后，我可以换一种方式理解这句话。',
          action: 'open-settings',
        })
        return
      }

      const turn = ++turnCounter.current
      const pendingId = nextId()
      append({ id: pendingId, role: 'assistant', kind: 'pending', text: '让 AI 换个理解方式' })
      const result = await askLlm(input, pendingId, turn)
      if (result.status === 'candidates') return

      replace(pendingId, {
        id: pendingId,
        role: 'assistant',
        kind: 'notice',
        text: result.status === 'error' ? result.message : 'AI 没有给出别的理解方式。',
        action: result.status === 'error' ? 'open-settings' : undefined,
      })
    },
    [append, askLlm, replace, settings],
  )

  /** 用户说「都不是」——把原话交给 LLM 重新翻译。 */
  const rejectCandidates = useCallback(
    async (messageId: string) => {
      const turn = ++turnCounter.current
      const target = messages.find((message) => message.id === messageId)
      const originalInput =
        target?.role === 'assistant' && target.kind === 'candidates' ? target.originalInput : ''

      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.role === 'assistant' && message.kind === 'candidates'
            ? { ...message, resolved: true }
            : message,
        ),
      )

      if (!isLlmReady(settings)) {
        append({
          id: nextId(),
          role: 'assistant',
          kind: 'notice',
          text: '启用 AI 归一化后，我可以把这句话重新翻译成算式，再让你确认。',
          action: 'open-settings',
        })
        return
      }

      const pendingId = nextId()
      append({ id: pendingId, role: 'assistant', kind: 'pending', text: '让 AI 换个理解方式' })

      // 结果必须等回来处理掉。曾经 `void askLlm(...)` 把状态丢了，
      // 端点离线或模型给不出候选时，那条「让 AI 换个理解方式」就永远转圈。
      const result = await askLlm(originalInput, pendingId, turn)
      if (result.status === 'candidates') return

      replace(pendingId, {
        id: pendingId,
        role: 'assistant',
        kind: 'notice',
        text: result.status === 'error'
          ? result.message
          : 'AI 也没能把这句话理解成算式。换个说法试试？',
        action: result.status === 'error' ? 'open-settings' : undefined,
      })
    },
    [append, askLlm, messages, replace, settings],
  )

  const toggleVoice = useCallback(async () => {
    if (voiceState === 'recording') {
      setVoiceState('transcribing')
      try {
        const audio = await recorder.current.stop()
        const text = await transcribe(audio, settings.voiceModel)
        setVoiceState('idle')
        // 填进输入框而不是直接发送：识别难免出错，让用户过一眼再回车
        setDraft((current) => (current ? `${current}${text}` : text))
      } catch (error) {
        setVoiceState('idle')
        append({
          id: nextId(),
          role: 'assistant',
          kind: 'notice',
          text: error instanceof SttError ? error.message : '语音识别失败',
        })
      }
      return
    }

    try {
      await recorder.current.start()
      setVoiceState('recording')
    } catch (error) {
      append({
        id: nextId(),
        role: 'assistant',
        kind: 'notice',
        text: error instanceof SttError ? error.message : '无法开始录音',
      })
    }
  }, [append, settings.voiceModel, voiceState])

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar__title">自然语言计算器</h1>
        <span className="topbar__subtitle">说人话，算精确</span>
        <span className="topbar__spacer" />
        <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
      </header>

      <main className="stream">
        {messages.length === 0 && <Welcome onPick={(text) => void ask(text)} />}

        {messages.map((message) => (
          <MessageEntry
            key={message.id}
            message={message}
            onPickCandidate={(id, index) => void pickCandidate(id, index)}
            onRejectCandidates={(id) => void rejectCandidates(id)}
            onRetryAnswer={(id, input) => void retryAnswer(id, input)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ))}
        <div ref={streamEnd} />
      </main>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={(text) => void ask(text)}
        voice={{ state: voiceState, onToggle: () => void toggleVoice() }}
      />

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onSave={(next) => {
            setSettings(next)
            saveSettings(next)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <article className="entry">
      <div className="entry__label">
        <span>开始</span>
      </div>
      <p className="notice">
        用中文说出算式就行。理解不确定时我会把可能的读法列出来让你选，
        但算出来的每一个数都是本地精确计算的。
      </p>
      <div className="examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="example-chip" onClick={() => onPick(example)}>
            {example}
          </button>
        ))}
      </div>
    </article>
  )
}
