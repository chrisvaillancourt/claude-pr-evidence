import { describe, expect, test } from 'claude-code/testing'

import { parseFailedLog } from './logs'
import type { StepInfo } from './logs'
import { stripControls, tailLines, utf8Bytes } from './text'

const TS = '2026-01-02T03:04:05.1234567Z '
/** One `gh run view --log-failed` line. */
const L = (job: string, step: string, text: string) => `${job}\t${step}\t${TS}${text}`

const STEPS: StepInfo[] = [
  { number: 1, name: 'Set up job', conclusion: 'success' },
  { number: 2, name: 'Run tests', conclusion: 'failure' },
  { number: 3, name: 'Post Run actions/checkout', conclusion: 'success' },
  { number: 4, name: 'Complete job', conclusion: 'success' },
]

describe('text', () => {
  // [input, expected]: terminal controls go, text and tabs and newlines stay.
  const rows: [string, string][] = [
    ['plain text', 'plain text'],
    ['\x1b[31mred\x1b[0m', 'red'],
    ['a\x1b]8;;https://x.test\x07link\x1b]8;;\x07b', 'alinkb'],
    ['a\x1b]0;title\x1b\\b', 'ab'],
    ['tab\tand\nnewline', 'tab\tand\nnewline'],
    ['cr\r\nlf', 'cr\nlf'],
    ['bell\x07 nul\x00 del\x7f c1\x9b', 'bell nul del c1'],
    ['bidi \u202eevil\u202c', 'bidi evil'],
    ['\ufeffbom', 'bom'],
    ['ünïcödé ✓', 'ünïcödé ✓'],
  ]
  test('stripControls corpus', async () => {
    for (const [input, out] of rows) expect([input, stripControls(input)]).toEqual([input, out])
  })
  test('utf8Bytes counts bytes', async () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('✓')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
  })
  test('tailLines keeps the last lines within count, bytes and line length', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const t = tailLines(lines, 30, 4096, 400)
    expect(t.lines.length).toBe(30)
    expect(t.lines[29]).toBe('line 49')
    expect(t.cut).toBe(true)
    const long = tailLines(['x'.repeat(1000)], 30, 4096, 400)
    expect(long.lines[0]!.length).toBeLessThanOrEqual(401)
    expect(long.cut).toBe(true)
    const bytes = tailLines(Array.from({ length: 30 }, () => 'é'.repeat(200)), 30, 4096, 400)
    expect(bytes.lines.join('\n').length).toBeGreaterThan(0)
    expect(utf8Bytes(bytes.lines.join('\n'))).toBeLessThanOrEqual(4096)
    expect(tailLines(['a', 'b'], 30, 4096, 400)).toEqual({ lines: ['a', 'b'], total: 2, cut: false })
  })
})

