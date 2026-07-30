/**
 * 语音识别效果评测。
 *
 * 用 macOS 内置 TTS 合成的中文数学短句，逐档位跑 Whisper，
 * 看识别文本能否被规则引擎解析、算出的答案对不对。
 *
 *   node scripts/eval-voice.mjs           # 默认 small
 *   node scripts/eval-voice.mjs base small turbo
 *
 * 音频用 scripts/make-audio.sh 生成。
 */
import './lib/ts-source-hooks.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pipeline, env } from '@huggingface/transformers'

const { calculate } = await import('../src/core/calculator.ts')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

env.localModelPath = join(root, 'public/models/')
env.allowLocalModels = true
env.allowRemoteModels = true

const MODELS = {
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
}

/**
 * 每条用例除了原话，还记下正确答案。
 *
 * 真正要衡量的不是「识别文本一字不差」——Whisper 把「一加一」写成「1加1」
 * 完全无害，构式层本来就支持中阿混写。要衡量的是**端到端算得对不对**。
 */
const CASES = [
  { file: 'q1.wav', text: '一加一等于几', answer: '2' },
  { file: 'q2.wav', text: '十二减五等于多少', answer: '7' },
  { file: 'q3.wav', text: '三点五乘以负二', answer: '-7' },
  { file: 'q4.wav', text: '根号九是多少', answer: '3' },
  { file: 'q5.wav', text: '二的三次方', answer: '8' },
]

/** 读 16kHz 单声道 WAV 的 PCM 数据。 */
function readWav(path) {
  const buffer = readFileSync(path)
  // 跳过 RIFF 头找 data 块
  let offset = 12
  while (offset < buffer.length - 8) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768
      }
      return samples
    }
    offset += 8 + size
  }
  throw new Error(`${path} 里没有找到 data 块`)
}

const TRADITIONAL = {
  於: '于', 幾: '几', 負: '负', 點: '点', 減: '减', 個: '个', 與: '与',
  開: '开', 對: '对', 數: '数', 兩: '两', 萬: '万', 億: '亿', 積: '积',
  餘: '余', 絕: '绝', 導: '导', 極: '极', 階: '阶', 這: '这', 為: '为',
  過: '过', 後: '后', 時: '时', 間: '间', 問: '问', 題: '题', 計: '计',
  結: '结', 圓: '圆', 來: '来', 說: '说', 請: '请', 幫: '帮', 號: '号',
}

function normalize(text) {
  let out = ''
  for (const ch of text) out += TRADITIONAL[ch] ?? ch
  return out.replace(/[，。！？、\s]+$/g, '')
}

const sizes = process.argv.slice(2).filter((arg) => arg in MODELS)
const targets = sizes.length > 0 ? sizes : ['small']

for (const size of targets) {
  console.log(`\n━━━ ${size} (${MODELS[size]}) ━━━`)

  const started = Date.now()
  const transcribe = await pipeline('automatic-speech-recognition', MODELS[size], {
    device: 'cpu',
    dtype: 'q8',
  })
  console.log(`加载耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

  let exact = 0
  let usable = 0
  for (const testCase of CASES) {
    const path = join(root, 'public/test-audio', testCase.file)
    if (!existsSync(path)) {
      console.log(`  跳过 ${testCase.file}（文件不存在，先跑 scripts/make-audio.sh）`)
      continue
    }

    const t0 = Date.now()
    const result = await transcribe(readWav(path), { language: 'chinese', task: 'transcribe' })
    const got = normalize(result.text.trim())
    const ms = Date.now() - t0

    if (got === testCase.text) exact += 1

    // 端到端：识别文本走完整管道，看算出的数对不对
    let verdict
    try {
      const outcome = await calculate(got)
      if (outcome.kind === 'answer') {
        const value = outcome.answer.formula.split('=').pop().trim()
        const right = value === testCase.answer
        if (right) usable += 1
        verdict = right ? `✓ 算出 ${value}` : `✗ 算出 ${value}（应为 ${testCase.answer}）`
      } else if (outcome.kind === 'candidates') {
        verdict = '? 出候选卡，需人工确认'
      } else {
        verdict = `✗ ${outcome.reason}`
      }
    } catch (error) {
      verdict = `✗ ${error.message}`
    }

    console.log(`  原话「${testCase.text}」`)
    console.log(`  识别「${got}」  ${ms}ms`)
    console.log(`  ${verdict}\n`)
  }

  console.log(`  文本完全一致：${exact}/${CASES.length}`)
  console.log(`  端到端算对　：${usable}/${CASES.length}   ← 这个才是有意义的指标`)
}
