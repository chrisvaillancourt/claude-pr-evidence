// One snapshot: resolution, then the requested sections, through an injected
// runner. Holds no `$`: register.ts owns the runner over `$.process.run`, its
// allowlist check, ceilings, deadline and off switch.
import { HOST, SHA_RE, argv, classifyRejection, classifyResult, parseJson } from './gh'
import type { Done, Fail } from './gh'
import { parseFailedLog } from './logs'
import { reconcileRuns } from './runs'
import { notCollected, overallOutcome, sectionState } from './outcome'
import type { Cls, Section } from './outcome'
import { CEILINGS } from './policy'
import type { Request } from './policy'
import {
  bytesOf,
  checkItem,
  isObj,
  isFailedJob,
  jobFacts,
  listOf,
  pullFacts,
  runHeader,
  shapeDiff,
  shapeFailedJob,
  shapeLog,
  shapeMetadata,
  shapeRun,
  statusItem,
} from './envelope'
import type { Envelope, ErrorEntry, JobFacts, Omission, RunHeader } from './envelope'

export type RunOutcome = { kind: 'done'; r: Done } | { kind: 'rejected'; message: string } | { kind: 'refused'; reason: string; message: string }
export type Deps = {
  /** Runs one allowlisted argv; `workspace` runs it in the session's directory. */
  run: (a: string[], opts?: { workspace?: boolean }) => Promise<RunOutcome>
  now: () => Promise<number>
  invocations: () => number
}

type Ctx = { deps: Deps; errors: ErrorEntry[]; omissions: Omission[] }
type Got<T> = { ok: true; value: T } | Fail

const iso = (t: number) => new Date(t).toISOString()

async function runText(ctx: Ctx, section: string, step: string, a: string[], opts?: { workspace?: boolean }): Promise<Got<{ text: string; truncated: boolean }>> {
  const o = await ctx.deps.run(a, opts)
  let f: Fail
  if (o.kind === 'refused') f = { ok: false, kind: o.reason, message: o.message }
  else if (o.kind === 'rejected') f = classifyRejection(o.message)
  else {
    const c = classifyResult(o.r)
    if (c.ok) return { ok: true, value: { text: c.stdout, truncated: false } }
    // A log's truncation is the log parser's to judge; everything else is an error.
    // It is still recorded as an error: the log is incomplete evidence.
    if (c.kind === 'truncated' && step === 'log') {
      ctx.errors.push({ section, step, kind: c.kind, message: c.message })
      return { ok: true, value: { text: o.r.stdout, truncated: true } }
    }
    f = c
  }
  ctx.errors.push({ section, step, kind: f.kind, message: f.message })
  return f
}

async function runJson(ctx: Ctx, section: string, step: string, a: string[], opts?: { workspace?: boolean }): Promise<Got<unknown>> {
  const t = await runText(ctx, section, step, a, opts)
  if (!t.ok) return t
  const j = parseJson(t.value.text)
  if (!j.ok) ctx.errors.push({ section, step, kind: j.kind, message: j.message })
  return j
}

/**
 * Parses each item of a list payload; every item it can't read is recorded as a
 * `malformed` error rather than skipped, so nothing leaves a list silently.
 */
function parseItems<T>(ctx: Ctx, section: string, step: string, items: readonly unknown[], parse: (v: unknown) => T | null, what: string): { items: T[]; dropped: number } {
  const out: T[] = []
  let dropped = 0
  items.forEach((v, i) => {
    const p = parse(v)
    if (p === null) {
      dropped++
      ctx.errors.push({ section, step, kind: 'malformed', message: `${what} ${i + 1} of the list could not be read` })
    } else out.push(p)
  })
  return { items: out, dropped }
}

function fail(ctx: Ctx, section: string, step: string, kind: string, message: string): Fail {
  ctx.errors.push({ section, step, kind, message })
  return { ok: false, kind, message }
}

