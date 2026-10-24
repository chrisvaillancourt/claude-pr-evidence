import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import * as F from './fixtures'
import { argv as A, isReadOnlyArgv } from './gh'

const TOOL = 'mcp__pr-evidence__pr_evidence'
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const { REPO, HEAD, BASE, OTHER } = F

type Reply =
  | { json: unknown }
  | { text: string; truncated?: boolean }
  | { exit: number; stderr: string; stdout?: string }
  | { deny: string }
  | { hold: { reached: () => void; release: Promise<void> }; then: Reply }

/** Every argv the mod ran, across the whole file: the last test checks them all. */
const everyArgv: string[][] = []

/** The engine beneath the plugin, with a `gh`/`git` that answers from `replies` by argv. */
function world(on: On) {
  const replies = new Map<string, Reply | Reply[]>()
  const seen = { argv: [] as string[][], inits: [] as Record<string, unknown>[], tools: [] as Record<string, unknown>[], commands: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/widget' }))
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    seen.tools.push({ ...e })
    return { value: { tool: `mcp__pr-evidence__${e.name}` } }
  })
  on('ui.log', () => ({ value: undefined }))
  let t = Date.parse('2026-01-03T00:00:00Z')
  on('clock.now', () => ({ value: (t += 100) }))
  on('process.run', async ($, e) => {
    seen.argv.push([...e.argv])
    everyArgv.push([...e.argv])
    seen.inits.push({ ...(e.init ?? {}) })
    const key = e.argv.join(' ')
    const entry = replies.get(key)
    let r: Reply | undefined = Array.isArray(entry) ? entry.shift() : entry
    if (r === undefined) return { deny: `test world: no reply for ${key}` }
    if ('hold' in r) {
      // The command is "running" until the test releases it.
      r.hold.reached()
      await r.hold.release
      r = r.then
    }
    if ('deny' in r) return { deny: r.deny }
    const done = (exitCode: number, stdout: string, stderr = '', truncated = false) =>
      ({ value: { exitCode, stdout, stderr, isStdoutTruncated: truncated, isStderrTruncated: false } })
    if ('json' in r) return done(0, JSON.stringify(r.json))
    if ('text' in r) return done(0, r.text, '', r.truncated ?? false)
    const x = r as Extract<Reply, { exit: number }>
    return done(x.exit, x.stdout ?? '', x.stderr)
  })
  const gh = (a: string[], ...r: Reply[]) => replies.set(a.join(' '), r.length === 1 ? r[0]! : r)
  return { seen, gh }
}

const start = ($: any) => $.session.start({ cwd: '/work/widget', surface: 'terminal', isInteractive: true })
async function call($: any, input: Record<string, unknown>): Promise<any> {
  const r = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...input })
  if (r.deny !== undefined) return { deny: r.deny }
  expect(typeof r.result).toBe('string')
  return JSON.parse(r.result)
}

const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)', stdout: '{"message":"Not Found","status":"404"}' }

/** A commit that exists, with no PR and no CI at all. */
function bareCommit(gh: ReturnType<typeof world>['gh']) {
  gh(A.commit(REPO, HEAD), { text: `${HEAD}\n` })
  gh(A.commitPulls(REPO, HEAD), { json: [] })
  gh(A.runs(REPO, HEAD), { json: F.runs([]) })
  gh(A.checks(REPO, HEAD), { json: F.checks([]) })
  gh(A.status(REPO, HEAD), { json: F.status([]) })
}

/** PR 7 at HEAD with a diff, ready for CI replies. */
function prAt(gh: ReturnType<typeof world>['gh'], pr = F.pull()) {
  gh(A.pull(REPO, 7), { json: pr })
  gh(A.compare(REPO, BASE, HEAD), { json: F.compare() })
}

describe('registration', () => {
  test('registers one deferred tool and the command, also when off', { options: { enabled: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.seen.tools.map(t => [t.name, t.isDeferred])).toEqual([['pr_evidence', true]])
    const schema = w.seen.tools[0]!.inputSchema as any
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(['repo', 'pr', 'sha', 'sections'])
    expect(w.seen.commands).toEqual(['pr-evidence'])
  })
})

