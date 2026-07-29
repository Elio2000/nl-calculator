import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

interface Props {
  /** 完整算式的 LaTeX，含等号与结果。 */
  tex: string
  /** 纯文本兜底，LaTeX 渲染失败或为空时显示。 */
  fallback: string
}

/**
 * 算式回显。
 *
 * 渲染成真正的数学排版而不是代码：分数有分数线、根号有根号、上标是上标——
 * 用户要一眼确认系统有没有理解对自己的话，`\frac{1}{3}` 比 `1/3` 快得多。
 */
export function Formula({ tex, fallback }: Props) {
  const html = useMemo(() => {
    if (!tex) return null
    try {
      return katex.renderToString(tex, {
        displayMode: false,
        throwOnError: false,
        output: 'html',
      })
    } catch {
      return null
    }
  }, [tex])

  if (!html) {
    return <code className="formula formula--plain">{fallback}</code>
  }

  return (
    <div className="formula" title={fallback}>
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