type Resolved = { repo: string; sha: string; pr: unknown | null; prNumber: number | null; metadata: Record<string, unknown> | null }

/** Pins one repository and full SHA, or fails; never substitutes one commit for another. */
async function resolve(ctx: Ctx, req: Request, identity: Envelope['identity']): Promise<Resolved | null> {
  let repo: string
  let pr: number | null = null
  let guard: { sha: string; what: string } | null = null
  if (req.mode === 'workspace') {
    const view = await runJson(ctx, 'identity', 'resolve', argv.workspacePr(), { workspace: true })
    if (!view.ok) return null
    const url = typeof (view.value as any)?.url === 'string' ? ((view.value as any).url as string) : ''
    const m = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url)
    if (!m) return (fail(ctx, 'identity', 'resolve', 'malformed', 'gh pr view returned no PR URL'), null)
    if (m[1] !== HOST) return (fail(ctx, 'identity', 'resolve', 'out_of_contract', `the PR is on ${m[1]}; only ${HOST} is supported`), null)
    repo = m[2]!
    pr = Number(m[3])
    identity.repo = repo
    identity.pr = pr
    const head = await runText(ctx, 'identity', 'resolve', argv.head(), { workspace: true })
    if (!head.ok) return null
    const local = head.value.text.trim()
    if (!SHA_RE.test(local)) return (fail(ctx, 'identity', 'resolve', 'malformed', 'git rev-parse HEAD printed no full SHA'), null)
    guard = { sha: local, what: 'local HEAD' }
    const remote = (view.value as any)?.headRefOid
    if (typeof remote === 'string' && remote !== local) {
      return (fail(ctx, 'identity', 'resolve', 'mismatch', `local HEAD is ${local} but PR ${pr}'s head is ${remote} (unpushed or stale checkout); nothing was collected for either commit`), null)
    }
  } else {
    repo = req.repo
    if (req.mode === 'repo+pr') {
      pr = req.pr
      if (req.sha !== undefined) guard = { sha: req.sha, what: 'the sha given' }
    }
  }

  if (pr !== null) {
    const got = await runJson(ctx, 'identity', 'resolve', argv.pull(repo, pr))
    if (!got.ok) return null
    const facts = pullFacts(got.value)
    if (!facts || !SHA_RE.test(facts.headSha)) return (fail(ctx, 'identity', 'resolve', 'malformed', `pulls/${pr} is not a pull request payload`), null)
    if (facts.baseRepo.toLowerCase() !== repo.toLowerCase()) {
      return (fail(ctx, 'identity', 'resolve', 'mismatch', `PR ${pr} belongs to ${facts.baseRepo}, not ${repo}`), null)
    }
    repo = facts.baseRepo
    identity.repo = repo
    if (guard && guard.sha !== facts.headSha) {
      return (fail(ctx, 'identity', 'resolve', 'mismatch', `${guard.what} is ${guard.sha} but PR ${pr}'s head is ${facts.headSha}; nothing was collected for either commit`), null)
    }
    identity.sha = facts.headSha
    return { repo, sha: facts.headSha, pr: got.value, prNumber: pr, metadata: null }
  }

  // repo + sha: the commit must exist, then a PR is used only if its current head is this SHA.
  const sha = (req as { sha: string }).sha
  identity.sha = sha
  const commit = await runText(ctx, 'identity', 'resolve', argv.commit(repo, sha))
  if (!commit.ok) return null
  if (commit.value.text.trim() !== sha) return (fail(ctx, 'identity', 'resolve', 'mismatch', `GitHub resolved ${sha} to ${commit.value.text.trim() || 'nothing'}`), null)
  // Which PR has this commit as its current head? commits/{sha}/pulls covers open
  // and merged PRs but not every closed, unmerged one, so a search for PRs that
  // contain the SHA adds candidates; each is confirmed by its own pulls/N read.
  // Search is eventually consistent: even both sources together are not proof of absence.
  const sources = ['commits/{sha}/pulls', 'search/issues']
  let complete = true
  const confirmed = new Map<number, unknown>()
  const known = new Set<number>()
  const heads = new Set<number>()
  const pulls = await runJson(ctx, 'metadata', 'associated_prs', argv.commitPulls(repo, sha))
  let pullsOk = false
  if (pulls.ok && !Array.isArray(pulls.value)) fail(ctx, 'metadata', 'associated_prs', 'malformed', 'commits/{sha}/pulls is not a list')
  else if (pulls.ok) {
    pullsOk = true
    const parsed = parseItems(ctx, 'metadata', 'associated_prs', pulls.value as unknown[], pullFacts, 'pull request')
    if (parsed.dropped > 0) complete = false
    for (const f of parsed.items) {
      known.add(f.number)
      if (f.headSha === sha && f.baseRepo.toLowerCase() === repo.toLowerCase()) heads.add(f.number)
    }
  }
  if (!pullsOk) complete = false
  const found = await runJson(ctx, 'metadata', 'search_prs', argv.searchPrs(repo, sha))
  const hits = found.ok ? listOf(found.value, 'items') : null
  if (found.ok && !hits) fail(ctx, 'metadata', 'search_prs', 'malformed', 'search/issues is not a search result')
  if (!hits) complete = false
  if (!pullsOk && !hits) return { repo, sha, pr: null, prNumber: null, metadata: { status: 'error', reason: 'could not look up PRs for this commit' } }
  if (hits) {
    if ((found as { value: any }).value?.incomplete_results === true || hits.total > hits.items.length) {
      complete = false
      ctx.omissions.push({ section: 'metadata', what: 'PR search results', count: hits.total > hits.items.length ? hits.total - hits.items.length : 'unknown', reason: 'search_incomplete' })
    }
    const numbers = parseItems(ctx, 'metadata', 'search_prs', hits.items, i => (isObj(i) && typeof i.number === 'number' && Number.isSafeInteger(i.number) ? i.number : null), 'search hit')
    if (numbers.dropped > 0) complete = false
    const fresh = numbers.items.filter(x => !known.has(x))
    const check = fresh.slice(0, CEILINGS.searchConfirmations)
    if (fresh.length > check.length) {
      complete = false
      ctx.omissions.push({ section: 'metadata', what: 'PR search hits not confirmed', count: fresh.length - check.length, reason: 'ceiling_search_confirmations' })
    }
    for (const n of check) {
      const got = await runJson(ctx, 'metadata', 'pull', argv.pull(repo, n))
      const f = got.ok ? pullFacts(got.value) : null
      if (!f) {
        // A failed command is already in errors; an unreadable payload is recorded here.
        if (got.ok) fail(ctx, 'metadata', 'pull', 'malformed', `pulls/${n} (a search hit) is not a pull request payload`)
        complete = false
        continue
      }
      if (f.headSha === sha && f.baseRepo.toLowerCase() === repo.toLowerCase()) {
        heads.add(n)
        confirmed.set(n, got.ok ? got.value : null)
      }
    }
  }
  const association = {
    sources,
    complete,
    note: complete
      ? 'Both sources were read in full; GitHub search lags new PRs, so this is not proof that none exists.'
      : 'A source failed or was cut short; a PR with this head may exist.',
  }
  if (heads.size === 0) {
    return { repo, sha, pr: null, prNumber: null, metadata: { status: 'no_pr_found', reason: 'no PR found whose current head is this commit', association } }
  }
  if (heads.size > 1) {
    return { repo, sha, pr: null, prNumber: null, metadata: { status: 'ambiguous', candidates: [...heads].sort((a, b) => a - b), reason: 'more than one open or closed PR has this commit as its current head', association } }
  }
  const only = [...heads][0]!
  const already = confirmed.get(only)
  if (already !== undefined && already !== null) {
    identity.pr = only
    return { repo, sha, pr: already, prNumber: only, metadata: null }
  }
  const n = only
  const full = await runJson(ctx, 'metadata', 'pull', argv.pull(repo, n))
  if (!full.ok) return { repo, sha, pr: null, prNumber: n, metadata: { status: 'error', reason: `could not read PR ${n}` } }
  const facts = pullFacts(full.value)
  if (!facts || facts.headSha !== sha) {
    fail(ctx, 'metadata', 'pull', 'mismatch', `PR ${n}'s head moved from ${sha} while it was read`)
    return { repo, sha, pr: null, prNumber: null, metadata: { status: 'error', reason: `PR ${n} changed while it was read` } }
  }
  identity.pr = n
  return { repo, sha, pr: full.value, prNumber: n, metadata: null }
}

