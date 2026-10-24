// Shaping GitHub JSON into the result's sections, and fitting the result to its
// size limit. Pure: no `$`, no I/O.
import { classifyConclusion, classifyStatusState } from './outcome'
import type { Cls, Overall, Section } from './outcome'
import { CEILINGS } from './policy'
import { cutBytes, stripControls, utf8Bytes } from './text'
import type { ParsedLog, StepInfo } from './logs'

type O = Record<string, unknown>

export const isObj = (v: unknown): v is O => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
const clean = (v: unknown): string | null => (typeof v === 'string' ? stripControls(v) : null)
const at = (o: unknown, ...path: string[]): unknown => {
  let cur = o
  for (const p of path) cur = isObj(cur) && Object.hasOwn(cur, p) ? cur[p] : undefined
  return cur
}

export type Omission = { section: string; what: string; count: number | 'unknown'; reason: string }
export type ErrorEntry = { section: string; step: string; kind: string; message: string }

// ---- pull requests -----------------------------------------------------------

export type PullFacts = { number: number; headSha: string; baseSha: string; baseRepo: string; changedFiles: number | null }

/** The facts resolution needs from a `pulls/N` (or `commits/H/pulls` item) payload, or null when it isn't one. */
export function pullFacts(v: unknown): PullFacts | null {
  const number = int(at(v, 'number'))
  const headSha = str(at(v, 'head', 'sha'))
  const baseSha = str(at(v, 'base', 'sha'))
  const baseRepo = str(at(v, 'base', 'repo', 'full_name'))
  if (number === null || headSha === null || baseSha === null || baseRepo === null) return null
  return { number, headSha, baseSha, baseRepo, changedFiles: int(at(v, 'changed_files')) }
}

export function shapeMetadata(v: unknown, omissions: Omission[]): O {
  const body = clean(at(v, 'body')) ?? ''
  const cut = cutBytes(body, CEILINGS.bodyBytes)
  if (cut.cut) omissions.push({ section: 'metadata', what: 'PR body bytes', count: utf8Bytes(body) - utf8Bytes(cut.text), reason: 'ceiling_body_bytes' })
  const side = (k: 'head' | 'base') => ({ ref: clean(at(v, k, 'ref')), sha: str(at(v, k, 'sha')), repo: str(at(v, k, 'repo', 'full_name')) })
  const head = side('head')
  const base = side('base')
  return {
    status: 'ok',
    number: int(at(v, 'number')),
    title: clean(at(v, 'title')),
    state: str(at(v, 'state')),
    draft: at(v, 'draft') === true,
    merged: at(v, 'merged') === true,
    merged_at: str(at(v, 'merged_at')),
    author: clean(at(v, 'user', 'login')),
    html_url: str(at(v, 'html_url')),
    base,
    head,
    is_cross_repository: head.repo !== null && base.repo !== null && head.repo !== base.repo,
    commits: int(at(v, 'commits')),
    changed_files: int(at(v, 'changed_files')),
    additions: int(at(v, 'additions')),
    deletions: int(at(v, 'deletions')),
    created_at: str(at(v, 'created_at')),
    updated_at: str(at(v, 'updated_at')),
    body: cut.text,
    body_truncated: cut.cut,
    note: 'PR metadata is as it is now, not as it was at an older commit.',
  }
}

// ---- diff ----------------------------------------------------------------------

export function shapeDiff(v: unknown, ids: { base: string; head: string; changedFiles: number | null }, omissions: Omission[]): O | null {
  const files = at(v, 'files')
  const mergeBase = str(at(v, 'merge_base_commit', 'sha'))
  if (!Array.isArray(files) || mergeBase === null) return null
  let budget = CEILINGS.diffBytes
  let patchesOmitted = 0
  let patchesCut = 0
  const out = files.map((f): O => {
    const entry: O = {
      filename: clean(at(f, 'filename')),
      status: str(at(f, 'status')),
      additions: int(at(f, 'additions')),
      deletions: int(at(f, 'deletions')),
    }
    const prev = clean(at(f, 'previous_filename'))
    if (prev !== null) entry.previous_filename = prev
    const patch = clean(at(f, 'patch'))
    if (patch === null) {
      entry.patch_unavailable = 'github_omitted'
      return entry
    }
    if (budget < 256) {
      entry.patch_unavailable = 'ceiling_diff_bytes'
      patchesOmitted++
      return entry
    }
    const c = cutBytes(patch, Math.min(CEILINGS.patchBytes, budget))
    budget -= utf8Bytes(c.text)
    entry.patch = c.text
    if (c.cut) {
      entry.patch_truncated = true
      patchesCut++
    }
    return entry
  })
  if (patchesOmitted > 0) omissions.push({ section: 'diff', what: 'file patches', count: patchesOmitted, reason: 'ceiling_diff_bytes' })
  if (patchesCut > 0) omissions.push({ section: 'diff', what: 'file patches cut short', count: patchesCut, reason: 'ceiling_patch_bytes' })
  const total = ids.changedFiles ?? files.length
  if (total > files.length) omissions.push({ section: 'diff', what: 'files not listed by the compare API', count: total - files.length, reason: 'github_compare_file_limit' })
  return {
    status: 'ok',
    kind: 'frozen_comparison',
    note: "GitHub's compare of base...head (merge base to head) at these exact SHAs; per-file patches, not a verbatim unified diff.",
    base_sha: ids.base,
    merge_base_sha: mergeBase,
    head_sha: ids.head,
    files_total: total,
    files_listed: files.length,
    files: out,
  }
}

