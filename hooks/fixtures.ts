// Test fixtures: trimmed real `gh api` response shapes (GitHub REST, 2026) with
// obviously fake owners, SHAs and ids. Imported only by tests.

export const REPO = 'octo-org/widget'
export const FORK = 'fork-person/widget'
export const HEAD = 'a1'.repeat(20)
export const BASE = 'b2'.repeat(20)
export const OTHER = 'c3'.repeat(20)

type O = Record<string, unknown>

export function pull(o: { number?: number; head?: string; base?: string; headRepo?: string; title?: string; body?: string; changed_files?: number } = {}): O {
  const number = o.number ?? 7
  const headRepo = o.headRepo ?? REPO
  return {
    url: `https://api.github.com/repos/${REPO}/pulls/${number}`,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    number,
    state: 'open',
    locked: false,
    title: o.title ?? 'Add the widget frobnicator',
    user: { login: 'example-author', id: 1, type: 'User' },
    body: o.body ?? 'Adds a frobnicator.\n\nCloses #1.',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-02T10:00:00Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: 'd4'.repeat(20),
    draft: false,
    head: { label: `${headRepo.split('/')[0]}:feature`, ref: 'feature', sha: o.head ?? HEAD, repo: { full_name: headRepo, fork: headRepo !== REPO } },
    base: { label: 'octo-org:main', ref: 'main', sha: o.base ?? BASE, repo: { full_name: REPO, fork: false } },
    merged: false,
    mergeable: null,
    comments: 0,
    commits: 2,
    additions: 12,
    deletions: 3,
    changed_files: o.changed_files ?? 2,
  }
}

export function compare(o: { files?: O[]; base?: string; head?: string } = {}): O {
  return {
    url: `https://api.github.com/repos/${REPO}/compare/${o.base ?? BASE}...${o.head ?? HEAD}`,
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    base_commit: { sha: o.base ?? BASE },
    merge_base_commit: { sha: o.base ?? BASE },
    commits: [{ sha: o.head ?? HEAD }],
    files: o.files ?? [
      { sha: 'e5'.repeat(20), filename: 'src/frob.go', status: 'modified', additions: 10, deletions: 3, changes: 13, patch: '@@ -1,3 +1,10 @@\n-old\n+new\n' },
      { sha: 'f6'.repeat(20), filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ],
  }
}

export function run(o: { id: number; name?: string; status?: string; conclusion?: string | null; attempt?: number; head?: string; event?: string }): O {
  return {
    id: o.id,
    name: o.name ?? 'CI',
    head_branch: 'feature',
    head_sha: o.head ?? HEAD,
    run_number: 100 + o.id,
    event: o.event ?? 'pull_request',
    status: o.status ?? 'completed',
    conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
    workflow_id: 900 + o.id,
    html_url: `https://github.com/${REPO}/actions/runs/${o.id}`,
    created_at: '2026-01-02T10:01:00Z',
    updated_at: '2026-01-02T10:05:00Z',
    run_attempt: o.attempt ?? 1,
    run_started_at: '2026-01-02T10:01:00Z',
  }
}

export const runs = (list: O[], total = list.length): O => ({ total_count: total, workflow_runs: list })

export type StepFixture = { number: number; name: string; conclusion: string | null }

export function job(o: { id: number; runId: number; attempt?: number; name?: string; conclusion?: string | null; head?: string; steps?: StepFixture[] }): O {
  return {
    id: o.id,
    run_id: o.runId,
    run_attempt: o.attempt ?? 1,
    head_sha: o.head ?? HEAD,
    name: o.name ?? 'test',
    status: 'completed',
    conclusion: o.conclusion === undefined ? 'failure' : o.conclusion,
    html_url: `https://github.com/${REPO}/actions/runs/${o.runId}/job/${o.id}`,
    steps: (o.steps ?? [
      { number: 1, name: 'Set up job', conclusion: 'success' },
      { number: 2, name: 'Run tests', conclusion: 'failure' },
      { number: 3, name: 'Post Run actions/checkout', conclusion: 'success' },
      { number: 4, name: 'Complete job', conclusion: 'success' },
    ]).map(s => ({ ...s, status: 'completed', started_at: '2026-01-02T10:02:00Z', completed_at: '2026-01-02T10:03:00Z' })),
  }
}

export const jobs = (list: O[], total = list.length): O => ({ total_count: total, jobs: list })

export function check(o: { id: number; name?: string; status?: string; conclusion?: string | null; app?: string; head?: string }): O {
  return {
    id: o.id,
    name: o.name ?? 'test',
    head_sha: o.head ?? HEAD,
    status: o.status ?? 'completed',
    conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
    started_at: '2026-01-02T10:02:00Z',
    completed_at: '2026-01-02T10:03:00Z',
    html_url: `https://github.com/${REPO}/runs/${o.id}`,
    app: { slug: o.app ?? 'github-actions', name: o.app ?? 'GitHub Actions' },
  }
}

export const checks = (list: O[], total = list.length): O => ({ total_count: total, check_runs: list })

export function status(list: { context: string; state: string }[] = []): O {
  return {
    // GitHub reports `pending` for a commit with no statuses at all.
    state: list.length === 0 ? 'pending' : list.some(s => s.state === 'failure' || s.state === 'error') ? 'failure' : list.every(s => s.state === 'success') ? 'success' : 'pending',
    sha: HEAD,
    total_count: list.length,
    statuses: list.map((s, i) => ({ id: i + 1, context: s.context, state: s.state, description: `${s.context} said ${s.state}`, target_url: `https://ci.example.test/${i}` })),
  }
}

const TS = '2026-01-02T10:02:30.1234567Z '
/** `gh run view --log-failed` text for job `job`: `[step, line]` pairs. */
export const logText = (jobName: string, lines: [string, string][]): string => lines.map(([s, l]) => `${jobName}\t${s}\t${TS}${l}`).join('\n') + '\n'

/** A `search/issues` payload listing PRs by number. */
export const search = (numbers: number[], incomplete = false): O => ({
  total_count: numbers.length,
  incomplete_results: incomplete,
  items: numbers.map(number => ({ number, state: 'open', pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` } })),
})