type CiResult = { ci: Envelope['ci']; logs: Envelope['logs'] }

async function collectCi(ctx: Ctx, repo: string, sha: string, wantLogs: boolean): Promise<CiResult> {
  // Actions runs for the exact SHA.
  let workflows: Section & Record<string, unknown>
  let headers: RunHeader[] = []
  let runsTotal = 0
  const got = await runJson(ctx, 'ci.workflows', 'runs', argv.runs(repo, sha))
  const list = got.ok ? listOf(got.value, 'workflow_runs') : null
  if (got.ok && list === null) fail(ctx, 'ci.workflows', 'runs', 'malformed', 'actions/runs is not a workflow run list')
  let runsError = !got.ok || list === null
  let initialCut = false
  if (list) {
    runsTotal = list.total
    const parsed = parseItems(ctx, 'ci.workflows', 'runs', list.items.slice(0, CEILINGS.runs), runHeader, 'workflow run')
    if (parsed.dropped > 0) runsError = true
    for (const h of parsed.items) {
      if (h.headSha !== sha) fail(ctx, 'ci.workflows', 'runs', 'mismatch', `run ${h.id} is for ${h.headSha}, not ${sha}`)
      else headers.push(h)
    }
    if (runsTotal > list.items.length) {
      initialCut = true
      ctx.omissions.push({ section: 'ci.workflows', what: 'workflow runs beyond the first page', count: runsTotal - list.items.length, reason: 'ceiling_runs' })
    }
  }

  // Jobs of failed runs, for their latest attempt.
  const failedRuns = headers.filter(h => classifyConclusionOf(h) === 'failed')
  const inspected = failedRuns.slice(0, CEILINGS.failedRunsInspected)
  if (failedRuns.length > inspected.length) {
    ctx.omissions.push({ section: 'ci.workflows', what: 'jobs of failed runs', count: failedRuns.length - inspected.length, reason: 'ceiling_failed_runs_inspected' })
  }
  const jobsByRun = new Map<number, { attempt: number; jobs: JobFacts[] }>()
  for (const h of inspected) {
    const j = await runJson(ctx, 'ci.workflows', 'jobs', argv.jobs(repo, h.id, h.attempt))
    if (!j.ok) continue
    const jl = listOf(j.value, 'jobs')
    if (!jl) {
      fail(ctx, 'ci.workflows', 'jobs', 'malformed', `jobs of run ${h.id} is not a job list`)
      continue
    }
    if (jl.total > jl.items.length) ctx.omissions.push({ section: 'ci.workflows', what: `jobs of run ${h.id} beyond the first page`, count: jl.total - jl.items.length, reason: 'ceiling_jobs_per_run' })
    const jobs: JobFacts[] = []
    for (const f of parseItems(ctx, 'ci.workflows', 'jobs', jl.items, jobFacts, `job of run ${h.id}`).items) {
      if (f.runId !== h.id || f.attempt !== h.attempt || f.headSha !== sha) {
        fail(ctx, 'ci.workflows', 'jobs', 'mismatch', `job ${f.id} is run ${f.runId} attempt ${f.attempt} at ${f.headSha}, expected run ${h.id} attempt ${h.attempt} at ${sha}`)
        continue
      }
      jobs.push(f)
    }
    jobsByRun.set(h.id, { attempt: h.attempt, jobs })
  }

  // Failed-job logs.
  const logEntries: { runId: number; entry: Record<string, unknown> }[] = []
  if (wantLogs) {
    const failedJobs = [...jobsByRun.entries()].flatMap(([runId, r]) => r.jobs.filter(isFailedJob).map(job => ({ runId, attempt: r.attempt, job })))
    const fetch = failedJobs.slice(0, CEILINGS.logsFetched)
    if (failedJobs.length > fetch.length) ctx.omissions.push({ section: 'logs', what: 'failed job logs', count: failedJobs.length - fetch.length, reason: 'ceiling_logs_fetched' })
    let budget = CEILINGS.logsBytes
    for (const f of fetch) {
      const ids = { repo, sha, runId: f.runId, attempt: f.attempt, job: f.job }
      const t = await runText(ctx, 'logs', 'log', argv.log(repo, f.runId, f.attempt, f.job.id))
      let entry: Record<string, unknown>
      if (!t.ok) {
        entry = shapeLog(ids, { attribution: 'step_logs_unavailable', reason: t.kind === 'logs_unavailable' ? 'logs_unavailable' : `log_fetch_${t.kind}` })
      } else {
        entry = shapeLog(ids, parseFailedLog({ text: t.value.text, truncated: t.value.truncated, jobName: f.job.name, steps: f.job.steps }))
      }
      const size = bytesOf(entry)
      if (size > budget) {
        for (const k of ['error_marker_excerpt', 'job_tail', 'steps']) delete entry[k]
        entry.log_omitted = 'ceiling_logs_bytes'
        ctx.omissions.push({ section: 'logs', what: `log tail of job ${f.job.id}`, count: 1, reason: 'ceiling_logs_bytes' })
      }
      budget -= Math.min(size, budget)
      logEntries.push({ runId: f.runId, entry })
    }
  }

  // Check runs and legacy statuses.
  const checks = await listSection(ctx, 'ci.checks', 'check_runs', argv.checks(repo, sha), 'check_runs', checkItem, 'checks')
  const statuses = await listSection(ctx, 'ci.statuses', 'status', argv.status(repo, sha), 'statuses', statusItem, 'statuses')

  // Re-read run headers once, after everything else, whenever runs were found: a run
  // that changed (a rerun started, a run finished) counts in its new state and
  // invalidates what was read for its older one. A recheck that fails can't confirm
  // the first read, so the section is incomplete (known failures still count).
  let final: RunHeader[] | null = null
  let finalComplete = false
  let recheckFailed = false
  // Items of the final read that were reported (malformed or another SHA) rather than used.
  let recheckUnreadable = false
  if (headers.length > 0 && !runsError) {
    const again = await runJson(ctx, 'ci.workflows', 'runs_recheck', argv.runs(repo, sha))
    const l2 = again.ok ? listOf(again.value, 'workflow_runs') : null
    if (again.ok && !l2) fail(ctx, 'ci.workflows', 'runs_recheck', 'malformed', 'actions/runs is not a workflow run list')
    if (!l2) recheckFailed = true
    else {
      final = []
      const parsed = parseItems(ctx, 'ci.workflows', 'runs_recheck', l2.items.slice(0, CEILINGS.runs), runHeader, 'workflow run')
      if (parsed.dropped > 0) recheckUnreadable = true
      for (const h of parsed.items) {
        if (h.headSha === sha) final.push(h)
        else {
          recheckUnreadable = true
          fail(ctx, 'ci.workflows', 'runs_recheck', 'mismatch', `run ${h.id} is for ${h.headSha}, not ${sha}`)
        }
      }
      finalComplete = l2.total <= l2.items.length && l2.items.length <= CEILINGS.runs
      if (!finalComplete && !initialCut) {
        ctx.omissions.push({ section: 'ci.workflows', what: 'workflow runs beyond the first page of the final read', count: Math.max(0, l2.total - Math.min(l2.items.length, CEILINGS.runs)), reason: 'ceiling_runs' })
      }
      runsTotal = Math.max(runsTotal, l2.total)
    }
  }
  const merged = reconcileRuns(headers, final, finalComplete)
  const changed = new Set(merged.filter(m => m.changed).map(m => m.header.id))
  for (const id of changed) {
    const r = jobsByRun.get(id)
    if (r) {
      ctx.omissions.push({ section: 'logs', what: `jobs and logs of run ${id} attempt ${r.attempt}`, count: 1, reason: 'run_changed_during_collection' })
      jobsByRun.delete(id)
    }
  }
  const unlisted = merged.filter(m => m.listing === 'not_in_final_page' || m.listing === 'no_longer_listed').length
  if (unlisted > 0) ctx.omissions.push({ section: 'ci.workflows', what: 'runs seen earlier but not in the final run list (kept as first observed)', count: unlisted, reason: 'run_list_changed_during_collection' })

  const runs = merged.map(m => {
    const r = shapeRun(m.header)
    if (final !== null || recheckFailed) r.listing = m.listing
    if (m.changed) r.changed_during_collection = true
    const jr = jobsByRun.get(m.header.id)
    if (jr) r.failed_jobs = jr.jobs.filter(isFailedJob).map(shapeFailedJob)
    return r
  })
  // Every run that is failed in the merged set but has no jobs collected for its
  // final attempt gets a reason, on the run and (when logs were asked for) in logs.
  const inspectedIds = new Set(inspected.map(h => h.id))
  const initialFailed = new Set(failedRuns.map(h => h.id))
  const notInspected: { run_id: number; run_attempt: number; reason: string }[] = []
  for (let k = 0; k < merged.length; k++) {
    const m = merged[k]!
    if (runs[k]!.class !== 'failed' || jobsByRun.has(m.header.id)) continue
    const reason = m.changed || !initialFailed.has(m.header.id)
      ? 'failed_during_collection'
      : inspectedIds.has(m.header.id) ? 'jobs_unavailable' : 'ceiling_failed_runs_inspected'
    runs[k]!.jobs_not_inspected = reason
    notInspected.push({ run_id: m.header.id, run_attempt: m.header.attempt, reason })
  }
  if (wantLogs) {
    const byReason = new Map<string, number>()
    for (const r of notInspected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)
    for (const [reason, count] of byReason) ctx.omissions.push({ section: 'logs', what: 'failed runs whose jobs and logs were not collected', count, reason })
  }
  const runsComplete = !runsError && !recheckFailed && !recheckUnreadable && unlisted === 0 && (final !== null ? finalComplete : runsTotal <= headers.length)
  workflows = {
    ...sectionState({ error: runsError || recheckFailed, total: runsTotal, classes: runs.map(r => r.class as Cls), complete: runsComplete }, 'workflows'),
    total_count: runsTotal,
    runs,
  }


  const ci: Envelope['ci'] = {
    status: 'ok',
    workflows,
    checks,
    statuses,
    observed_outcome: overallOutcome({ workflows, checks, statuses }),
    required_checks: 'not_evaluated',
  }
  const kept = logEntries.filter(l => !changed.has(l.runId)).map(l => l.entry)
  const logs: Envelope['logs'] = { status: 'ok', jobs: kept }
  if (notInspected.length > 0) logs.runs_not_inspected = notInspected.map(r => ({ repo, sha, ...r }))
  return { ci, logs: wantLogs ? logs : { status: 'not_requested' } }
}

