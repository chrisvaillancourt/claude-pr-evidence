import { describe, expect, test } from 'claude-code/testing'

import { classifyConclusion, classifyStatusState, overallOutcome, sectionState } from './outcome'
import type { Cls, Section } from './outcome'

describe('conclusion classes', () => {
  // [status, conclusion, class]: the README's "Classes" paragraph, row by row.
  const rows: [string | null, string | null, Cls][] = [
    ['completed', 'success', 'passed'],
    ['completed', 'neutral', 'neutral'],
    ['completed', 'skipped', 'neutral'],
    ['completed', 'failure', 'failed'],
    ['completed', 'timed_out', 'failed'],
    ['completed', 'cancelled', 'failed'],
    ['completed', 'startup_failure', 'failed'],
    ['completed', 'action_required', 'failed'],
    ['completed', 'stale', 'failed'],
    ['completed', null, 'unknown'],
    ['completed', 'something_new', 'unknown'],
    ['queued', null, 'pending'],
    ['in_progress', null, 'pending'],
    ['waiting', null, 'pending'],
    ['requested', null, 'pending'],
    ['pending', null, 'pending'],
    [null, null, 'unknown'],
  ]
  test('runs and check runs', async () => {
    for (const [status, conclusion, cls] of rows) expect([status, conclusion, classifyConclusion(status, conclusion)]).toEqual([status, conclusion, cls])
  })
  test('legacy status states', async () => {
    expect(['success', 'failure', 'error', 'pending', 'weird', null].map(classifyStatusState)).toEqual(['passed', 'failed', 'failed', 'pending', 'unknown', 'unknown'])
  })
})

const ok = (classes: Cls[], extra: Partial<{ total: number; complete: boolean }> = {}) =>
  ({ error: false, total: extra.total ?? classes.length, classes, complete: extra.complete ?? true })

describe('section states', () => {
  test('rule 1: zero Actions runs is no_workflows, never passed', async () => {
    expect(sectionState(ok([]), 'workflows').state).toBe('no_workflows')
  })
  test('rule 6: an empty legacy status is none, not pending', async () => {
    const s = sectionState(ok([]), 'statuses')
    expect(s.state).toBe('none')
    expect(s.counts.pending).toBe(0)
  })
  test('rule 2: pending stays explicit, also next to a failure', async () => {
    expect(sectionState(ok(['passed', 'pending']), 'workflows')).toMatchObject({ state: 'pending', has_pending: true })
    const both = sectionState(ok(['failed', 'pending', 'passed']), 'workflows')
    expect(both).toMatchObject({ state: 'failing', has_pending: true, counts: { failed: 1, pending: 1, passed: 1, neutral: 0, unknown: 0 } })
  })
  test('rule 3: unknown or incomplete is inconclusive', async () => {
    expect(sectionState(ok(['passed', 'unknown']), 'checks').state).toBe('inconclusive')
    expect(sectionState(ok(['passed'], { total: 101, complete: false }), 'workflows').state).toBe('inconclusive')
    expect(sectionState({ error: true, total: 0, classes: [], complete: false }, 'workflows').state).toBe('error')
  })
  test('rule 4: all skipped or neutral is skipped_only', async () => {
    expect(sectionState(ok(['neutral', 'neutral']), 'workflows').state).toBe('skipped_only')
    expect(sectionState(ok(['neutral', 'passed']), 'workflows').state).toBe('passed')
  })
})

const sec = (state: Section['state'], counts: Partial<Section['counts']> = {}): Section => ({
  state,
  complete: state !== 'error' && state !== 'inconclusive',
  has_pending: (counts.pending ?? 0) > 0,
  counts: { passed: 0, neutral: 0, failed: 0, pending: 0, unknown: 0, ...counts },
})

describe('overall outcome', () => {
  test('rule 5: a known failure stays visible when other sections failed', async () => {
    const o = overallOutcome({ workflows: sec('error'), checks: sec('failing', { failed: 1 }), statuses: sec('error') })
    expect(o.state).toBe('failing')
    expect(o.counts.failed).toBe(1)
  })
  test('a legacy status failure fails the whole when Actions pass', async () => {
    expect(overallOutcome({ workflows: sec('passed', { passed: 3 }), checks: sec('passed', { passed: 3 }), statuses: sec('failing', { failed: 1 }) }).state).toBe('failing')
  })
  test('pending beats inconclusive and keeps the failure count', async () => {
    expect(overallOutcome({ workflows: sec('pending', { pending: 1, passed: 1 }), checks: sec('error'), statuses: sec('none') }).state).toBe('pending')
    const o = overallOutcome({ workflows: sec('failing', { failed: 1, pending: 2 }), checks: sec('passed', { passed: 1 }), statuses: sec('none') })
    expect(o).toMatchObject({ state: 'failing', has_pending: true, counts: { failed: 1, pending: 2 } })
  })
  test('any errored or incomplete section without failures is inconclusive', async () => {
    expect(overallOutcome({ workflows: sec('passed', { passed: 2 }), checks: sec('error'), statuses: sec('none') }).state).toBe('inconclusive')
    expect(overallOutcome({ workflows: sec('not_collected'), checks: sec('passed', { passed: 1 }), statuses: sec('none') }).state).toBe('inconclusive')
  })
  test('nothing at all is no_workflows; external checks alone can pass', async () => {
    expect(overallOutcome({ workflows: sec('no_workflows'), checks: sec('none'), statuses: sec('none') }).state).toBe('no_workflows')
    expect(overallOutcome({ workflows: sec('no_workflows'), checks: sec('passed', { passed: 1 }), statuses: sec('none') }).state).toBe('observed_passed')
  })
  test('rule 4 and 7 overall: skipped_only, and observed_passed says nothing about merging', async () => {
    expect(overallOutcome({ workflows: sec('skipped_only', { neutral: 2 }), checks: sec('skipped_only', { neutral: 2 }), statuses: sec('none') }).state).toBe('skipped_only')
    const o = overallOutcome({ workflows: sec('passed', { passed: 2 }), checks: sec('passed', { passed: 2 }), statuses: sec('passed', { passed: 1 }) })
    expect(o.state).toBe('observed_passed')
    expect(o.summary).toContain('not a merge decision')
  })
})