// ---- CI ------------------------------------------------------------------------

export type RunHeader = { id: number; attempt: number; status: string | null; conclusion: string | null; headSha: string | null; raw: unknown }

/** `{ total, items }` from a list payload, or null when it isn't that shape. */
export function listOf(v: unknown, key: string): { total: number; items: unknown[] } | null {
  const total = int(at(v, 'total_count'))
  const items = at(v, key)
  if (total === null || !Array.isArray(items)) return null
  return { total, items }
}

export function runHeader(v: unknown): RunHeader | null {
  const id = int(at(v, 'id'))
  const attempt = int(at(v, 'run_attempt'))
  if (id === null || attempt === null) return null
  return { id, attempt, status: str(at(v, 'status')), conclusion: str(at(v, 'conclusion')), headSha: str(at(v, 'head_sha')), raw: v }
}

export function shapeRun(h: RunHeader): O {
  const v = h.raw
  return {
    id: h.id,
    name: clean(at(v, 'name')),
    event: str(at(v, 'event')),
    head_sha: h.headSha,
    run_attempt: h.attempt,
    status: h.status,
    conclusion: h.conclusion,
    class: classifyConclusion(h.status, h.conclusion),
    html_url: str(at(v, 'html_url')),
    created_at: str(at(v, 'created_at')),
    updated_at: str(at(v, 'updated_at')),
  }
}

export type JobFacts = { id: number; runId: number | null; attempt: number | null; headSha: string | null; name: string; conclusion: string | null; htmlUrl: string | null; steps: StepInfo[] }

export function jobFacts(v: unknown): JobFacts | null {
  const id = int(at(v, 'id'))
  if (id === null) return null
  const steps = at(v, 'steps')
  return {
    id,
    runId: int(at(v, 'run_id')),
    attempt: int(at(v, 'run_attempt')),
    headSha: str(at(v, 'head_sha')),
    name: str(at(v, 'name')) ?? '',
    conclusion: str(at(v, 'conclusion')),
    htmlUrl: str(at(v, 'html_url')),
    steps: Array.isArray(steps)
      ? steps.flatMap(s => {
          const number = int(at(s, 'number'))
          const name = str(at(s, 'name'))
          return number === null || name === null ? [] : [{ number, name, conclusion: str(at(s, 'conclusion')) }]
        })
      : [],
  }
}

export const isFailedJob = (j: JobFacts) => classifyConclusion('completed', j.conclusion) === 'failed'

export function shapeFailedJob(j: JobFacts): O {
  return {
    id: j.id,
    name: stripControls(j.name),
    conclusion: j.conclusion,
    html_url: j.htmlUrl,
    failed_steps: j.steps.filter(s => classifyConclusion('completed', s.conclusion) === 'failed').map(s => ({ number: s.number, name: stripControls(s.name), conclusion: s.conclusion })),
  }
}

export function checkItem(v: unknown): { cls: Cls; item: O } {
  const status = str(at(v, 'status'))
  const conclusion = str(at(v, 'conclusion'))
  const cls = classifyConclusion(status, conclusion)
  return {
    cls,
    item: {
      id: int(at(v, 'id')),
      name: clean(at(v, 'name')),
      app: str(at(v, 'app', 'slug')),
      head_sha: str(at(v, 'head_sha')),
      status,
      conclusion,
      class: cls,
      html_url: str(at(v, 'html_url')),
    },
  }
}

export function statusItem(v: unknown): { cls: Cls; item: O } {
  const state = str(at(v, 'state'))
  const cls = classifyStatusState(state)
  return {
    cls,
    item: { context: clean(at(v, 'context')), state, class: cls, description: clean(at(v, 'description')), target_url: str(at(v, 'target_url')) },
  }
}

export function shapeLog(ids: { repo: string; sha: string; runId: number; attempt: number; job: JobFacts }, parsed: ParsedLog, extra: O = {}): O {
  return {
    repo: ids.repo,
    sha: ids.sha,
    run_id: ids.runId,
    run_attempt: ids.attempt,
    job_id: ids.job.id,
    job_name: stripControls(ids.job.name),
    ...parsed,
    ...extra,
  }
}