describe('failed-step attribution', () => {
  test('cleanup noise after the failure stays out of the failed step tail', async () => {
    const text = [
      L('test', 'Run tests', 'go test ./...'),
      L('test', 'Run tests', '--- FAIL: TestThing (0.01s)'),
      L('test', 'Run tests', '##[error]Process completed with exit code 1.'),
      L('test', 'Post Run actions/checkout', 'Removing credentials config'),
      L('test', 'Post Run actions/checkout', 'Cleaning up orphan processes'),
    ].join('\n') + '\n'
    const r = parseFailedLog({ text, truncated: false, jobName: 'test', steps: STEPS })
    expect(r.attribution).toBe('step')
    expect(r.steps).toEqual([
      { number: 2, name: 'Run tests', lines: ['go test ./...', '--- FAIL: TestThing (0.01s)', '##[error]Process completed with exit code 1.'], lines_total: 3, cut: false },
    ])
    expect(r.job_tail).toBeUndefined()
  })

  test('two failed steps each get their own tail', async () => {
    const steps: StepInfo[] = [
      { number: 1, name: 'Lint', conclusion: 'failure' },
      { number: 2, name: 'Test', conclusion: 'failure' },
    ]
    const text = [L('j', 'Lint', 'lint err'), L('j', 'Test', 'test err')].join('\n')
    const r = parseFailedLog({ text, truncated: false, jobName: 'j', steps })
    expect(r.attribution).toBe('step')
    expect(r.steps!.map(s => [s.name, s.lines])).toEqual([['Lint', ['lint err']], ['Test', ['test err']]])
  })

  // [case, input overrides, reason]: every way attribution is unreliable.
  const unreliable: [string, { text?: string; steps?: StepInfo[]; truncated?: boolean; jobName?: string }, string][] = [
    ['UNKNOWN STEP lines', { text: [L('test', 'UNKNOWN STEP', 'Run go test'), L('test', 'UNKNOWN STEP', '##[error]boom')].join('\n') }, 'unknown_step'],
    ['duplicate failed step name', { steps: [...STEPS, { number: 5, name: 'Run tests', conclusion: 'success' }], text: L('test', 'Run tests', 'x') }, 'duplicate_step_name'],
    ['failed step missing from the log', { text: L('test', 'Set up job', 'only setup') }, 'failed_step_missing_from_log'],
    ['no failed step listed', { steps: STEPS.map(s => ({ ...s, conclusion: 'success' })), text: L('test', 'Run tests', 'x') }, 'no_failed_step_in_job'],
    ['lines gh did not tag', { text: `${L('test', 'Run tests', 'x')}\nstray line without tabs` }, 'unparsed_lines'],
    ['another job name', { text: L('other', 'Run tests', 'x') }, 'job_name_mismatch'],
    ['empty log', { text: '' }, 'empty_log'],
    ['truncated capture', { text: L('test', 'Run tests', 'x'), truncated: true }, 'capture_truncated'],
  ]
  test('unreliable attribution corpus', async () => {
    for (const [name, o, reason] of unreliable) {
      const r = parseFailedLog({ text: o.text ?? '', truncated: o.truncated ?? false, jobName: o.jobName ?? 'test', steps: o.steps ?? STEPS })
      expect([name, r.attribution, r.reason, r.steps]).toEqual([name, 'step_logs_unavailable', reason, undefined])
    }
  })

  test('UNKNOWN STEP gets a labelled job tail and an error-marker excerpt, not a step tail', async () => {
    const lines = [
      L('lint', 'UNKNOWN STEP', 'Current runner version').replace(TS, '\ufeff' + TS),
      L('lint', 'UNKNOWN STEP', '##[group]Run actions/checkout@v4'),
      L('lint', 'UNKNOWN STEP', 'checking out'),
      L('lint', 'UNKNOWN STEP', '##[endgroup]'),
      L('lint', 'UNKNOWN STEP', '##[group]Run go mod tidy -diff'),
      L('lint', 'UNKNOWN STEP', '\x1b[36;1mgo mod tidy -diff\x1b[0m'),
      L('lint', 'UNKNOWN STEP', '##[endgroup]'),
      L('lint', 'UNKNOWN STEP', '-	golang.org/x/text v0.1.0'),
      L('lint', 'UNKNOWN STEP', '##[error]Process completed with exit code 1.'),
      L('lint', 'UNKNOWN STEP', 'Post job cleanup.'),
      L('lint', 'UNKNOWN STEP', 'Cleaning up orphan processes'),
    ]
    const r = parseFailedLog({ text: lines.join('\n'), truncated: false, jobName: 'lint', steps: STEPS })
    expect(r.attribution).toBe('step_logs_unavailable')
    expect(r.reason).toBe('unknown_step')
    expect(r.job_tail!.label).toContain('not attributed to a step')
    expect(r.job_tail!.lines.at(-1)).toBe('Cleaning up orphan processes')
    expect(r.job_tail!.lines[0]).toBe('Current runner version')
    expect(r.error_marker_excerpt!.label).toContain('not a step attribution')
    expect(r.error_marker_excerpt!.lines).toEqual([
      '##[group]Run go mod tidy -diff',
      'go mod tidy -diff',
      '##[endgroup]',
      '-\tgolang.org/x/text v0.1.0',
      '##[error]Process completed with exit code 1.',
    ])
    expect(r.error_marker_excerpt!.error_lines).toEqual(['##[error]Process completed with exit code 1.'])
  })

  test('no ##[error] marker: no excerpt', async () => {
    const r = parseFailedLog({ text: L('test', 'UNKNOWN STEP', 'quiet failure'), truncated: false, jobName: 'test', steps: STEPS })
    expect(r.error_marker_excerpt).toBeUndefined()
    expect(r.job_tail!.lines).toEqual(['quiet failure'])
  })

  test('a truncated capture gives no tail of any kind', async () => {
    const r = parseFailedLog({ text: L('test', 'UNKNOWN STEP', '##[error]x'), truncated: true, jobName: 'test', steps: STEPS })
    expect([r.job_tail, r.error_marker_excerpt, r.steps]).toEqual([undefined, undefined, undefined])
  })

  test('a huge line is cut and a long step is bounded', async () => {
    const text = Array.from({ length: 200 }, (_, i) => L('test', 'Run tests', `${i} ${'y'.repeat(2000)}`)).join('\n')
    const r = parseFailedLog({ text, truncated: false, jobName: 'test', steps: STEPS })
    const s = r.steps![0]!
    expect(s.lines_total).toBe(200)
    expect(s.cut).toBe(true)
    expect(s.lines.length).toBeLessThanOrEqual(30)
    expect(utf8Bytes(s.lines.join('\n'))).toBeLessThanOrEqual(4096)
    expect(s.lines.at(-1)!.startsWith('199 ')).toBe(true)
  })
})
