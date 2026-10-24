// Every command the mod can run, the read-only allowlist, and the reading of a
// finished call. Pure: no `$`, no I/O.
import { cutText, stripControls } from './text'

export type Fail = { ok: false; kind: string; message: string }
export type Done = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

export const HOST = 'github.com'
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
export const SHA_RE = /^[0-9a-f]{40}$/

/** Set over the host environment for every call: no prompts, pagers, colours or update checks. */
export const GH_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_REPO: '',
  GH_HOST: HOST,
  GIT_TERMINAL_PROMPT: '0',
}

export function isRepo(r: string): boolean {
  if (!REPO_RE.test(r)) return false
  const name = r.split('/')[1]!
  return name !== '.' && name !== '..'
}

function repo(r: string): string {
  if (!isRepo(r)) throw new Error(`not an OWNER/REPO: ${r}`)
  return r
}
function sha(s: string): string {
  if (!SHA_RE.test(s)) throw new Error(`not a full SHA: ${s}`)
  return s
}
function id(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not an id: ${n}`)
  return String(n)
}

const GET = ['gh', 'api', '--hostname', HOST, '--method', 'GET']
const api = (path: string, fields: Record<string, string> = {}, jq?: string): string[] => {
  const out = [...GET, path]
  for (const [k, v] of Object.entries(fields)) out.push('-f', `${k}=${v}`)
  if (jq !== undefined) out.push('--jq', jq)
  return out
}

/** The only constructors of process argv in the mod. Each validates what it interpolates. */
export const argv = {
  pull: (r: string, n: number) => api(`repos/${repo(r)}/pulls/${id(n)}`),
  commit: (r: string, s: string) => api(`repos/${repo(r)}/commits/${sha(s)}`, {}, '.sha'),
  commitPulls: (r: string, s: string) => api(`repos/${repo(r)}/commits/${sha(s)}/pulls`, { per_page: '100' }),
  compare: (r: string, b: string, h: string) => api(`repos/${repo(r)}/compare/${sha(b)}...${sha(h)}`, { per_page: '1' }),
  runs: (r: string, s: string) => api(`repos/${repo(r)}/actions/runs`, { head_sha: sha(s), per_page: '100' }),
  jobs: (r: string, run: number, attempt: number) => api(`repos/${repo(r)}/actions/runs/${id(run)}/attempts/${id(attempt)}/jobs`, { per_page: '100' }),
  checks: (r: string, s: string) => api(`repos/${repo(r)}/commits/${sha(s)}/check-runs`, { filter: 'latest', per_page: '100' }),
  status: (r: string, s: string) => api(`repos/${repo(r)}/commits/${sha(s)}/status`, { per_page: '100' }),
  searchPrs: (r: string, s: string) => api('search/issues', { q: `repo:${repo(r)} is:pr ${sha(s)}`, per_page: '20' }),
  log: (r: string, run: number, attempt: number, job: number) =>
    ['gh', 'run', 'view', id(run), '--repo', `${HOST}/${repo(r)}`, '--attempt', id(attempt), '--job', id(job), '--log-failed'],
  workspacePr: () => ['gh', 'pr', 'view', '--json', 'number,url,headRefOid'],
  head: () => ['git', 'rev-parse', 'HEAD'],
}

const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}'
const NAME = '[A-Za-z0-9._-]{1,100}'
const HEX = '[0-9a-f]{40}'
const API_PATH = new RegExp(
  `^repos/${OWNER}/${NAME}/(?:pulls/\\d+|commits/${HEX}(?:/pulls|/check-runs|/status)?|compare/${HEX}\\.\\.\\.${HEX}|actions/runs|actions/runs/\\d+/attempts/\\d+/jobs)$`,
)
// The one search the mod runs: PRs in one repository that contain one full SHA.
const SEARCH_Q = new RegExp(`^q=repo:${OWNER}/${NAME} is:pr ${HEX}$`)
const FIELD = /^(?:head_sha=[0-9a-f]{40}|per_page=\d{1,3}|page=\d{1,3}|filter=latest)$/
const LOG_REPO = new RegExp(`^${HOST.replace('.', '\\.')}/${OWNER}/${NAME}$`)
const DIGITS = /^\d+$/

/**
 * Whether `a` is one of the read-only shapes the mod may run. Exact structure,
 * not a scan for bad words: anything not built by `argv` is refused.
 */
export function isReadOnlyArgv(a: readonly string[]): boolean {
  const eq = (i: number, v: string) => a[i] === v
  if (a[0] === 'gh' && a[1] === 'api') {
    if (!GET.every((v, i) => eq(i, v))) return false
    if (a[6] === 'search/issues') return a.length === 11 && eq(7, '-f') && SEARCH_Q.test(a[8] ?? '') && eq(9, '-f') && eq(10, 'per_page=20')
    if (!API_PATH.test(a[6] ?? '')) return false
    let i = 7
    while (i < a.length && a[i] === '-f') {
      if (!FIELD.test(a[i + 1] ?? '')) return false
      i += 2
    }
    if (i < a.length && a[i] === '--jq' && a[i + 1] === '.sha') i += 2
    return i === a.length
  }
  if (a[0] === 'gh' && a[1] === 'run' && a[2] === 'view') {
    return a.length === 11 && DIGITS.test(a[3] ?? '') && eq(4, '--repo') && LOG_REPO.test(a[5] ?? '') &&
      eq(6, '--attempt') && DIGITS.test(a[7] ?? '') && eq(8, '--job') && DIGITS.test(a[9] ?? '') && eq(10, '--log-failed')
  }
  if (a[0] === 'gh' && a[1] === 'pr') return a.length === 5 && eq(2, 'view') && eq(3, '--json') && eq(4, 'number,url,headRefOid')
  if (a[0] === 'git') return a.length === 3 && eq(1, 'rev-parse') && eq(2, 'HEAD')
  return false
}

function firstLine(s: string): string {
  const line = stripControls(s).split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return cutText(line, 300).text
}

/** A finished call: its stdout, or why it failed. A truncated stdout is never data. */
export function classifyResult(r: Done): { ok: true; stdout: string } | Fail {
  if (r.isStdoutTruncated) return { ok: false, kind: 'truncated', message: 'output passed the 4 MiB capture limit and was cut' }
  if (r.exitCode === 0) return { ok: true, stdout: r.stdout }
  const all = stripControls(r.stderr)
  const message = firstLine(r.stderr) || `exit code ${r.exitCode}`
  const kind =
    /rate limit/i.test(all) ? 'rate_limited'
    : /HTTP 401|gh auth login|authenticat/i.test(all) ? 'auth'
    : /No commit found/i.test(all) || /HTTP 404/.test(all) ? 'not_found'
    : /HTTP 403/.test(all) ? 'forbidden'
    : /HTTP \d{3}/.test(all) ? 'http_error'
    : /log not found|logs? (?:is|are) (?:no longer )?available|expired/i.test(all) ? 'logs_unavailable'
    : /no pull requests found/i.test(all) ? 'no_pr_for_branch'
    : /not a git repository/i.test(all) ? 'not_a_repo'
    : 'failed'
  return { ok: false, kind, message }
}

/** A call `$.process.run` rejected: it could not start, or ran past its timeout. */
export function classifyRejection(message: string): Fail {
  const m = firstLine(message) || 'the command could not run'
  return { ok: false, kind: /timed? ?out|timeout/i.test(message) ? 'timeout' : 'cannot_run', message: m }
}

export function parseJson(s: string): { ok: true; value: unknown } | Fail {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false, kind: 'malformed', message: 'gh printed output that is not valid JSON' }
  }
}
