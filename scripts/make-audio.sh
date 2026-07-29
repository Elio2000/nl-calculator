#!/bin/bash
# 用 macOS 内置中文 TTS 合成测试音频，供 eval-voice.mjs 使用。
# 需要 ffmpeg 转成 Whisper 要的 16kHz 单声道 WAV。
set -e

cd "$(dirname "$0")/.."
mkdir -p public/test-audio

declare -a CASES=(
  "q1:一加一等于几"
  "q2:十二减五等于多少"
  "q3:三点五乘以负二"
  "q4:根号九是多少"
  "q5:二的三次方"
)

for entry in "${CASES[@]}"; do
  name="${entry%%:*}"
  text="${entry#*:}"
  say -v Tingting -o "public/test-audio/$name.aiff" "$text"
  ffmpeg -loglevel error -y -i "public/test-audio/$name.aiff" \
    -ar 16000 -ac 1 "public/test-audio/$name.wav"
  rm "public/test-audio/$name.aiff"
  echo "✓ $name  $text"
done
