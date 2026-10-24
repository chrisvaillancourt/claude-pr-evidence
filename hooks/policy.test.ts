import { describe, expect, test } from 'claude-code/testing'

import { INITIAL, configFrom, isActive, parseArgs, statusText, validateInput } from './policy'

const H = 'a1'.repeat(20)

describe('command and options', () => {
  test('parseArgs reads on, off, status and rejects the rest', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' ON ')).toEqual({ kind: 'set', mode: 'on' })
    expect(parseArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({}), INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { mode: 'on' })).toBe(true)
    expect(isActive(configFrom({}), { mode: 'off' })).toBe(false)
  })

  test('options default and clamp', async () => {
    expect(configFrom({})).toEqual({ enabled: true, allowSubagents: false, timeoutSeconds: 120, maxOutputKiB: 64 })
    expect(configFrom({ timeoutSeconds: 1, maxOutputKiB: 1000, allowSubagents: true })).toMatchObject({ timeoutSeconds: 10, maxOutputKiB: 64, allowSubagents: true })
    expect(configFrom({ timeoutSeconds: 9999, maxOutputKiB: 2 })).toMatchObject({ timeoutSeconds: 600, maxOutputKiB: 16 })
    expect(configFrom({ timeoutSeconds: 'x' })).toMatchObject({ timeoutSeconds: 120 })
  })

  test('statusText says where the state comes from', async () => {
    expect(statusText(configFrom({}), INITIAL)).toBe('on (from the enabled option); subagents are refused.')
    expect(statusText(configFrom({ allowSubagents: true }), { mode: 'off' })).toBe('off (set for this session); subagents are allowed.')
  })
})

describe('tool input', () => {
  const ALL = ['metadata', 'diff', 'ci', 'logs']
  // [input, expected]: the README's "Resolution" rules.
  const accepted: [Record<string, unknown>, unknown][] = [
    [{}, { mode: 'workspace', sections: ALL }],
    [{ repo: 'octo-org/widget', pr: 7 }, { mode: 'repo+pr', repo: 'octo-org/widget', pr: 7, sections: ALL }],
    [{ repo: 'octo-org/widget', pr: 7, sha: H }, { mode: 'repo+pr', repo: 'octo-org/widget', pr: 7, sha: H, sections: ALL }],
    [{ repo: 'octo-org/widget', sha: H }, { mode: 'repo+sha', repo: 'octo-org/widget', sha: H, sections: ALL }],
    [{ repo: 'octo-org/widget', pr: 7, sections: ['logs'] }, { mode: 'repo+pr', repo: 'octo-org/widget', pr: 7, sections: ['logs'] }],
    [{ repo: 'octo-org/widget', pr: 7, sections: ['diff', 'diff'] }, { mode: 'repo+pr', repo: 'octo-org/widget', pr: 7, sections: ['diff'] }],
    // The engine's own keys ride along on the event and are not the tool's input.
    [{ tool: 'mcp__pr-evidence__pr_evidence', tool_use_id: 'tu1', agentId: 'a1', requestMeta: {} }, { mode: 'workspace', sections: ALL }],
  ]
  test('accepted', async () => {
    for (const [input, out] of accepted) expect([input, validateInput(input)]).toEqual([input, { ok: true, request: out }])
  })

  // [input, error fragment]
  const refused: [Record<string, unknown>, string][] = [
    [{ pr: 7 }, 'needs repo'],
    [{ sha: H }, 'needs repo'],
    [{ repo: 'octo-org/widget' }, 'repo needs pr or sha'],
    [{ repo: 'octo-org/widget', branch: 'main' }, 'unknown field: branch'],
    [{ repo: 'octo-org', pr: 7 }, 'repo must be OWNER/REPO'],
    [{ repo: 'https://github.com/octo-org/widget', pr: 7 }, 'repo must be OWNER/REPO'],
    [{ repo: 'octo-org/..', pr: 7 }, 'repo must be OWNER/REPO'],
    [{ repo: 'octo-org/widget', pr: 0 }, 'pr must be a positive integer'],
    [{ repo: 'octo-org/widget', pr: '7' }, 'pr must be a positive integer'],
    [{ repo: 'octo-org/widget', sha: 'abc1234' }, 'sha must be a full 40-character'],
    [{ repo: 'octo-org/widget', sha: H.toUpperCase() }, 'sha must be a full 40-character'],
    [{ repo: 'octo-org/widget', pr: 7, sections: [] }, 'sections'],
    [{ repo: 'octo-org/widget', pr: 7, sections: ['reviews'] }, 'sections'],
    [{ repo: 'octo-org/widget', pr: 7, sections: 'ci' }, 'sections'],
  ]
  test('refused', async () => {
    for (const [input, fragment] of refused) {
      const r = validateInput(input)
      expect([input, r.ok]).toEqual([input, false])
      if (!r.ok) expect([input, r.error.includes(fragment)]).toEqual([input, true])
    }
  })
})
