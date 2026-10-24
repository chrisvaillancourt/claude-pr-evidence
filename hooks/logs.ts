// The `gh run view --log-failed` parser. Pure: no `$`, no I/O.
//
// gh prints `job<TAB>step<TAB>line`. A failed step's tail is returned only when
// the attribution is reliable (README "Logs"); otherwise the job gets
// `step_logs_unavailable` with two clearly labelled fallbacks.
import { classifyConclusion } from './outcome'
import { stripControls, tailLines } from './text'

export type StepInfo = { number: number; name: string; conclusion: string | null }
export type StepTail = { number: number; name: string; lines: string[]; lines_total: number; cut: boolean }
export type ParsedLog = {
  attribution: 'step' | 'step_logs_unavailable'
  reason?: string
  steps?: StepTail[]
  job_tail?: { label: string; lines: string[]; lines_total: number; cut: boolean }
  error_marker_excerpt?: { label: string; lines: string[]; error_lines: string[] }
}

export const LOG_LIMITS = { lines: 30, bytes: 4096, width: 400, errorLines: 10, excerptLookback: 200 }

export const JOB_TAIL_LABEL =
  'Last lines of the whole failed-job log, not attributed to a step. Cleanup steps that ran after the failure can fill it.'
export const EXCERPT_LABEL =
  "Lines from the last '##[group]Run' marker before GitHub's first '##[error]' marker, up to that marker. GitHub's own markers, not a step attribution."

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/

/** One log line's text: BOM, timestamp and terminal controls removed. */
function clean(rest: string): string {
  return stripControls(rest.replace(/^\ufeff/, '').replace(TIMESTAMP, ''))
}

type Line = { job: string; step: string; text: string }

export function parseFailedLog(input: { text: string; truncated: boolean; jobName: string; steps: readonly StepInfo[] }): ParsedLog {
  if (input.truncated) return { attribution: 'step_logs_unavailable', reason: 'capture_truncated' }
  const raw = input.text.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  if (raw.length === 0) return { attribution: 'step_logs_unavailable', reason: 'empty_log' }

  const parsed: Line[] = []
  let unparsed = 0
  for (const r of raw) {
    const a = r.indexOf('\t')
    const b = a < 0 ? -1 : r.indexOf('\t', a + 1)
    if (b < 0) {
      unparsed++
      parsed.push({ job: '', step: '', text: clean(r) })
      continue
    }
    parsed.push({ job: r.slice(0, a), step: r.slice(a + 1, b), text: clean(r.slice(b + 1)) })
  }

  const reason = unreliable(parsed, unparsed, input)
  if (reason === null) {
    const failed = input.steps.filter(s => classifyConclusion('completed', s.conclusion) === 'failed')
    const steps = failed.map(s => {
      const own = parsed.filter(l => l.step === s.name).map(l => l.text)
      const t = tailLines(own, LOG_LIMITS.lines, LOG_LIMITS.bytes, LOG_LIMITS.width)
      return { number: s.number, name: s.name, lines: t.lines, lines_total: t.total, cut: t.cut }
    })
    return { attribution: 'step', steps }
  }

  const all = parsed.map(l => l.text)
  const tail = tailLines(all, LOG_LIMITS.lines, LOG_LIMITS.bytes, LOG_LIMITS.width)
  const out: ParsedLog = {
    attribution: 'step_logs_unavailable',
    reason,
    job_tail: { label: JOB_TAIL_LABEL, lines: tail.lines, lines_total: tail.total, cut: tail.cut },
  }
  const excerpt = errorMarkerExcerpt(all)
  if (excerpt) out.error_marker_excerpt = excerpt
  return out
}

function unreliable(parsed: readonly Line[], unparsed: number, input: { jobName: string; steps: readonly StepInfo[] }): string | null {
  if (parsed.some(l => l.step === 'UNKNOWN STEP')) return 'unknown_step'
  if (unparsed > 0) return 'unparsed_lines'
  if (parsed.some(l => l.job !== input.jobName)) return 'job_name_mismatch'
  const failed = input.steps.filter(s => classifyConclusion('completed', s.conclusion) === 'failed')
  if (failed.length === 0) return 'no_failed_step_in_job'
  for (const s of failed) {
    if (input.steps.filter(o => o.name === s.name).length !== 1) return 'duplicate_step_name'
  }
  const present = new Set(parsed.map(l => l.step))
  for (const s of failed) if (!present.has(s.name)) return 'failed_step_missing_from_log'
  return null
}

function errorMarkerExcerpt(lines: readonly string[]): ParsedLog['error_marker_excerpt'] | undefined {
  const first = lines.findIndex(l => l.includes('##[error]'))
  if (first < 0) return undefined
  let start = Math.max(0, first - LOG_LIMITS.lines + 1)
  for (let i = first - 1; i >= 0 && i >= first - LOG_LIMITS.excerptLookback; i--) {
    if (lines[i]!.startsWith('##[group]Run ')) {
      start = i
      break
    }
  }
  const t = tailLines(lines.slice(start, first + 1), LOG_LIMITS.lines, LOG_LIMITS.bytes, LOG_LIMITS.width)
  const errors = lines.filter(l => l.includes('##[error]'))
  const errorTail = tailLines(errors.slice(0, LOG_LIMITS.errorLines), LOG_LIMITS.errorLines, 1024, LOG_LIMITS.width)
  return { label: EXCERPT_LABEL, lines: t.lines, error_lines: errorTail.lines }
}
