// Text helpers for untrusted GitHub text (PR body, patches, logs). Pure.

// C0 except tab and newline (CR goes too), DEL, C1, bidi embeddings/overrides/isolates, BOM.
function isDropped(c: number): boolean {
  return (c <= 0x1f && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff
}

/**
 * Removes terminal control sequences and invisible controls; keeps tabs and newlines.
 *
 * One forward pass, no regex: untrusted logs can hold any byte pattern, and a
 * backtracking matcher on repeated unterminated sequences went quadratic (a
 * 200 KB line wedged the hooks worker). Every scan stops at the next ESC, so
 * each character is looked at a bounded number of times.
 *
 * - CSI `ESC [ params intermediates final` is dropped whole; an invalid or
 *   unfinished one drops only `ESC [`.
 * - String sequences (OSC `ESC ]`, DCS `ESC P`, SOS `ESC X`, PM `ESC ^`, APC
 *   `ESC _`) are dropped through their BEL or `ESC \\` terminator. Another ESC
 *   inside ends one there (as a terminal does); one that reaches the end of the
 *   text drops only its two-character introducer and keeps the text.
 * - Any other `ESC x` (x in @..._) drops both; a lone ESC drops.
 */
export function stripControls(s: string): string {
  const n = s.length
  let out = ''
  let from = 0
  let i = 0
  const emitTo = (end: number) => {
    if (end > from) out += s.slice(from, end)
  }
  while (i < n) {
    const c = s.charCodeAt(i)
    if (c === 0x1b) {
      emitTo(i)
      const x = i + 1 < n ? s.charCodeAt(i + 1) : -1
      if (x === 0x5b) {
        // CSI
        let j = i + 2
        while (j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++
        while (j < n && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
        const f = j < n ? s.charCodeAt(j) : -1
        i = f >= 0x40 && f <= 0x7e ? j + 1 : i + 2
      } else if (x === 0x5d || x === 0x50 || x === 0x58 || x === 0x5e || x === 0x5f) {
        // String sequence: scan to BEL, ESC \\, another ESC, or the end.
        let j = i + 2
        while (j < n) {
          const d = s.charCodeAt(j)
          if (d === 0x07 || d === 0x1b) break
          j++
        }
        if (j >= n) i = i + 2
        else if (s.charCodeAt(j) === 0x07) i = j + 1
        else if (j + 1 < n && s.charCodeAt(j + 1) === 0x5c) i = j + 2
        else i = j
      } else if (x >= 0x40 && x <= 0x5f) i = i + 2
      else i = i + 1
      from = i
      continue
    }
    if (isDropped(c)) {
      emitTo(i)
      from = i + 1
    }
    i++
  }
  emitTo(n)
  return out
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
