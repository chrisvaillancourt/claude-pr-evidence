import { describe, expect, test } from 'claude-code/testing'

import { bytesOf, fitEnvelope, shapeDiff } from './envelope'
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