function classifyConclusionOf(h: RunHeader): Cls {
  return shapeRun(h).class as Cls
}

async function listSection(
  ctx: Ctx,
  section: string,
  step: string,
  a: string[],
  key: string,
  item: (v: unknown) => { cls: Cls; item: Record<string, unknown> },
  name: 'checks' | 'statuses',
): Promise<Section & Record<string, unknown>> {
  const got = await runJson(ctx, section, step, a)
  const list = got.ok ? listOf(got.value, key) : null
  if (got.ok && !list) fail(ctx, section, step, 'malformed', `${step} is not a ${key} list`)
  if (!list) return { ...notCollected('error'), total_count: null, items: [] }
  const limit = name === 'checks' ? CEILINGS.checks : CEILINGS.statuses
  const shaped = list.items.slice(0, limit).map(item)
  if (list.total > shaped.length) ctx.omissions.push({ section, what: `${key} beyond the first page`, count: list.total - shaped.length, reason: `ceiling_${name}` })
  const out: Section & Record<string, unknown> = {
    ...sectionState({ error: false, total: list.total, classes: shaped.map(s => s.cls), complete: list.total <= shaped.length }, name),
    total_count: list.total,
    items: shaped.map(s => s.item),
  }
  if (name === 'statuses') out.combined_state_from_github = (got as { value: any }).value?.state ?? null
  return out
}