describe('outcome rules through the tool', () => {
  test('rule 1: a valid commit with zero runs is no_workflows, and nothing passed', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    const env = await call($, { repo: REPO, sha: HEAD })
    expect(env.identity).toEqual({ host: 'github.com', repo: REPO, sha: HEAD, pr: null, resolved_by: 'repo+sha' })
    expect(env.collection).toBe('complete')
    expect(env.metadata.status).toBe('no_pr')
    expect(env.diff).toMatchObject({ status: 'not_collected' })
    expect(env.ci.workflows.state).toBe('no_workflows')
    expect(env.ci.statuses.state).toBe('none')
    expect(env.ci.statuses.counts.pending).toBe(0)
    expect(env.ci.observed_outcome.state).toBe('no_workflows')
    expect(env.ci.required_checks).toBe('not_evaluated')
    expect(env.schema_version).toBe(1)
  })

  test('rule 1: a commit that does not exist is an error, not no_workflows', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.commit(REPO, OTHER), { exit: 1, stderr: `gh: No commit found for SHA: ${OTHER} (HTTP 422)` })
    const env = await call($, { repo: REPO, sha: OTHER })
    expect(env.collection).toBe('error')
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'not_found' })
    expect(env.identity).toMatchObject({ repo: REPO, sha: OTHER })
    expect(env.ci.status).toBe('not_collected')
    expect(w.seen.argv.length).toBe(1)
  })

  test('PR with a failure, running work and a success: failing, pending kept, logs honest', async ($, on) => {
    const w = world(on)
    await start($)
    prAt(w.gh)
    const runList = [
      F.run({ id: 11, name: 'Lint', conclusion: 'failure' }),
      F.run({ id: 12, name: 'Tests', conclusion: 'success' }),
      F.run({ id: 13, name: 'Scan', status: 'in_progress', conclusion: null }),
    ]
    w.gh(A.runs(REPO, HEAD), { json: F.runs(runList) }, { json: F.runs(runList) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1, name: 'lint', conclusion: 'failure' }), F.check({ id: 2, name: 'tests' })]) })
    w.gh(A.status(REPO, HEAD), { json: F.status([]) })
    w.gh(A.jobs(REPO, 11, 1), { json: F.jobs([F.job({ id: 101, runId: 11, name: 'lint' }), F.job({ id: 102, runId: 11, name: 'vuln', conclusion: 'success' })]) })
    w.gh(A.log(REPO, 11, 1, 101), {
      text: F.logText('lint', [
        ['UNKNOWN STEP', '##[group]Run go vet ./...'],
        ['UNKNOWN STEP', 'vet: frob.go:3: unreachable code'],
        ['UNKNOWN STEP', '##[error]Process completed with exit code 1.'],
        ['UNKNOWN STEP', 'Post job cleanup.'],
        ['UNKNOWN STEP', 'Cleaning up orphan processes'],
      ]),
    })
    const env = await call($, { repo: REPO, pr: 7 })
    expect(env.identity).toEqual({ host: 'github.com', repo: REPO, sha: HEAD, pr: 7, resolved_by: 'repo+pr' })
    expect(env.collection).toBe('complete')
    expect(env.metadata).toMatchObject({ status: 'ok', number: 7, title: 'Add the widget frobnicator', head: { sha: HEAD, repo: REPO }, base: { sha: BASE } })
    expect(env.diff).toMatchObject({ status: 'ok', kind: 'frozen_comparison', base_sha: BASE, merge_base_sha: BASE, head_sha: HEAD, files_total: 2 })
    expect(env.diff.files[0]).toMatchObject({ filename: 'src/frob.go', patch: '@@ -1,3 +1,10 @@\n-old\n+new\n' })
    expect(env.diff.files[1]).toMatchObject({ filename: 'assets/logo.png', patch_unavailable: 'github_omitted' })
    expect(env.diff.files[1].patch).toBeUndefined()
    expect(env.ci.workflows).toMatchObject({ state: 'failing', has_pending: true, counts: { failed: 1, pending: 1, passed: 1 } })
    expect(env.ci.workflows.runs.map((r: any) => [r.id, r.class])).toEqual([[11, 'failed'], [12, 'passed'], [13, 'pending']])
    expect(env.ci.workflows.runs[0].failed_jobs).toEqual([
      { id: 101, name: 'lint', conclusion: 'failure', html_url: `https://github.com/${REPO}/actions/runs/11/job/101`, failed_steps: [{ number: 2, name: 'Run tests', conclusion: 'failure' }] },
    ])
    expect(env.ci.observed_outcome).toMatchObject({ state: 'failing', has_pending: true })
    const log = env.logs.jobs[0]
    expect(log).toMatchObject({ repo: REPO, sha: HEAD, run_id: 11, run_attempt: 1, job_id: 101, job_name: 'lint', attribution: 'step_logs_unavailable', reason: 'unknown_step' })
    expect(log.steps).toBeUndefined()
    expect(log.job_tail.lines.at(-1)).toBe('Cleaning up orphan processes')
    expect(log.error_marker_excerpt.lines).toEqual(['##[group]Run go vet ./...', 'vet: frob.go:3: unreachable code', '##[error]Process completed with exit code 1.'])
    expect(env.errors).toEqual([])
  })

  test('rule 2: running work beside a success is pending', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 11 }), F.run({ id: 12, status: 'queued', conclusion: null })]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(env.ci.observed_outcome).toMatchObject({ state: 'pending', has_pending: true, counts: { pending: 1, passed: 1 } })
  })

  test('rule 3 and 4: skipped-only, unknown, incomplete, malformed and truncated never pass', async ($, on) => {
    const w = world(on)
    await start($)
    const cases: [string, () => void, string][] = [
      ['all skipped', () => {
        w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1, conclusion: 'skipped' }), F.run({ id: 2, conclusion: 'neutral' })]) })
        w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 9, conclusion: 'skipped' })]) })
      }, 'skipped_only'],
      ['unknown conclusion', () => w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 }), F.run({ id: 2, conclusion: 'brand_new' })]) }), 'inconclusive'],
      ['more runs than one page', () => w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 })], 150) }), 'inconclusive'],
      ['malformed JSON', () => w.gh(A.runs(REPO, HEAD), { text: '{"total_count": 1, "workflow_r' }), 'inconclusive'],
      ['wrong shape', () => w.gh(A.runs(REPO, HEAD), { json: { total_count: 1 } }), 'inconclusive'],
      ['truncated capture', () => w.gh(A.runs(REPO, HEAD), { text: '{"total_count": 1', truncated: true }), 'inconclusive'],
      ['failed discovery', () => w.gh(A.runs(REPO, HEAD), { exit: 1, stderr: 'gh: Server Error (HTTP 502)' }), 'inconclusive'],
      ['rate limited', () => w.gh(A.runs(REPO, HEAD), { exit: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }), 'inconclusive'],
    ]
    for (const [name, arrange, state] of cases) {
      bareCommit(w.gh)
      w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 9 })]) })
      arrange()
      const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
      expect([name, env.ci.observed_outcome.state]).toEqual([name, state])
      if (state === 'inconclusive') expect([name, env.ci.workflows.state === 'passed' || env.ci.workflows.state === 'no_workflows']).toEqual([name, false])
    }
  })

  test('rule 3: the errors name the failed command and its kind', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { text: '{"total_count": 1', truncated: true })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(env.collection).toBe('partial')
    expect(env.ci.workflows.state).toBe('error')
    expect(env.errors).toEqual([{ section: 'ci.workflows', step: 'runs', kind: 'truncated', message: 'output passed the 4 MiB capture limit and was cut' }])
  })

  test('rule 5 and 6: external check and legacy status failures stay visible; empty statuses add no pending', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 })]) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1 }), F.check({ id: 2, name: 'deploy-preview', app: 'example-ci', conclusion: 'failure' })]) })
    const ext = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(ext.ci.checks.items[1]).toMatchObject({ name: 'deploy-preview', app: 'example-ci', class: 'failed' })
    expect(ext.ci.observed_outcome).toMatchObject({ state: 'failing', has_pending: false })

    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 })]) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1 })]) })
    w.gh(A.status(REPO, HEAD), { json: F.status([{ context: 'legacy/ci', state: 'failure' }]) })
    const legacy = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(legacy.ci.statuses).toMatchObject({ state: 'failing', total_count: 1 })
    expect(legacy.ci.observed_outcome.state).toBe('failing')

    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 })]) })
    w.gh(A.checks(REPO, HEAD), { exit: 1, stderr: 'gh: Server Error (HTTP 502)' })
    w.gh(A.status(REPO, HEAD), { json: F.status([{ context: 'legacy/ci', state: 'failure' }]) })
    const mixed = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(mixed.ci.checks.state).toBe('error')
    expect(mixed.ci.observed_outcome.state).toBe('failing')
  })

  test('rule 7: all passed is observed_passed, with required checks not evaluated', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1 }), F.run({ id: 2, conclusion: 'skipped' })]) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1 })]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(env.ci.observed_outcome.state).toBe('observed_passed')
    expect(env.ci.observed_outcome.summary).toContain('not a merge decision')
    expect(env.ci.required_checks).toBe('not_evaluated')
  })

  test('distinct runs that share a workflow name stay distinct', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 1, name: 'CI', event: 'push' }), F.run({ id: 2, name: 'CI', event: 'pull_request' })]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(env.ci.workflows.runs.map((r: any) => [r.id, r.name, r.event])).toEqual([[1, 'CI', 'push'], [2, 'CI', 'pull_request']])
  })
})

