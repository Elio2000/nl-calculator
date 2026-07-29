import type { Message } from '../state/conversation'
import { CandidatePicker } from './CandidatePicker'
import { Formula } from './Formula'

interface Props {
  message: Message
  onPickCandidate: (messageId: string, choiceIndex: number) => void
  onRejectCandidates: (messageId: string) => void
  /** 答案理解错了，让 AI 重新翻译一次。 */
  onRetryAnswer: (messageId: string, input: string) => void
  onOpenSettings: () => void
}

/** 时间轴上的一条记录。用户提问、系统作答、候选卡、提示都走这里。 */
export function MessageEntry({
  message,
  onPickCandidate,
  onRejectCandidates,
  onRetryAnswer,
  onOpenSettings,
}: Props) {
  if (message.role === 'user') {
    return (
      <article className="entry entry--user">
        <div className="entry__label">
          <span>你{message.fromVoice ? '（语音）' : ''}</span>
        </div>
        <p className="entry__question">{message.text}</p>
      </article>
    )
  }

  switch (message.kind) {
    case 'answer':
      return (
        <article className="entry entry--answer">
          <div className="entry__label">
            <SourceBadge source={message.source} />
          </div>
          <p className="entry__answer">{message.text}</p>
          <Formula tex={message.tex} fallback={message.formula} />
          {message.retryInput && !message.retried && (
            <button
              type="button"
              className="answer__retry"
              onClick={() => onRetryAnswer(message.id, message.retryInput as string)}
            >
              理解得不对？换一种
            </button>
          )}
        </article>
      )

    case 'steps':
      return (
        <article className="entry entry--answer">
          <div className="entry__label">
            <span>分步计算</span>
            <SourceBadge source={message.source} bare />
          </div>
          <p className="steps__note">这是一串连续的步骤，每一步都算给你：</p>
          <ol className="steps">
            {message.steps.map((step, index) => (
              <li key={index} className="step">
                <span className="step__question">{step.question}</span>
                <span className="step__answer">{step.text}</span>
                <Formula tex={step.tex} fallback={step.formula} />
              </li>
            ))}
          </ol>
          {message.stopped && (
            <p className="steps__stopped">
              「{message.stopped.question}」这一步没算成：{message.stopped.reason}
            </p>
          )}
        </article>
      )

    case 'candidates':
      return (
        <article className="entry">
          <div className="entry__label">
            <span>需要你确认</span>
          </div>
          <CandidatePicker
            message={message}
            onPick={(index) => onPickCandidate(message.id, index)}
            onReject={() => onRejectCandidates(message.id)}
          />
        </article>
      )

    case 'notice':
      return (
        <article className="entry">
          <div className="entry__label">
            <span>说明</span>
          </div>
          <p className="notice">
            {message.text}
            {message.action === 'open-settings' && (
              <button type="button" className="notice__action" onClick={onOpenSettings}>
                打开设置
              </button>
            )}
          </p>
        </article>
      )

    case 'pending':
      return (
        <article className="entry">
          <div className="entry__label">
            <span>处理中</span>
          </div>
          <p className="pending">{message.text}</p>
        </article>
      )
  }
}

function SourceBadge({ source, bare }: { source: 'rule' | 'llm'; bare?: boolean }) {
  return (
    <>
      {!bare && <span>计算</span>}
      <span className={source === 'llm' ? 'badge badge--ai' : 'badge'}>
        {source === 'llm' ? 'AI 翻译 · 本地计算' : '规则'}
      </span>
    </>
  )
}
