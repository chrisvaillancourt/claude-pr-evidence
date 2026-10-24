import { describe, expect, test } from 'claude-code/testing'

import { bytesOf, coverageGaps, fitEnvelope, shapeDiff, withCollection } from './envelope'
import type { Envelope, Omission } from './envelope'

const H = 'a1'.repeat(20)
const B = 'b2'.repeat(20)

function envelope(extra: Partial<Envelope> = {}): Envelope {
  return {
    schema_version: 1,
    tool: 'pr_evidence',
    identity: { host: 'github.com', repo: 'octo-org/widget', sha: H, pr: 7, resolved_by: 'repo+pr' },
    observed: { started_at: 'x', finished_at: 'y' },
    collection: 'complete',
    sections_requested: ['metadata', 'diff', 'ci', 'logs'],
    metadata: { status: 'ok', body: 'b'.repeat(3000) },
    diff: { status: 'ok', files: [{ filename: 'a', patch: 'p'.repeat(8000) }, { filename: 'b', patch: 'q'.repeat(8000) }] },
    ci: {
      status: 'ok',
      workflows: { state: 'failing', runs: [{ id: 1, class: 'failed' }, ...Array.from({ length: 50 }, (_, i) => ({ id: 10 + i, class: 'passed', name: 'n'.repeat(100) }))] },
      observed_outcome: { state: 'failing', has_pending: false, counts: { passed: 50, neutral: 0, failed: 1, pending: 0, unknown: 0 }, summary: 's' },
      required_checks: 'not_evaluated',
    },
    logs: { status: 'ok', jobs: [{ job_id: 5, job_tail: { lines: ['l'.repeat(3000)] } }] },
    omissions: [],
    errors: [],
    invocations: 3,
    ...extra,
  }
}

describe('fitEnvelope', () => {
  test('a result that fits is unchanged', async () => {
    const e = envelope()
    expect(fitEnvelope(e, 1024 * 1024)).toEqual(e)
  })

  test('drops patches first, then logs, and lists each drop', async () => {
    const e = envelope()
    const f = fitEnvelope(e, bytesOf(e) - 7000)
    expect(bytesOf(f)).toBeLessThanOrEqual(bytesOf(e) - 7000)
    expect((f.diff.files as any[])[1].patch_unavailable).toBe('ceiling_output_bytes')
    expect(f.omissions[0]).toEqual({ section: 'diff', what: 'file patches', count: 1, reason: 'ceiling_output_bytes' })
    expect(e.omissions).toEqual([])
  })

  test('drops passed runs before failing ones, keeping the counts', async () => {
    const f = fitEnvelope(envelope({ diff: { status: 'ok', files: [] }, metadata: { status: 'ok' }, logs: { status: 'ok', jobs: [] } }), 2000)
    expect(bytesOf(f)).toBeLessThanOrEqual(2000)
    expect((f.ci.workflows as any).runs).toEqual([{ id: 1, class: 'failed' }])
    expect((f.ci.observed_outcome as any).counts.passed).toBe(50)
  })

  test('last resort keeps identity, outcome and errors', async () => {
    const f = fitEnvelope(envelope(), 900)
    expect(bytesOf(f)).toBeLessThanOrEqual(900)
    expect(f.identity.sha).toBe(H)
    expect((f.ci.observed_outcome as any).state).toBe('failing')
    expect(f.diff).toEqual({ status: 'omitted', reason: 'ceiling_output_bytes' })
  })
})

describe('shapeDiff', () => {
  test('a missing patch is unavailable, not empty; a long one is cut and flagged', async () => {
    const omissions: Omission[] = []
    const d = shapeDiff({
      merge_base_commit: { sha: B },
      files: [
        { filename: 'bin.png', status: 'added', additions: 0, deletions: 0 },
        { filename: 'big.txt', status: 'modified', additions: 1, deletions: 0, patch: `+${'x'.repeat(10_000)}` },
      ],
    }, { base: B, head: H, changedFiles: 5 }, omissions)!
    const files = d.files as any[]
    expect(files[0]).toEqual({ filename: 'bin.png', status: 'added', additions: 0, deletions: 0, patch_unavailable: 'github_omitted' })
    expect(files[1].patch_truncated).toBe(true)
    expect(files[1].patch.length).toBeLessThanOrEqual(8 * 1024)
    expect(omissions).toContainEqual({ section: 'diff', what: 'files not listed by the compare API', count: 3, reason: 'github_compare_file_limit' })
    expect(shapeDiff({ files: [] }, { base: B, head: H, changedFiles: 0 }, [])).toBe(null)
  })
})

