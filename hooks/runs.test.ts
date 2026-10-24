import { describe, expect, test } from 'claude-code/testing'

import { reconcileRuns } from './runs'
import type { Seen } from './runs'

const ok = (id: number, attempt = 1): Seen => ({ id, attempt, status: 'completed', conclusion: 'success' })
const bad = (id: number, attempt = 1): Seen => ({ id, attempt, status: 'completed', conclusion: 'failure' })
const running = (id: number, attempt = 1): Seen => ({ id, attempt, status: 'in_progress', conclusion: null })

/** [case, initial, final, finalComplete, expected [id, attempt, conclusion, changed, listing]] */
const rows: [string, Seen[], Seen[] | null, boolean, [number, number, string | null, boolean, string][]][] = [
  ['unchanged', [ok(1), bad(2)], [ok(1), bad(2)], true, [[1, 1, 'success', false, 'listed'], [2, 1, 'failure', false, 'listed']]],
  ['superseded by a new attempt', [bad(1)], [running(1, 2)], true, [[1, 2, null, true, 'listed']]],
  ['superseded by a status change', [running(1)], [bad(1)], true, [[1, 1, 'failure', true, 'listed']]],
  ['missing from an incomplete final page keeps the earlier observation', [ok(1), bad(2)], [ok(3), ok(1)], false,
    [[3, 1, 'success', false, 'listed'], [1, 1, 'success', false, 'listed'], [2, 1, 'failure', false, 'not_in_final_page']]],
  ['missing from a complete final read is reported, not dropped', [ok(1), bad(2)], [ok(1)], true,
    [[1, 1, 'success', false, 'listed'], [2, 1, 'failure', false, 'no_longer_listed']]],
  ['newly listed runs are added', [ok(1)], [bad(5), ok(1)], true, [[5, 1, 'failure', false, 'listed'], [1, 1, 'success', false, 'listed']]],
  ['no final read keeps everything, marked not rechecked', [ok(1), bad(2)], null, false,
    [[1, 1, 'success', false, 'not_rechecked'], [2, 1, 'failure', false, 'not_rechecked']]],
]

describe('reconcileRuns', () => {
  test('corpus', async () => {
    for (const [name, initial, final, complete, expected] of rows) {
      const got = reconcileRuns(initial, final, complete).map(m => [m.header.id, m.header.attempt, m.header.conclusion, m.changed, m.listing])
      expect([name, got]).toEqual([name, expected])
    }
  })
})
