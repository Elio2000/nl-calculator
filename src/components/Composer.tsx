import { useEffect, useRef } from 'react'

interface Props {
  onSubmit: (text: string) => void
  disabled?: boolean
  /**
   * 输入框内容由外部控制。
   * 语音识别的结果填进来但**不自动发送**——识别难免出错，
   * 让用户先看一眼、改一改，再按回车。
   */
  value: string
  onChange: (text: string) => void
  voice?: {
    state: 'idle' | 'recording' | 'transcribing' | 'loading-model'
    onToggle: () => void
  }
}

const VOICE_LABEL: Record<string, string> = {
  idle: '语音',
  recording: '停止',
  transcribing: '识别中',
  'loading-model': '加载模型',
}

export function Composer({ onSubmit, disabled, value, onChange, voice }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null)

  // 随内容增高，回车发送、Shift+回车换行
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [value])

  // 语音识别填入内容后自动聚焦，用户可以直接改或按回车
  useEffect(() => {
    if (value) textarea.current?.focus()
  }, [value])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    onChange('')
  }

  const voiceBusy = voice?.state === 'transcribing' || voice?.state === 'loading-model'

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        输入算式
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        className="composer__input"
        rows={1}
        value={value}
        placeholder="说人话，比如「一加一等于几」"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />

      {voice && (
        <button
          type="button"
          className={
            voice.state === 'recording'
              ? 'composer__button composer__button--recording'
              : 'composer__button'
          }
          onClick={voice.onToggle}
          disabled={voiceBusy}
        >
          {VOICE_LABEL[voice.state]}
        </button>
      )}

      <button
        type="submit"
        className="composer__button composer__button--primary"
        disabled={disabled || !value.trim()}
      >
        计算
      </button>
    </form>
  )
}