describe('completeness is derived, never asserted', () => {
  const sec = (complete: boolean) => ({ state: complete ? 'passed' : 'inconclusive', complete, has_pending: false, counts: { passed: 1, neutral: 0, failed: 0, pending: 0, unknown: 0 } })
  const base = (over: Partial<Envelope> = {}): Envelope =>
    envelope({ metadata: { status: 'ok' }, diff: { status: 'ok', files: [] }, logs: { status: 'ok', jobs: [] }, ci: { status: 'ok', workflows: { ...sec(true), runs: [] }, checks: sec(true), statuses: sec(true), required_checks: 'not_evaluated' }, ...over })

  test('everything complete and an empty ledger is complete', async () => {
    expect(coverageGaps(base())).toEqual([])
    expect(withCollection(base()).collection).toBe('complete')
  })

  test('an incomplete section with an empty ledger is partial, with an unaccounted_gap error', async () => {
    const e = base({ ci: { status: 'ok', workflows: { ...sec(false), runs: [] }, checks: sec(true), statuses: sec(true), required_checks: 'not_evaluated' } })
    const out = withCollection(e)
    expect(out.collection).toBe('partial')
    expect(out.errors).toEqual([{ section: 'ci.workflows', step: 'coverage', kind: 'unaccounted_gap', message: 'ci.workflows.complete is false and no error or omission says why' }])
  })

  test('a gap its section already accounts for adds nothing', async () => {
    const e = base({ ci: { status: 'ok', workflows: { ...sec(false), runs: [] }, checks: sec(true), statuses: sec(true), required_checks: 'not_evaluated' }, omissions: [{ section: 'ci.workflows', what: 'x', count: 1, reason: 'ceiling_runs' }] })
    const out = withCollection(e)
    expect(out.errors).toEqual([])
    expect(out.collection).toBe('partial')
  })

  test('every kind of gap is found', async () => {
    const e = base({
      metadata: { status: 'no_pr_found', association: { complete: false } },
      diff: { status: 'error' },
      logs: { status: 'ok', jobs: [], runs_not_inspected: [{ run_id: 1 }] },
      ci: { status: 'ok', workflows: { ...sec(true), runs: [{ id: 1, jobs_not_inspected: 'failed_during_collection' }] }, checks: sec(false), statuses: sec(true), required_checks: 'not_evaluated' },
    })
    expect(coverageGaps(e).map(g => g.section).sort()).toEqual(['ci.checks', 'ci.workflows', 'diff', 'logs', 'metadata'])
    expect(withCollection(withCollection(e)).errors.length).toBe(5)
  })

  test('error outranks partial', async () => {
    expect(withCollection(base({ collection: 'error', ci: { status: 'not_collected' } })).collection).toBe('error')
  })
})

describe('coverageGaps reads every truncation marker', () => {
  const ok = { state: 'passed', complete: true, has_pending: false, counts: { passed: 1, neutral: 0, failed: 0, pending: 0, unknown: 0 } }
  const clean = (): Envelope => envelope({ metadata: { status: 'ok', body_truncated: false }, diff: { status: 'ok', files_total: 1, files_listed: 1, files: [{ filename: 'a', patch: 'p' }] }, logs: { status: 'ok', jobs: [] }, ci: { status: 'ok', workflows: { ...ok, runs: [] }, checks: ok, statuses: ok, required_checks: 'not_evaluated' } })
  // [case, change, gap section]
  const rows: [string, (e: any) => void, string][] = [
    ['step tail cut', e => (e.logs.jobs = [{ attribution: 'step', steps: [{ name: 's', lines: [], cut: true }] }]), 'logs'],
    ['job tail cut', e => (e.logs.jobs = [{ attribution: 'step_logs_unavailable', reason: 'unknown_step', job_tail: { lines: [], cut: true } }]), 'logs'],
    ['excerpt cut', e => (e.logs.jobs = [{ attribution: 'step_logs_unavailable', reason: 'unknown_step', error_marker_excerpt: { lines: [], cut: true } }]), 'logs'],
    ['capture truncated', e => (e.logs.jobs = [{ attribution: 'step_logs_unavailable', reason: 'capture_truncated' }]), 'logs'],
    ['log omitted', e => (e.logs.jobs = [{ log_omitted: 'ceiling_logs_bytes' }]), 'logs'],
    ['patch truncated', e => (e.diff.files[0].patch_truncated = true), 'diff'],
    ['patch dropped for a limit', e => (e.diff.files[0].patch_unavailable = 'ceiling_diff_bytes'), 'diff'],
    ['files not listed', e => (e.diff.files_total = 400), 'diff'],
    ['body truncated', e => (e.metadata.body_truncated = true), 'metadata'],
    ['run not in final page', e => (e.ci.workflows.runs = [{ id: 1, listing: 'not_in_final_page' }]), 'ci.workflows'],
    ['section omitted by the last-resort fit', e => (e.diff = { status: 'omitted', reason: 'ceiling_output_bytes' }), 'diff'],
  ]
  test('each marker is a gap in its section', async () => {
    for (const [name, change, section] of rows) {
      const e = clean()
      change(e)
      expect([name, coverageGaps(e).map(g => g.section)]).toEqual([name, [section]])
    }
  })
  test('supported states are not gaps', async () => {
    const e = clean() as any
    e.diff.files[0] = { filename: 'bin.png', patch_unavailable: 'github_omitted' }
    e.logs.jobs = [{ attribution: 'step_logs_unavailable', reason: 'unknown_step', job_tail: { lines: [], cut: false } }]
    e.ci.workflows.runs = [{ id: 1, listing: 'listed', changed_during_collection: true }]
    expect(coverageGaps(e)).toEqual([])
  })
})