describe('identity', () => {
  test('a sha guard that differs from the PR head is an error', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.pull(REPO, 7), { json: F.pull() })
    const env = await call($, { repo: REPO, pr: 7, sha: OTHER })
    expect(env.collection).toBe('error')
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'mismatch' })
    expect(env.errors[0].message).toContain(OTHER)
    expect(env.errors[0].message).toContain(HEAD)
    expect(env.identity).toMatchObject({ repo: REPO, pr: 7, sha: null })
    expect(w.seen.argv.length).toBe(1)
  })

  test('workspace: local HEAD must equal the PR head', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.workspacePr(), { json: { number: 7, url: `https://github.com/${REPO}/pull/7`, headRefOid: HEAD } })
    w.gh(A.head(), { text: `${OTHER}\n` })
    const env = await call($, {})
    expect(env.collection).toBe('error')
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'mismatch' })
    expect(env.errors[0].message).toContain('local HEAD')
    expect(w.seen.argv.map(a => a.join(' '))).toEqual([A.workspacePr().join(' '), A.head().join(' ')])
  })

  test('workspace: a matching checkout resolves to the base repository and its PR', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.workspacePr(), { json: { number: 7, url: `https://github.com/${REPO}/pull/7`, headRefOid: HEAD } })
    w.gh(A.head(), { text: `${HEAD}\n` })
    w.gh(A.pull(REPO, 7), { json: F.pull({ headRepo: F.FORK }) })
    const env = await call($, { sections: ['metadata'] })
    expect(env.identity).toEqual({ host: 'github.com', repo: REPO, sha: HEAD, pr: 7, resolved_by: 'workspace' })
    expect(env.metadata).toMatchObject({ status: 'ok', is_cross_repository: true, head: { repo: F.FORK } })
    expect(w.seen.inits[0]).toMatchObject({ cwd: '/work/widget' })
  })

  test('workspace: a PR on another host is out of contract', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.workspacePr(), { json: { number: 7, url: 'https://ghe.example.test/octo-org/widget/pull/7', headRefOid: HEAD } })
    const env = await call($, {})
    expect(env.collection).toBe('error')
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'out_of_contract' })
  })

  test('workspace: no PR for the branch is an error with the reason', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.workspacePr(), { exit: 1, stderr: 'no pull requests found for branch "feature"' })
    const env = await call($, {})
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'no_pr_for_branch' })
  })

  test('several PRs with this head: ambiguous, no diff picked, CI still collected', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.commitPulls(REPO, HEAD), { json: [F.pull({ number: 7 }), F.pull({ number: 8 }), F.pull({ number: 9, head: OTHER })] })
    const env = await call($, { repo: REPO, sha: HEAD })
    expect(env.metadata).toEqual({ status: 'ambiguous', candidates: [7, 8], reason: 'more than one open or closed PR has this commit as its current head' })
    expect(env.diff.status).toBe('not_collected')
    expect(env.identity.pr).toBe(null)
    expect(env.ci.observed_outcome.state).toBe('no_workflows')
  })

  test('a single PR whose current head is the sha is used; older heads are not', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.commitPulls(REPO, HEAD), { json: [F.pull({ number: 7 }), F.pull({ number: 9, head: OTHER })] })
    prAt(w.gh)
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['metadata', 'diff'] })
    expect(env.identity.pr).toBe(7)
    expect(env.metadata.status).toBe('ok')
    expect(env.diff.status).toBe('ok')
  })

  test('a job whose sha or attempt differs is dropped as a mismatch', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    const r = [F.run({ id: 11, conclusion: 'failure' })]
    w.gh(A.runs(REPO, HEAD), { json: F.runs(r) }, { json: F.runs(r) })
    w.gh(A.jobs(REPO, 11, 1), { json: F.jobs([F.job({ id: 101, runId: 11, head: OTHER }), F.job({ id: 102, runId: 11, attempt: 2 })]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(env.ci.workflows.runs[0].failed_jobs).toEqual([])
    expect(env.errors.map((e: any) => e.kind)).toEqual(['mismatch', 'mismatch'])
    expect(env.ci.observed_outcome.state).toBe('failing')
  })
})