// ---- the whole result ------------------------------------------------------------

export type Envelope = {
  schema_version: 1
  tool: 'pr_evidence'
  identity: { host: string; repo: string | null; sha: string | null; pr: number | null; resolved_by: string }
  observed: { started_at: string; finished_at: string }
  collection: 'complete' | 'partial' | 'error'
  sections_requested: string[]
  metadata: O
  diff: O
  ci: O & { observed_outcome?: Overall | { state: 'not_requested' } }
  logs: O & { jobs?: O[] }
  omissions: Omission[]
  errors: ErrorEntry[]
  invocations: number
}

export type CiSection = Section & { total_count?: number }

export const bytesOf = (v: unknown) => utf8Bytes(JSON.stringify(v))

/**
 * Fits `env` within `maxBytes` of JSON by dropping the bulkiest evidence first
 * (patches, log lines, the PR body, passed items), recording every drop in
 * `omissions`. Identity, outcomes, errors and omissions are kept; if even those
 * don't fit, a minimal envelope says so. The input is not modified.
 */
export function fitEnvelope(input: Envelope, maxBytes: number): Envelope {
  let env: Envelope = JSON.parse(JSON.stringify(input)) as Envelope
  const fits = () => bytesOf(env) <= maxBytes
  if (fits()) return env
  const omit = (o: Omission) => env.omissions.push(o)

  // 1. Patches, last file first.
  const files = (env.diff.files as O[] | undefined) ?? []
  let dropped = 0
  for (let i = files.length - 1; i >= 0 && !fits(); i--) {
    const f = files[i]!
    if (typeof f.patch === 'string') {
      delete f.patch
      delete f.patch_truncated
      f.patch_unavailable = 'ceiling_output_bytes'
      dropped++
    }
  }
  if (dropped > 0) omit({ section: 'diff', what: 'file patches', count: dropped, reason: 'ceiling_output_bytes' })
  if (fits()) return env

  // 2. Log fallbacks, then step tails, last job first.
  const jobs = env.logs.jobs ?? []
  let logsDropped = 0
  for (const key of ['error_marker_excerpt', 'job_tail', 'steps'] as const) {
    for (let i = jobs.length - 1; i >= 0 && !fits(); i--) {
      const j = jobs[i]!
      if (j[key] !== undefined) {
        delete j[key]
        j.log_omitted = 'ceiling_output_bytes'
        logsDropped++
      }
    }
  }
  if (logsDropped > 0) omit({ section: 'logs', what: 'log tails', count: logsDropped, reason: 'ceiling_output_bytes' })
  if (fits()) return env

  // 3. The PR body.
  if (typeof env.metadata.body === 'string' && env.metadata.body !== '') {
    omit({ section: 'metadata', what: 'PR body bytes', count: utf8Bytes(env.metadata.body), reason: 'ceiling_output_bytes' })
    env.metadata.body = ''
    env.metadata.body_truncated = true
  }
  if (fits()) return env

  // 4. Passed and neutral runs, check runs and statuses; failing, pending and unknown stay.
  for (const [sec, key] of [['workflows', 'runs'], ['checks', 'items'], ['statuses', 'items']] as const) {
    const s = env.ci[sec] as O | undefined
    const list = s?.[key] as O[] | undefined
    if (!s || !Array.isArray(list)) continue
    const kept = list.filter(x => x.class !== 'passed' && x.class !== 'neutral')
    if (kept.length < list.length) {
      s[key] = kept
      omit({ section: `ci.${sec}`, what: 'passed and neutral items (still counted)', count: list.length - kept.length, reason: 'ceiling_output_bytes' })
    }
    if (fits()) return env
  }

  // 5. The diff file list.
  if (Array.isArray(env.diff.files) && env.diff.files.length > 0) {
    omit({ section: 'diff', what: 'file entries', count: env.diff.files.length, reason: 'ceiling_output_bytes' })
    env.diff.files = []
  }
  if (fits()) return env

  // 6. Last resort: identity, outcome, errors and omission counts only.
  const outcome = env.ci.observed_outcome
  env = {
    ...env,
    metadata: { status: 'omitted', reason: 'ceiling_output_bytes' },
    diff: { status: 'omitted', reason: 'ceiling_output_bytes' },
    ci: { status: 'omitted', reason: 'ceiling_output_bytes', observed_outcome: outcome, required_checks: 'not_evaluated' },
    logs: { status: 'omitted', reason: 'ceiling_output_bytes' },
    errors: env.errors.slice(0, 10),
    omissions: [{ section: 'all', what: 'every section but the outcome', count: 'unknown', reason: 'ceiling_output_bytes' }],
  }
  return env
}
