import { useState } from 'react'
import { MODELS, type ModelSize } from '../services/stt'
import type { LlmProvider, Settings, TranslateStrategy } from '../state/settings'

interface Props {
  settings: Settings
  onSave: (settings: Settings) => void
  onClose: () => void
}

const PROVIDERS: Array<{ value: LlmProvider; label: string; hint: string }> = [
  {
    value: 'none',
    label: '不启用',
    hint: '规则引擎独立工作，读不懂时直接告知，不做猜测。',
  },
  {
    value: 'endpoint',
    label: 'OpenAI 兼容服务',
    hint: '可填 Ollama、LM Studio 或云端服务。浏览器直连需要服务端允许跨域。',
  },
]

/**
 * 后端预设。点一下只填 baseUrl + chatModel 两项，其余（策略、语音档位、已填的 key）
 * 原样保留——预设是「填空的快捷方式」，不是「恢复出厂设置」。
 */
const PRESETS: Array<{ label: string; baseUrl: string; chatModel: string; hint: string }> = [
  {
    label: '内置转发（默认）',
    baseUrl: '/api/llm/v1',
    chatModel: 'deepseek-v4-flash',
    hint: '同源转发，key 在服务端，无需填写',
  },
  {
    label: 'DeepSeek 直连',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-v4-flash',
    hint: '浏览器直连，需要自备 key',
  },
  {
    label: '本地 Qwen3-8B',
    baseUrl: 'http://localhost:11434/v1',
    chatModel: 'qwen3:8b',
    hint: '完全离线（Ollama），需设 OLLAMA_ORIGINS；实测 1.5B 档翻译质量不够，8B 起步',
  },
]

const STRATEGIES: Array<{ value: TranslateStrategy; label: string; hint: string }> = [
  {
    value: 'rule-first',
    label: '规则优先',
    hint: '规则能解析的直接计算，毫秒级、离线、同样输入得到同样结果；解析不了时再调用模型。',
  },
  {
    value: 'llm-first',
    label: 'LLM 翻译优先',
    hint: '一律先由模型翻译，规则作为模型不可用时的退路。覆盖面更广，但每次都需等待模型响应。',
  },
]

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(settings)

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog__header">
          <h2 className="dialog__title">设置</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="field">
          <h3 className="field__title">语音识别模型</h3>
          <select
            className="field__control"
            value={draft.voiceModel}
            onChange={(event) => update('voiceModel', event.target.value as ModelSize)}
          >
            {(Object.keys(MODELS) as ModelSize[]).map((size) => (
              <option key={size} value={size}>
                {MODELS[size].label}
              </option>
            ))}
          </select>
        </section>

        <section className="field">
          <h3 className="field__title">AI 归一化</h3>
          <p className="field__hint">
            规则解析不了时，由模型将自然语言翻译成算式。
            <strong>模型只翻译，不参与计算</strong>
            ——它给出的每个候选都会在本地校验并由使用者确认，计算始终由本地引擎完成。
          </p>

          <div className="radio-group">
            {PROVIDERS.map((provider) => (
              <label key={provider.value} className="radio">
                <input
                  type="radio"
                  name="provider"
                  checked={draft.llmProvider === provider.value}
                  onChange={() => update('llmProvider', provider.value)}
                />
                <span>
                  <strong>{provider.label}</strong>
                  <span className="radio__hint">{provider.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {/* 只有接了服务才需要这些配置，不启用时整块隐藏 */}
          {draft.llmProvider === 'endpoint' && (
            <>
              <div className="field__stack">
                <span className="field__label">常用后端</span>
                <div className="presets">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="example-chip"
                      title={preset.hint}
                      aria-pressed={
                        draft.baseUrl === preset.baseUrl && draft.chatModel === preset.chatModel
                      }
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          baseUrl: preset.baseUrl,
                          chatModel: preset.chatModel,
                        }))
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <label className="field__label" htmlFor="setting-base-url">
                  服务地址
                </label>
                {/* 不用 type="url"：默认值 /api/llm/v1 是相对路径，会被浏览器判成非法 URL */}
                <input
                  id="setting-base-url"
                  className="field__control"
                  type="text"
                  value={draft.baseUrl}
                  onChange={(event) => update('baseUrl', event.target.value)}
                />

                <label className="field__label" htmlFor="setting-api-key">
                  API Key
                </label>
                <input
                  id="setting-api-key"
                  className="field__control"
                  type="password"
                  placeholder="内置转发与本地服务留空"
                  value={draft.apiKey}
                  onChange={(event) => update('apiKey', event.target.value)}
                />

                <label className="field__label" htmlFor="setting-model">
                  模型名称
                </label>
                <input
                  id="setting-model"
                  className="field__control"
                  type="text"
                  value={draft.chatModel}
                  onChange={(event) => update('chatModel', event.target.value)}
                />

                <p className="field__hint">
                  走<strong>内置转发</strong>（默认，地址以 <code>/</code> 开头）时不需要填
                  Key——凭据在服务端，不下发到浏览器。
                  只有<strong>直连</strong>第三方服务才要填；填了的 Key 仅保存在本机浏览器中，
                  且只会发往上方这个地址。
                </p>
              </div>

              <div className="field__stack">
                <h4 className="field__subtitle">调用时机</h4>
                <div className="radio-group">
                  {STRATEGIES.map((strategy) => (
                    <label key={strategy.value} className="radio">
                      <input
                        type="radio"
                        name="strategy"
                        checked={draft.strategy === strategy.value}
                        onChange={() => update('strategy', strategy.value)}
                      />
                      <span>
                        <strong>{strategy.label}</strong>
                        <span className="radio__hint">{strategy.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        <footer className="dialog__footer">
          <button type="button" className="composer__button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="composer__button composer__button--primary"
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