describe('reruns', () => {
  test('a successful-only snapshot is rechecked too: a rerun that started is pending, not passed', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD),
      { json: F.runs([F.run({ id: 11 })]) },
      { json: F.runs([F.run({ id: 11, attempt: 2, status: 'in_progress', conclusion: null })]) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1 })]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    const reads = w.seen.argv.filter(a => a.join(' ') === A.runs(REPO, HEAD).join(' ')).length
    expect({ state: env.ci.observed_outcome.state, reads }).toEqual({ state: 'pending', reads: 2 })
    expect(env.ci.workflows.runs[0]).toMatchObject({ id: 11, run_attempt: 2, changed_during_collection: true })
  })

  test('a recheck that fails leaves the snapshot inconclusive, and a known failure stays visible', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 11 })]) }, { exit: 1, stderr: 'gh: Server Error (HTTP 502)' })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([F.check({ id: 1 })]) })
    const passedOnce = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(passedOnce.ci.observed_outcome.state).toBe('inconclusive')
    expect(passedOnce.errors).toContainEqual(expect.objectContaining({ step: 'runs_recheck', kind: 'http_error' }))

    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD), { json: F.runs([F.run({ id: 11 }), F.run({ id: 12, conclusion: 'failure' })]) }, { exit: 1, stderr: 'gh: Server Error (HTTP 502)' })
    w.gh(A.jobs(REPO, 12, 1), { json: F.jobs([]) })
    const failedOnce = await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    expect(failedOnce.ci.observed_outcome.state).toBe('failing')
  })

  test('a run rerun during collection: its old-attempt jobs and logs are dropped, the new state counts', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    w.gh(A.runs(REPO, HEAD),
      { json: F.runs([F.run({ id: 11, conclusion: 'failure' }), F.run({ id: 12 })]) },
      { json: F.runs([F.run({ id: 11, attempt: 2, status: 'in_progress', conclusion: null }), F.run({ id: 12 })]) })
    w.gh(A.jobs(REPO, 11, 1), { json: F.jobs([F.job({ id: 101, runId: 11 })]) })
    w.gh(A.log(REPO, 11, 1, 101), { text: F.logText('test', [['Run tests', 'FAIL']]) })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci', 'logs'] })
    const run = env.ci.workflows.runs[0]
    expect(run).toMatchObject({ id: 11, run_attempt: 2, class: 'pending', changed_during_collection: true })
    expect(run.failed_jobs).toBeUndefined()
    expect(env.logs.jobs).toEqual([])
    expect(env.omissions).toContainEqual({ section: 'logs', what: 'jobs and logs of run 11 attempt 1', count: 1, reason: 'run_changed_during_collection' })
    expect(env.ci.observed_outcome.state).toBe('pending')
  })
})

