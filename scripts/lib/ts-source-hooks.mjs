/**
 * 让 node 直接跑 src/ 里的 TypeScript 源码，不额外引入一套构建。
 *
 * 两处差异要补：src 内部的相对 import 不写扩展名（按 vite 的解析规则写的），
 * node 的 ESM 解析器不认；`lexicon.json` 还需要 import attributes。
 * 一对同步 hook 解决，评测脚本就能跟应用跑同一份代码——这正是它们的意义所在。
 *
 * 这是个副作用模块：import 即注册。**必须在动态 import 任何 src/ 源码之前生效**，
 * 静态 import 它一次即可（静态导入先于模块体执行，顺序天然满足）。
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context)
      } catch {
        // 加 .ts 也找不到，就交回默认解析，让它报本来该报的错
      }
    }
    const resolved = next(specifier, context)
    return resolved.url.endsWith('.json')
      ? { ...resolved, importAttributes: { type: 'json' } }
      : resolved
  },
})
