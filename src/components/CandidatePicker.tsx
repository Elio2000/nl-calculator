import { useState } from 'react'
import type { CandidatesMessage } from '../state/conversation'
import { Formula } from './Formula'

interface Props {
  message: CandidatesMessage
  /** 按下标回传，因为候选可能来自规则（规范表达式）或模型（工具调用）。 */
  onPick: (index: number) => void
  onReject: () => void
}

/**
 * 候选消歧卡。
 *
 * 每个选项都先在本地算好并显示结果——本地计算便宜，让用户看着答案做选择，
 * 比让他读一句语法解释可靠得多。「都不是」把原话转交 AI 重新翻译。
 */
export function CandidatePicker({ message, onPick, onReject }: Props) {
  const [picked, setPicked] = useState<number | null>(null)
  const locked = message.resolved || picked !== null

  return (
    <div>
      <p className="candidates__question">{message.question}</p>

      <div className="candidates__list">
        {message.choices.map((choice, index) => (
          <button
            key={`${choice.formula}-${index}`}
            type="button"
            className={picked === index ? 'choice choice--picked' : 'choice'}
            disabled={locked}
            onClick={() => {
              setPicked(index)
              onPick(index)
            }}
          >
            <span className="choice__formula">
              <Formula tex={choice.tex ?? ''} fallback={choice.formula} />
            </span>
            <strong className="choice__preview">{choice.preview}</strong>
            {choice.reading && <span className="choice__reading">{choice.reading}</span>}
          </button>
        ))}
      </div>

      {!locked && (
        <button type="button" className="candidates__reject" onClick={onReject}>
          都不是，换个理解方式
        </button>
      )}
    </div>
  )
}