describe('logs', () => {
  test('a reliable step attribution returns the failed step tail without the cleanup noise', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    const r = [F.run({ id: 11, conclusion: 'failure' })]
    w.gh(A.runs(REPO, HEAD), { json: F.runs(r) }, { json: F.runs(r) })
    w.gh(A.jobs(REPO, 11, 1), { json: F.jobs([F.job({ id: 101, runId: 11 })]) })
    w.gh(A.log(REPO, 11, 1, 101), {
      text: F.logText('test', [
        ['Run tests', 'go test ./...'],
        ['Run tests', '--- FAIL: TestFrob'],
        ['Run tests', '##[error]Process completed with exit code 1.'],
        ['Post Run actions/checkout', 'Removing credentials config'],
      ]),
    })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['logs'] })
    expect(env.logs.jobs[0]).toMatchObject({ attribution: 'step', steps: [{ number: 2, name: 'Run tests', lines: ['go test ./...', '--- FAIL: TestFrob', '##[error]Process completed with exit code 1.'] }] })
    expect(env.logs.jobs[0].job_tail).toBeUndefined()
    expect(env.ci.status).toBe('ok')
  })

  test('expired logs: step_logs_unavailable, no tail', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    const r = [F.run({ id: 11, conclusion: 'failure' })]
    w.gh(A.runs(REPO, HEAD), { json: F.runs(r) }, { json: F.runs(r) })
    w.gh(A.jobs(REPO, 11, 1), { json: F.jobs([F.job({ id: 101, runId: 11 })]) })
    w.gh(A.log(REPO, 11, 1, 101), { exit: 1, stderr: 'failed to get run log: log not found' })
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['logs'] })
    expect(env.logs.jobs[0]).toMatchObject({ job_id: 101, attribution: 'step_logs_unavailable', reason: 'logs_unavailable' })
    expect(env.logs.jobs[0].job_tail).toBeUndefined()
  })
})

