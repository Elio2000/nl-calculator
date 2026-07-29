/**
 * 语音输入：浏览器本地跑 Whisper。
 *
 * 用 transformers.js + ONNX Runtime Web，模型首次使用时下载并进浏览器缓存，
 * 之后完全离线。不需要 API key——语音这条链路上没有任何东西离开这台机器。
 * 有 WebGPU 就用 WebGPU（比 WASM 快 5–10 倍），没有则自动回落。
 */

export type SttState = 'idle' | 'loading-model' | 'recording' | 'transcribing'

/**
 * 可选的 Whisper 模型。权重随项目分发在 public/models/ 下。
 * 各档位在中文数学短句上的实测差异见 TESTING.md，默认用 large-v3-turbo。
 */
export const MODELS = {
  base: { id: 'Xenova/whisper-base', label: 'Whisper base（74M 参数，78 MB）' },
  small: { id: 'Xenova/whisper-small', label: 'Whisper small（244M 参数，259 MB）' },
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo（809M 参数，1.0 GB）',
  },
} as const

export type ModelSize = keyof typeof MODELS

/** Whisper 只接受 16kHz 单声道。 */
const TARGET_SAMPLE_RATE = 16000

export class SttError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SttError'
  }
}

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string }>

let pipelinePromise: Promise<Transcriber> | null = null
let loadedModel: ModelSize | null = null

/** 浏览器是否支持 WebGPU。不支持就用 WASM，慢但能用。 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu
  if (!gpu) return 'wasm'
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

/** 加载模型。同一档位只加载一次，换档时重新加载。 */
export async function loadModel(size: ModelSize, onProgress?: (ratio: number) => void) {
  if (pipelinePromise && loadedModel === size) return pipelinePromise

  loadedModel = size
  pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')

    // 模型权重随项目一起分发（public/models/），首选本地文件，
    // 缺哪个档位再回落到 HuggingFace。这样默认档位完全离线，不联网也能用。
    env.localModelPath = `${import.meta.env.BASE_URL}models/`
    env.allowLocalModels = true
    env.allowRemoteModels = true

    const device = await pickDevice()

    const transcriber = await pipeline('automatic-speech-recognition', MODELS[size].id, {
      device,
      // 统一用 int8 量化权重：WebGPU 上同样可跑，而体积只有 fp16 的三分之一。
      // 内置模型要随项目分发，这点体积差别比精度差别更要紧。
      dtype: 'q8',
      progress_callback: (progress: { status?: string; progress?: number }) => {
        if (progress.status === 'progress' && typeof progress.progress === 'number') {
          onProgress?.(progress.progress / 100)
        }
      },
    })

    return transcriber as unknown as Transcriber
  })()

  try {
    return await pipelinePromise
  } catch (error) {
    // 加载失败要清掉缓存的 promise，否则用户重试时会一直拿到同一个失败结果
    pipelinePromise = null
    loadedModel = null
    throw new SttError(`语音模型加载失败：${(error as Error).message}`)
  }
}

/** 录音器。start 开始采集，stop 返回识别文本。 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new SttError('这个浏览器不支持录音')
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      throw new SttError('没有拿到麦克风权限')
    }

    this.chunks = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start()
  }

  /** 停止录音并返回音频数据。 */
  async stop(): Promise<Float32Array> {
    const recorder = this.recorder
    if (!recorder) throw new SttError('没有正在进行的录音')

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }))
      recorder.stop()
    })

    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null

    return decodeToMono16k(blob)
  }

  get active(): boolean {
    return this.recorder !== null
  }
}

/** 解码成 Whisper 要的 16kHz 单声道 Float32。 */
async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buffer = await blob.arrayBuffer()
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  try {
    const decoded = await context.decodeAudioData(buffer)
    return decoded.getChannelData(0)
  } finally {
    await context.close()
  }
}

/** 识别一段音频。language 固定中文，task 固定转写（不翻译）。 */
export async function transcribe(audio: Float32Array, size: ModelSize): Promise<string> {
  if (audio.length < TARGET_SAMPLE_RATE * 0.25) {
    throw new SttError('录音太短，没听清')
  }

  const transcriber = await loadModel(size)
  const result = await transcriber(audio, { language: 'chinese', task: 'transcribe' })
  const text = result.text?.trim()

  if (!text) throw new SttError('没听清，再说一次试试')
  return normalizeSpeech(text)
}

/**
 * Whisper 中文输出的系统性偏差修正。
 *
 * 实测发现两类稳定偏差：一是**输出繁体**（「一加一等于几」会被写成「1加1等於幾」），
 * 二是把中文数字写成阿拉伯数字。后者无害——构式层本来就支持中阿混写；
 * 前者必须转简体，否则「等於幾」这类词表匹配不上。
 *
 * 只做这种一对一的无损字面替换。同音字错误（「乘以」听成「成以」）不在这里猜，
 * 那属于理解问题，该走候选卡或 AI 归一化。
 */
function normalizeSpeech(text: string): string {
  let out = ''
  for (const ch of text) out += TRADITIONAL_TO_SIMPLIFIED[ch] ?? ch

  return out
    .replace(/[，。！？、\s]+$/g, '')
    .replace(/＝/g, '等于')
    .replace(/×/g, '乘以')
    .replace(/÷/g, '除以')
}

/** 数学语境下会遇到的繁体字。不求覆盖全部汉字，只覆盖这个场景。 */
const TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
  於: '于', 幾: '几', 負: '负', 點: '点', 減: '减', 個: '个', 與: '与',
  開: '开', 對: '对', 數: '数', 變: '变', 雙: '双', 樣: '样', 麼: '么',
  兩: '两', 陸: '六', 億: '亿', 萬: '万', 積: '积', 餘: '余', 絕: '绝',
  導: '导', 極: '极', 階: '阶', 們: '们', 這: '这', 為: '为', 種: '种',
  過: '过', 後: '后', 現: '现', 時: '时', 間: '间', 問: '问', 題: '题',
  計: '计', 結: '结', 圓: '圆', 週: '周', 來: '来', 說: '说', 請: '请',
  幫: '帮', 號: '号', 級: '级', 總: '总', 單: '单', 複: '复', 實: '实',
  進: '进', 線: '线', 積分: '积分', 減去: '减去',
}
