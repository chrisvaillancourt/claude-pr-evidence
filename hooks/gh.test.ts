import { describe, expect, test } from 'claude-code/testing'

import { argv, classifyRejection, classifyResult, isReadOnlyArgv, parseJson } from './gh'

const R = 'octo-org/widget'
const H = 'a1'.repeat(20)
const B = 'b2'.repeat(20)

describe('argv builders', () => {
  test('every REST call is an explicit GET on github.com', async () => {
    const all = [
      argv.pull(R, 7),
      argv.commit(R, H),
      argv.commitPulls(R, H),
      argv.compare(R, B, H),
      argv.runs(R, H),
      argv.jobs(R, 11, 2),
      argv.checks(R, H),
      argv.status(R, H),
    ]
    for (const a of all) {
      expect(a.slice(0, 6)).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'GET'])
      expect(isReadOnlyArgv(a)).toBe(true)
    }
    expect(argv.runs(R, H)).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', `repos/${R}/actions/runs`, '-f', `head_sha=${H}`, '-f', 'per_page=100'])
    expect(argv.jobs(R, 11, 2)).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', `repos/${R}/actions/runs/11/attempts/2/jobs`, '-f', 'per_page=100'])
    expect(argv.checks(R, H)).toContain('filter=latest')
  })
  test('the log, workspace and git commands', async () => {
    expect(argv.log(R, 11, 2, 99)).toEqual(['gh', 'run', 'view', '11', '--repo', `github.com/${R}`, '--attempt', '2', '--job', '99', '--log-failed'])
    expect(argv.workspacePr()).toEqual(['gh', 'pr', 'view', '--json', 'number,url,headRefOid'])
    expect(argv.head()).toEqual(['git', 'rev-parse', 'HEAD'])
    for (const a of [argv.log(R, 11, 2, 99), argv.workspacePr(), argv.head()]) expect(isReadOnlyArgv(a)).toBe(true)
  })
})

describe('isReadOnlyArgv refuses anything that could write', () => {
  const GET = ['gh', 'api', '--hostname', 'github.com', '--method', 'GET']
  const refused: string[][] = [
    ['gh', 'api', `repos/${R}/pulls/7`],
    ['gh', 'api', '-f', 'x=1', `repos/${R}/pulls/7`],
    ['gh', 'api', '--hostname', 'github.com', '--method', 'POST', `repos/${R}/pulls/7`],
    ['gh', 'api', '--hostname', 'github.com', '--method', 'PATCH', `repos/${R}/pulls/7`],
    ['gh', 'api', '--hostname', 'github.com', '--method', 'PUT', `repos/${R}/pulls/7`],
    ['gh', 'api', '--hostname', 'github.com', '--method', 'DELETE', `repos/${R}/pulls/7`],
    [...GET, `repos/${R}/pulls/7`, '-X', 'POST'],
    [...GET, `repos/${R}/pulls/7`, '--method', 'POST'],
    [...GET, `repos/${R}/pulls/7`, '--input', 'body.json'],
    [...GET, `repos/${R}/actions/runs/11/rerun`],
    [...GET, `repos/${R}/actions/workflows/ci.yml/dispatches`],
    [...GET, 'graphql', '-f', 'query=mutation{x}'],
    [...GET, `repos/${R}/pulls/7`, '-F', 'x=@file'],
    ['gh', 'run', 'rerun', '11', '--repo', `github.com/${R}`],
    ['gh', 'run', 'cancel', '11'],
    ['gh', 'workflow', 'run', 'ci.yml'],
    ['gh', 'pr', 'checkout', '7'],
    ['gh', 'pr', 'merge', '7'],
    ['gh', 'pr', 'view', '--json', 'number,url,headRefOid', '--web'],
    ['gh', 'run', 'view', '11', '--repo', `github.com/${R}`, '--attempt', '2', '--job', '99', '--log-failed', '--exit-status'],
    ['gh', 'auth', 'login'],
    ['git', 'checkout', 'main'],
    ['git', 'rev-parse', 'HEAD', '--', 'x'],
    ['sh', '-c', 'gh api x'],
  ]
  test('corpus', async () => {
    for (const a of refused) expect([a.join(' '), isReadOnlyArgv(a)]).toEqual([a.join(' '), false])
  })
  test('caller text cannot reach a path segment', async () => {
    expect(() => argv.pull('octo-org/widget/../../x', 7)).toThrow()
    expect(() => argv.commit(R, 'HEAD')).toThrow()
  })
})

describe('classifying a finished gh call', () => {
  const done = (exitCode: number, stdout: string, stderr: string, extra: Partial<{ isStdoutTruncated: boolean; isStderrTruncated: boolean }> = {}) =>
    classifyResult({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false, ...extra })
  // [exit, stderr, kind]
  const rows: [number, string, string][] = [
    [1, 'gh: Not Found (HTTP 404)', 'not_found'],
    [1, 'gh: No commit found for SHA: abc (HTTP 422)', 'not_found'],
    [1, 'gh: Validation Failed (HTTP 422)', 'http_error'],
    [1, 'gh: Bad credentials (HTTP 401)', 'auth'],
    [4, 'To get started with GitHub CLI, please run:  gh auth login', 'auth'],
    [1, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'rate_limited'],
    [1, 'gh: You have exceeded a secondary rate limit (HTTP 403)', 'rate_limited'],
    [1, 'gh: Resource not accessible by integration (HTTP 403)', 'forbidden'],
    [1, 'gh: Server Error (HTTP 502)', 'http_error'],
    [1, 'failed to get run log: log not found', 'logs_unavailable'],
    [1, 'no pull requests found for branch "main"', 'no_pr_for_branch'],
    [128, 'fatal: not a git repository (or any of the parent directories): .git', 'not_a_repo'],
    [2, 'something else broke', 'failed'],
  ]
  test('failure corpus', async () => {
    for (const [exit, stderr, kind] of rows) expect([stderr, done(exit, '', stderr)]).toMatchObject([stderr, { ok: false, kind }])
  })
  test('success, and truncation is an error even with exit 0', async () => {
    expect(done(0, '{"a":1}', '')).toEqual({ ok: true, stdout: '{"a":1}' })
    expect(done(0, '{"a":', '', { isStdoutTruncated: true })).toMatchObject({ ok: false, kind: 'truncated' })
  })
  test('rejections: missing executable and timeout', async () => {
    expect(classifyRejection('spawn gh ENOENT').kind).toBe('cannot_run')
    expect(classifyRejection('process timed out after 20000 ms').kind).toBe('timeout')
    expect(classifyRejection('weird').kind).toBe('cannot_run')
  })
  test('messages are stripped and short', async () => {
    const r = done(1, '', `\x1b[31mgh: Not Found (HTTP 404)\x1b[0m\n${'x'.repeat(1000)}`)
    expect(r).toMatchObject({ ok: false, message: 'gh: Not Found (HTTP 404)' })
  })
  test('parseJson', async () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJson('{"a":')).toMatchObject({ ok: false, kind: 'malformed' })
    expect(parseJson('')).toMatchObject({ ok: false, kind: 'malformed' })
  })
})