describe('bounds', () => {
  test('ceilings: jobs for five failed runs and logs for five failed jobs, the rest listed as omitted', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    const list = Array.from({ length: 8 }, (_, i) => F.run({ id: 20 + i, conclusion: 'failure' }))
    w.gh(A.runs(REPO, HEAD), { json: F.runs(list) }, { json: F.runs(list) })
    for (let i = 0; i < 8; i++) {
      const id = 20 + i
      w.gh(A.jobs(REPO, id, 1), { json: F.jobs([F.job({ id: 200 + 2 * i, runId: id }), F.job({ id: 201 + 2 * i, runId: id })]) })
      w.gh(A.log(REPO, id, 1, 200 + 2 * i), { text: F.logText('test', [['Run tests', `fail ${i}`]]) })
      w.gh(A.log(REPO, id, 1, 201 + 2 * i), { text: F.logText('test', [['Run tests', `fail ${i}b`]]) })
    }
    const env = await call($, { repo: REPO, sha: HEAD, sections: ['ci', 'logs'] })
    expect(w.seen.argv.filter(a => a[0] === 'gh' && a[6]?.endsWith('/jobs')).length).toBe(5)
    expect(env.logs.jobs.length).toBe(5)
    expect(env.omissions).toContainEqual({ section: 'ci.workflows', what: 'jobs of failed runs', count: 3, reason: 'ceiling_failed_runs_inspected' })
    expect(env.omissions).toContainEqual({ section: 'logs', what: 'failed job logs', count: 5, reason: 'ceiling_logs_fetched' })
    expect(env.invocations).toBeLessThanOrEqual(30)
  })

  test('the result fits maxOutputKiB as valid JSON, with omissions', { options: { maxOutputKiB: 16 } }, async ($, on) => {
    const w = world(on)
    await start($)
    const big = (n: number) => Array.from({ length: 400 }, (_, i) => `+line ${n}.${i} ${'z'.repeat(60)}`).join('\n')
    w.gh(A.pull(REPO, 7), { json: F.pull({ body: 'B'.repeat(20000), changed_files: 6 }) })
    w.gh(A.compare(REPO, BASE, HEAD), { json: F.compare({ files: Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.go`, status: 'modified', additions: 400, deletions: 0, changes: 400, patch: big(i) })) }) })
    const list = Array.from({ length: 5 }, (_, i) => F.run({ id: 20 + i, conclusion: 'failure' }))
    w.gh(A.runs(REPO, HEAD), { json: F.runs(list) }, { json: F.runs(list) })
    w.gh(A.checks(REPO, HEAD), { json: F.checks([]) })
    w.gh(A.status(REPO, HEAD), { json: F.status([]) })
    for (let i = 0; i < 5; i++) {
      w.gh(A.jobs(REPO, 20 + i, 1), { json: F.jobs([F.job({ id: 200 + i, runId: 20 + i })]) })
      w.gh(A.log(REPO, 20 + i, 1, 200 + i), { text: F.logText('test', Array.from({ length: 60 }, (_, k) => ['Run tests', `${'L'.repeat(300)} ${k}`] as [string, string])) })
    }
    const r = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', repo: REPO, pr: 7 })
    const text = r.result as string
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16 * 1024)
    const env = JSON.parse(text)
    expect(env.identity.sha).toBe(HEAD)
    expect(env.ci.observed_outcome.state).toBe('failing')
    expect(env.omissions.length).toBeGreaterThan(0)
    expect(env.collection).toBe('partial')
    expect(env.metadata.body_truncated).toBe(true)
  })

  test('terminal controls are stripped from PR text, patches and logs', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.pull(REPO, 7), { json: F.pull({ title: '\x1b[2Jtitle\x07', body: 'body \x1b]0;pwned\x07ok' }) })
    w.gh(A.compare(REPO, BASE, HEAD), { json: F.compare({ files: [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+\x1b[31mred\x1b[0m' }] }) })
    const env = await call($, { repo: REPO, pr: 7, sections: ['metadata', 'diff'] })
    expect(env.metadata.title).toBe('title')
    expect(env.metadata.body).toBe('body ok')
    expect(env.diff.files[0].patch).toBe('+red')
  })

  test('each process gets a bounded timeout and a non-interactive environment', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    await call($, { repo: REPO, sha: HEAD, sections: ['ci'] })
    for (const init of w.seen.inits) {
      expect((init.timeoutMs as number) <= 20000).toBe(true)
      expect(init.env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' })
    }
  })

  test('gh missing: an error naming it, not empty evidence', async ($, on) => {
    const w = world(on)
    await start($)
    w.gh(A.commit(REPO, HEAD), { deny: 'spawn gh ENOENT' })
    const env = await call($, { repo: REPO, sha: HEAD })
    expect(env.collection).toBe('error')
    expect(env.errors[0]).toMatchObject({ step: 'resolve', kind: 'cannot_run' })
  })
})

describe('control', () => {
  test('/pr-evidence off refuses calls before any process starts', async ($, on) => {
    const w = world(on)
    await start($)
    const off = await $.command.run({ command: 'pr-evidence', args: 'off', ...COMMAND })
    expect(off.text).toContain('off (set for this session)')
    const r = await call($, { repo: REPO, sha: HEAD })
    expect(r.deny).toContain('off')
    expect(w.seen.argv).toEqual([])
    await $.command.run({ command: 'pr-evidence', args: 'on', ...COMMAND })
    bareCommit(w.gh)
    expect((await call($, { repo: REPO, sha: HEAD })).collection).toBe('complete')
  })

  test('the enabled option off refuses until /pr-evidence on', { options: { enabled: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect((await call($, { repo: REPO, sha: HEAD })).deny).toContain('off')
    expect(w.seen.argv).toEqual([])
  })

  test('turning it off during collection returns no evidence and starts nothing more', async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    let reached!: () => void
    let release!: () => void
    const atCommand = new Promise<void>(res => (reached = res))
    const released = new Promise<void>(res => (release = res))
    w.gh(A.commitPulls(REPO, HEAD), { hold: { reached, release: released }, then: { json: [] } })
    const pending = call($, { repo: REPO, sha: HEAD })
    await atCommand
    await $.command.run({ command: 'pr-evidence', args: 'off', ...COMMAND })
    release()
    const r = await pending
    expect(r.deny).toContain('turned off during collection')
    expect(w.seen.argv.length).toBe(2)
  })

  test('subagents are refused by default', async ($, on) => {
    const w = world(on)
    await start($)
    const r = await call($, { repo: REPO, sha: HEAD, agentId: 'a1' })
    expect(r.deny).toContain('subagent')
    expect(w.seen.argv).toEqual([])
  })

  test('allowSubagents lets them call it', { options: { allowSubagents: true } }, async ($, on) => {
    const w = world(on)
    await start($)
    bareCommit(w.gh)
    expect((await call($, { repo: REPO, sha: HEAD, agentId: 'a1' })).collection).toBe('complete')
  })

  test('bad input is refused with the reason and runs nothing', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await call($, { pr: 7 })).deny).toContain('needs repo')
    expect((await call($, { repo: REPO, branch: 'main' })).deny).toContain('unknown field: branch')
    expect(w.seen.argv).toEqual([])
  })

  test('an unknown command argument answers with usage', async ($, on) => {
    world(on)
    await start($)
    const res = await $.command.run({ command: 'pr-evidence', args: 'bogus', ...COMMAND })
    expect(res.text).toContain('Usage: /pr-evidence')
  })
})

describe('read-only', () => {
  test('every argv the suite saw is on the read-only allowlist and names no mutation', async () => {
    expect(everyArgv.length).toBeGreaterThan(50)
    const bad = everyArgv.filter(a => !isReadOnlyArgv(a))
    expect(bad).toEqual([])
    const words = /\b(POST|PATCH|PUT|DELETE|rerun|cancel|dispatches|checkout|merge|login|logout)\b/
    expect(everyArgv.filter(a => a.some(x => words.test(x)) || (a[1] === 'api' && !a.includes('GET')))).toEqual([])
    expect(everyArgv.filter(a => a[0] === 'gh' && a[1] === 'workflow')).toEqual([])
  })
})
