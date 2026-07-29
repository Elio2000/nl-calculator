# 引用与致谢

> Apache-2.0 第 4(d) 条要求随分发保留 NOTICE，完整声明见仓库根目录的 [NOTICE](NOTICE) 文件。

这个项目的**计算能力全部来自开源项目**。我们做的是把中文口语翻译成它们已经能理解的表达式，算数由它们完成。

下面逐项说明用了谁的什么、许可证是什么。

## 直接依赖（代码进入了产物）

| 项目 | 版本 | 许可证 | 版权 | 我们用它做什么 |
|---|---|---|---|---|
| [mathjs](https://github.com/josdejong/mathjs) | 15.2.0 | Apache-2.0 | Jos de Jong (2013-2026) | **主计算引擎**。表达式解析、四则与科学函数、BigNumber 高精度、Fraction 精确分数、Complex 复数、`toTex` 公式渲染。我们的「规范表达式」就是 mathjs 语法的一个白名单子集 |
| [nerdamer-prime](https://github.com/together-science/nerdamer-prime) | 1.5.0 | MIT | Martin Donk (2015)、together-science (2023) | **方程与微积分**。`solve` 解方程、`diff` 求导、`integrate` 积分。惰性加载，只在用到时才拉进来 |
| [nzh](https://github.com/cnwhy/nzh) | 1.0.14 | BSD-2-Clause | cnwhy | 数字转中文（回答生成）。只用这一个方向，解析方向我们自研——原因见 README |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.18.1 | MIT | KaTeX contributors | 算式回显的数学排版 |
| [Transformers.js](https://github.com/huggingface/transformers.js) | 4.2.0 | Apache-2.0 | Hugging Face | 浏览器里跑 Whisper 语音识别 |

## 移植的规则（代码是我们写的，规则来自它们）

| 项目 | 许可证 | 我们移植了什么 |
|---|---|---|
| [cn2an](https://github.com/Ailln/cn2an) | MIT | **中文数字解析的全套规则**：数字/单位映射表、补零补一的归一化正则、倒序位置累加算法、口语省略补位（一万二→12000）、量词消歧。用 TypeScript 重写，约 400 行。**它的测试集也一并移植了**，包括 9 条必须抛错的负例 |

移植而非直接依赖的原因：cn2an 是 Python 库，前端用不了；而且我们需要它「非法输入抛错不猜」的行为，这正是它最有价值的设计。

## 模型

| 模型 | 许可证 | 用途 |
|---|---|---|
| [Whisper](https://github.com/openai/whisper)（base / small / large-v3-turbo） | MIT | 语音识别。ONNX 版本来自 [Xenova](https://huggingface.co/Xenova) 与 [onnx-community](https://huggingface.co/onnx-community) 的转换 |
| [DeepSeek](https://api-docs.deepseek.com/)（v4-flash / v4-pro） | 商业 API（模型权重不随项目分发） | 自然语言→表达式翻译的**默认后端**。通过 OpenAI 兼容接口调用，凭据只在服务端 |
| [Qwen2.5](https://github.com/QwenLM/Qwen2.5)（1.5B / 7B） | Apache-2.0 | 同一职责的**离线备选**，通过 Ollama 本地运行 |

翻译后端没有绑定任何一家：`src/services/llm.ts` 只用 OpenAI 兼容的 `/chat/completions` +
function calling，换成任意兼容服务只需在设置里改地址和模型名。选 DeepSeek 作默认是因为它便宜、
中文好、且接口允许跨域（BYOK 直连也能用）。

## 只作为设计参考（没有使用其代码）

调研阶段读了 12 个开源计算器的源码。以下项目的**设计思想**影响了架构，但没有复制代码：

| 项目 | 借鉴了什么 | 为什么没直接用 |
|---|---|---|
| [libqalculate](https://github.com/Qalculate/libqalculate) | 百分号语义规格（`tests/percentages.batch` 的行为表）、自然语言运算符的词表设计 | GPL 传染性许可 + C++ 无 WASM 构建 |
| [NoteCalc](https://github.com/bbodi/notecalc3) | 「带类型词法 → 优先级解析 → 十进制求值」的三段式架构 | AGPL：Web 部署即触发全量开源义务 |
| [notepad-based-calculator](https://github.com/veler/notepad-based-calculator) | **词形算符表做成 JSON 数据**、模板与输入共用同一分词器、噪声词可控跳过 | C#/MEF 上 Web 成本高；且用 `double` 算钱有精度缺陷 |
| [SoulverCore](https://github.com/soulverteam/SoulverCore) | 「多语言叠加而非替换」（中文用户可中英混用语法）；它是唯一已上市的中文自然语言计算器，作为需求基线 | 闭源二进制 + 商业授权 |
| [SymPy Gamma](https://github.com/sympy/sympy_gamma) | **规范形与显示形分离**（送引擎执行的串 vs 回显给用户确认的串）、按结果类型派发展示卡 | Python 服务端；且它的自然语言层是烂尾死代码 |
| [recomputer](https://github.com/xixixao/recomputer) | 变量名允许任意字符的思路 | 仓库无 LICENSE 文件，法律上不可用 |
| [Algebrite](https://github.com/davidedc/Algebrite) | — | 停更 4 年；小数走 double 导致精度问题 |
| [numr](https://github.com/nasedkinpv/numr) | — | Rust，且自然语言能力仅存在于测试注释里 |
| [@microsoft/recognizers-text](https://github.com/microsoft/Recognizers-Text) | 作为中文数字解析的**对照基准**（20 条用例实测） | 3.6MB 通用 NLP 库；会静默猜测；分数转浮点丢精度 |

## 一句话总结分工

```
中文口语  ──我们写的──▶  规范表达式  ──mathjs / nerdamer──▶  结果
          翻译层                        计算层
       （自研 + LLM）                （全部开源项目）
```

**我们没有实现任何一个数学算法。** 加减乘除、三角函数、高精度、复数、解方程、求导积分，全部是上面这些项目的能力。这个项目的贡献是中间那道翻译，以及围绕它的一套「不给出错误答案」的工程保证。
