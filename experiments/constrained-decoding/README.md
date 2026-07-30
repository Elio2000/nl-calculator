# 约束解码实验：把 LLM 拴在规范表达式语言上

现状的表达式约束是三层：JSON 信封（strict schema，采样层硬约束）+ 事后白名单/试算（执行层硬闸）+ prompt 里的文法说明（软引导）。这组实验回答一个问题：**能不能把"载荷"（表达式本身）也拽到采样层？** 两条路线都实测跑通了。

## 方案一：strict 递归 Schema——模型直接建树（DeepSeek，已验证）

`probe-ast-schema.mjs`。表达式不再是字符串参数，而是递归 JSON Schema（节点只有 num/const/op/fn 四种），函数名与算符全是 enum。DeepSeek 的 strict 模式接受递归 `$defs`（2026-07 实测），效果：

- 白名单从"事后检查"前移到"物理不可违反"——`tan2` 这类 token 的采样概率是零；
- **变量被结构性消灭**：schema 里没有符号节点，`a`、`b` 无法表达，模型被迫先消元；
- 优先级长在结构里：`一加二乘三` → `+(1, *(2,3))`，"显式乘号、加满括号"的 prompt 规则全部作废。

代价：token 膨胀约 3–5 倍；小模型在深嵌套 JSON 里语义容易迷路；文本降级路径用不了（没 strict 就没约束）。适合做成能力探测的高档位。

## 方案二：GBNF 真 CFG——llama.cpp 本地（qwen3:8b / qwen2.5:7b，已验证）

`probe-cfg.mjs` + `canonical-expr.gbnf`（10 行文法，结构即优先级，与 `mathEngine.ts` 白名单同源）。请求还是 OpenAI 形状，多一个 llama.cpp 扩展字段 `"grammar"`，采样器逐 token 走自动机。

对照结果（8 用例，temperature 0）：

| | 形式合规 | 语义正确 | 单条延迟 |
|---|---|---|---|
| qwen2.5:7b 无约束 | 7/8 | 7/8 | 175–340ms |
| qwen2.5:7b + CFG | **8/8** | **8/8** | **108–277ms**（掩码剪枝，反而更快） |
| qwen3:8b 无约束 | 6/8（写了非法 `ln`、根号放错位） | 5/8 | 187–577ms |
| qwen3:8b + CFG | **8/8** | 7/8（丢了一个 log） | 116–307ms |
| qwen3:8b + CFG + 思考区 | **8/8** | **8/8** | 稍长 |

（"8/8"里含一条 `factorial(2^10)`：文法合法、被计算预算正确拦截——**文法锁得住语言，锁不住数值大小**，事后闸门必须保留。）

## 三条从实测里撞出来的定律

1. **硬约束必须内置诚实出口，否则约束自己制造幻觉。** 纯表达式文法喂"今天天气不错"，模型被逼出 `sqrt(-1)`；文法加一条 `| "reject"` 产生式后它就选 reject。这条定律出现了三次：`tool_choice:required` → 加 reject 工具；纯 CFG → 加 reject 产生式；思考模型 × 文法 → 加思考区。
2. **形式约束可能挤压出语义错误。** qwen3:8b 想写 `ln` 被文法堵死，没有绕到合法的 `log`，而是滑进"合法但丢了对数"的式子。文法保证输出属于语言，不保证属于本意——人审层（复述/候选卡/「不对」按钮）因此不可撤。对策之一：把高频别名（ln/lg）纳入表面语言、在边界归一（已落进 `llmTools.ts` 的 `normalizeAliases`）。
3. **给约束开思考区可救回语义。** `root ::= "<scratch>" [^<]* "</scratch>" expr`：推理在栅栏外自由发生，答案在栅栏内强制合规——qwen3:8b 丢 log 的用例由此修复，同时化解思考型模型与 grammar 的冲突。

## 落地形态（未合入主干，按需启用）

约束档位 `grammar → ast-tools → tools → text`，逐级能力探测降档；响应侧全部收敛进同一个 `ToolCall` 结构，白名单/预算/试算/候选卡零改动。纪律：solve/diff/integrate 扩进文法时，一份文法源生成 GBNF、JSON-Schema、白名单三个投影，防契约漂移。

## 复跑

```bash
# 方案一（需要 DEEPSEEK_API_KEY 或项目根 .deepseek.key）
node experiments/constrained-decoding/probe-ast-schema.mjs 根号下三的平方加四的平方，再取自然对数

# 方案二（本地，无 key）
brew install llama.cpp && ollama pull qwen3:8b
llama-server -m "$(ollama show qwen3:8b --modelfile | grep -m1 '^FROM' | awk '{print $2}')" --port 8081 -ngl 99 -c 8192 --jinja
node experiments/constrained-decoding/probe-cfg.mjs
```
