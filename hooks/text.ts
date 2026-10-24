// Text helpers for untrusted GitHub text (PR body, patches, logs). Pure.

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC = /\x1b[@-_]?/g
// C0 except tab and newline, DEL, C1, bidi embeddings/overrides/isolates, BOM.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Removes terminal control sequences and invisible controls; keeps tabs and newlines. */
export function stripControls(s: string): string {
  return s.replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(/\r\n?/g, m => (m === '\r\n' ? '\n' : '')).replace(CONTROL, '')
}

/** The UTF-8 length of `s` in bytes. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** `s` cut to at most `max` UTF-16 units without splitting a surrogate pair, marked with an ellipsis. */
export function cutText(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false }
  let end = max
  const c = s.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return { text: `${s.slice(0, end)}…`, cut: true }
}

/** `s` cut to at most `maxBytes` UTF-8 bytes at a line boundary when one is near. */
export function cutBytes(s: string, maxBytes: number): { text: string; cut: boolean } {
  if (utf8Bytes(s) <= maxBytes) return { text: s, cut: false }
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (utf8Bytes(s.slice(0, mid)) <= maxBytes - 3) lo = mid
    else hi = mid - 1
  }
  let text = s.slice(0, lo)
  const c = text.charCodeAt(text.length - 1)
  if (c >= 0xd800 && c <= 0xdbff) text = text.slice(0, -1)
  const nl = text.lastIndexOf('\n')
  if (nl > text.length / 2) text = text.slice(0, nl + 1)
  return { text: `${text}…`, cut: true }
}

/** The last lines of `lines`: at most `count` lines, `maxBytes` bytes joined, each at most `width` characters. */
export function tailLines(lines: readonly string[], count: number, maxBytes: number, width: number): { lines: string[]; total: number; cut: boolean } {
  let cut = lines.length > count
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    const c = cutText(lines[i]!, width)
    const b = utf8Bytes(c.text) + (out.length > 0 ? 1 : 0)
    if (bytes + b > maxBytes) {
      cut = true
      break
    }
    if (c.cut) cut = true
    bytes += b
    out.push(c.text)
  }
  if (out.length < lines.length) cut = true
  return { lines: out.reverse(), total: lines.length, cut }
}
