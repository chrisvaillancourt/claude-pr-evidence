// The outcome rules (README "Outcome rules"). Pure: no `$`, no I/O.
export type Cls = 'passed' | 'neutral' | 'failed' | 'pending' | 'unknown'
export type Counts = Record<Cls, number>
export type SectionName = 'workflows' | 'checks' | 'statuses'
export type Section = {
  state: 'error' | 'not_collected' | 'not_requested' | 'none' | 'no_workflows' | 'failing' | 'pending' | 'inconclusive' | 'skipped_only' | 'passed'
  /** Every item GitHub has for the SHA was read, without error. */
  complete: boolean
  has_pending: boolean
  counts: Counts
}
export type Overall = {
  state: 'not_requested' | 'failing' | 'pending' | 'inconclusive' | 'no_workflows' | 'skipped_only' | 'observed_passed'
  has_pending: boolean
  counts: Counts
  summary: string
}
/** What a section's discovery produced: `total` is GitHub's count, `classes` the items read. */
export type SectionInput = { error: boolean; total: number; classes: Cls[]; complete: boolean }

const PASSED = new Set(['success'])
const NEUTRAL = new Set(['neutral', 'skipped'])
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale'])
const PENDING_STATUS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

export const zeroCounts = (): Counts => ({ passed: 0, neutral: 0, failed: 0, pending: 0, unknown: 0 })

/** A workflow run's or a check run's class from its `status` and `conclusion`. */
export function classifyConclusion(status: string | null, conclusion: string | null): Cls {
  if (status !== 'completed') return status !== null && PENDING_STATUS.has(status) ? 'pending' : 'unknown'
  if (conclusion === null) return 'unknown'
  if (PASSED.has(conclusion)) return 'passed'
  if (NEUTRAL.has(conclusion)) return 'neutral'
  if (FAILED.has(conclusion)) return 'failed'
  return 'unknown'
}

/** A legacy commit status context's class from its `state`. */
export function classifyStatusState(state: string | null): Cls {
  if (state === 'success') return 'passed'
  if (state === 'failure' || state === 'error') return 'failed'
  if (state === 'pending') return 'pending'
  return 'unknown'
}

export function countClasses(classes: readonly Cls[]): Counts {
  const c = zeroCounts()
  for (const k of classes) c[k]++
  return c
}

export function sectionState(s: SectionInput, name: SectionName): Section {
  const counts = countClasses(s.classes)
  const has_pending = counts.pending > 0
  if (s.error && s.classes.length === 0) return { state: 'error', complete: false, has_pending, counts }
  const complete = s.complete && !s.error && s.classes.length >= s.total
  let state: Section['state']
  if (counts.failed > 0) state = 'failing'
  else if (has_pending) state = 'pending'
  else if (!complete || counts.unknown > 0) state = 'inconclusive'
  else if (s.total === 0) state = name === 'workflows' ? 'no_workflows' : 'none'
  else if (counts.passed === 0) state = 'skipped_only'
  else state = 'passed'
  return { state, complete, has_pending, counts }
}

export function notCollected(state: 'not_collected' | 'not_requested' | 'error'): Section {
  return { state, complete: false, has_pending: false, counts: zeroCounts() }
}

const UNSETTLED = new Set<Section['state']>(['error', 'not_collected', 'not_requested', 'inconclusive'])

export function overallOutcome(s: Record<SectionName, Section>): Overall {
  const all = [s.workflows, s.checks, s.statuses]
  const counts = zeroCounts()
  for (const sec of all) for (const k of Object.keys(counts) as Cls[]) counts[k] += sec.counts[k]
  const has_pending = counts.pending > 0
  let state: Overall['state']
  if (counts.failed > 0) state = 'failing'
  else if (has_pending) state = 'pending'
  else if (all.some(x => UNSETTLED.has(x.state) || !x.complete)) state = 'inconclusive'
  else if (s.workflows.state === 'no_workflows' && s.checks.state === 'none' && s.statuses.state === 'none') state = 'no_workflows'
  else if (counts.passed === 0) state = 'skipped_only'
  else state = 'observed_passed'
  return { state, has_pending, counts, summary: summaryOf(state, counts) }
}

function summaryOf(state: Overall['state'], c: Counts): string {
  const tally = `${c.failed} failed, ${c.pending} pending, ${c.passed} passed, ${c.neutral} skipped or neutral, ${c.unknown} unknown`
  switch (state) {
    case 'failing':
      return `Failing: ${tally}.${c.pending > 0 ? ' Some work is still running.' : ''}`
    case 'pending':
      return `Pending: ${tally}. CI has not finished for this commit.`
    case 'inconclusive':
      return `Inconclusive: ${tally}. Some CI evidence is missing, incomplete or unclassified; this is not a pass.`
    case 'no_workflows':
      return 'No Actions runs, check runs or commit statuses exist for this commit. Nothing was tested; this is not a pass.'
    case 'skipped_only':
      return `Only skipped or neutral results (${tally}). Nothing passed.`
    case 'observed_passed':
      return `Every observed item passed (${tally}). Required checks were not evaluated; this is not a merge decision.`
    default:
      return 'CI was not requested.'
  }
}
