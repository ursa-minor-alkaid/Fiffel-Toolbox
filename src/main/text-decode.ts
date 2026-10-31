/**
 * 外部程序（如 es.exe）多按系统 ANSI 代码页输出，中文 Windows 即 GBK。
 * 这里先按 UTF-8 解，出现替换字符再回退 GBK，避免依赖 TextDecoder 的 fatal 标记。
 */
export function decodeOutput(chunk: Buffer | string | undefined): string {
  if (!chunk) return ''
  if (typeof chunk === 'string') return chunk

  if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
    const body = chunk.subarray(3).toString('utf-8')
    return body.includes('\uFFFD') ? decodeGbk(chunk.subarray(3), body) : body
  }

  const utf8 = new TextDecoder('utf-8').decode(chunk)
  if (!utf8.includes('\uFFFD')) return utf8

  return decodeGbk(chunk, utf8)
}

function decodeGbk(chunk: Buffer, fallback: string): string {
  try {
    const gbk = new TextDecoder('gbk').decode(chunk)
    return gbk.includes('\uFFFD') ? fallback : gbk
  } catch {
    return fallback
  }
}