/** Collects one snapshot for a validated request. */
export async function collect(req: Request, deps: Deps): Promise<Envelope> {
  const started = await deps.now()
  const ctx: Ctx = { deps, errors: [], omissions: [] }
  const want = new Set<string>(req.sections)
  const identity: Envelope['identity'] = { host: HOST, repo: req.mode === 'workspace' ? null : req.repo, sha: null, pr: req.mode === 'repo+pr' ? req.pr : null, resolved_by: req.mode }
  if (req.mode === 'repo+sha') identity.sha = req.sha
  const env: Envelope = {
    schema_version: 1,
    tool: 'pr_evidence',
    identity,
    observed: { started_at: iso(started), finished_at: '' },
    collection: 'complete',
    sections_requested: req.sections,
    metadata: { status: want.has('metadata') ? 'not_collected' : 'not_requested' },
    diff: { status: want.has('diff') ? 'not_collected' : 'not_requested' },
    ci: { status: want.has('ci') || want.has('logs') ? 'not_collected' : 'not_requested' },
    logs: { status: want.has('logs') ? 'not_collected' : 'not_requested' },
    omissions: ctx.omissions,
    errors: ctx.errors,
    invocations: 0,
  }

  const r = await resolve(ctx, req, identity)
  if (!r) {
    if (identity.resolved_by === 'repo+pr' || identity.resolved_by === 'workspace') identity.sha = identity.sha ?? null
    env.collection = 'error'
    env.ci = { ...env.ci, ...(env.ci.status === 'not_collected' ? { reason: 'resolution failed' } : {}) }
    return finish(env, deps)
  }

  if (want.has('metadata')) env.metadata = r.metadata ?? (r.pr !== null ? shapeMetadata(r.pr, ctx.omissions) : { status: 'error' })
  if (want.has('diff')) {
    const facts = r.pr !== null ? pullFacts(r.pr) : null
    if (!facts) env.diff = { status: 'not_collected', reason: r.metadata?.reason ?? 'no PR resolved for this commit' }
    else {
      const got = await runJson(ctx, 'diff', 'compare', argv.compare(r.repo, facts.baseSha, r.sha))
      const shaped = got.ok ? shapeDiff(got.value, { base: facts.baseSha, head: r.sha, changedFiles: facts.changedFiles }, ctx.omissions) : null
      if (got.ok && !shaped) fail(ctx, 'diff', 'compare', 'malformed', 'compare is not a comparison payload')
      env.diff = shaped ?? { status: 'error' }
    }
  }
  if (want.has('ci') || want.has('logs')) {
    const c = await collectCi(ctx, r.repo, r.sha, want.has('logs'))
    env.ci = c.ci
    env.logs = c.logs
  }
  return finish(env, deps)
}

async function finish(env: Envelope, deps: Deps): Promise<Envelope> {
  env.observed.finished_at = iso(await deps.now())
  env.invocations = deps.invocations()
  if (env.ci.status === 'not_requested') env.ci.observed_outcome = { state: 'not_requested' }
  return env
}
