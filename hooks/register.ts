import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { collect } from './collect'
import type { Deps, RunOutcome } from './collect'
import { fitEnvelope, withCollection } from './envelope'
import { GH_ENV, isReadOnlyArgv } from './gh'
import { CEILINGS, INITIAL, USAGE, configFrom, isActive, parseArgs, statusText, validateInput } from './policy'
import type { Config } from '../types'

const NAME = 'pr-evidence'
const TOOL = 'mcp__pr-evidence__pr_evidence'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as INITIAL instead of breaking.
const sessionAtom = atom({ plugin: 'pr-evidence', key: 'session' } as const, INITIAL, { shape: 'session-2' })

// Module variables reset on a hot reload; register and session.start run again then.
let config: Config = configFrom({})

const DESCRIPTION =
  'Read-only snapshot of a GitHub pull request at one exact commit: PR metadata, a frozen diff (compare base...head), ' +
  'CI for that SHA (Actions runs, check runs, legacy commit statuses) and the failed jobs\' log tails. ' +
  'Give repo+pr, or repo+sha (full 40-character SHA), or nothing to use the current checkout (its HEAD must equal the PR head). ' +
  'Returns one JSON object: read ci.observed_outcome.state (failing, pending, inconclusive, no_workflows, skipped_only, observed_passed), ' +
  'errors and omissions. no_workflows and inconclusive are not passes; observed_passed is not a merge decision. ' +
  'It never waits for CI and never triggers or reruns anything; call it again for a fresh snapshot.'

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'OWNER/REPO on github.com (the base repository).' },
    pr: { type: 'integer', minimum: 1, description: 'Pull request number. Needs repo.' },
    sha: { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'Full commit SHA. With pr, it must equal the PR head. Needs repo.' },
    sections: {
      type: 'array',
      items: { type: 'string', enum: ['metadata', 'diff', 'ci', 'logs'] },
      minItems: 1,
      description: 'What to collect; default all. logs implies CI discovery.',
    },
  },
  additionalProperties: false,
}

class TurnedOff extends Error {}

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

/**
 * Whether the tool is on now. A versioned update that writes the same value back:
 * a plain read returns this dispatch's snapshot and misses a /pr-evidence off
 * that landed while a command ran.
 */
async function active($: EngineInterface): Promise<boolean> {
  return isActive(config, await update($, sessionAtom, s => s))
}

/** The runner collect.ts uses: allowlist, ceilings, deadline and off switch, then `$.process.run`. */
function runner($: EngineInterface, cwd: string, deadline: number, signal: AbortSignal): Deps & { count: () => number } {
  let count = 0
  const run = async (a: string[], opts?: { workspace?: boolean }): Promise<RunOutcome> => {
    if (!isReadOnlyArgv(a)) return { kind: 'refused', reason: 'not_allowed', message: 'refused a command that is not on the read-only allowlist' }
    if (signal.aborted) return { kind: 'refused', reason: 'aborted', message: 'the call was cancelled' }
    if (count >= CEILINGS.invocations) return { kind: 'refused', reason: 'invocation_budget', message: `the ${CEILINGS.invocations}-command ceiling was reached` }
    const remaining = deadline - (await $.clock.now())
    if (remaining < CEILINGS.minCallMs) return { kind: 'refused', reason: 'deadline', message: `the ${config.timeoutSeconds} s deadline was reached` }
    if (!(await active($))) throw new TurnedOff()
    count++
    try {
      const r = await $.process.run(a, { ...(opts?.workspace ? { cwd } : {}), env: GH_ENV, timeoutMs: Math.min(CEILINGS.perCallMs, remaining) })
      return { kind: 'done', r }
    } catch (err) {
      return { kind: 'rejected', message: err instanceof Error ? err.message : String(err) }
    }
  }
  return { run, now: () => $.clock.now(), invocations: () => count, count: () => count }
}

async function serve($: EngineInterface, e: Record<string, unknown>, signal: AbortSignal) {
  if (e.agentId !== undefined && !config.allowSubagents) {
    return { deny: 'pr-evidence refuses subagent calls (the allowSubagents option is off); call it from the main conversation.' }
  }
  if (!(await active($))) return { deny: 'pr-evidence is off for this session (/pr-evidence on turns it back on). Nothing ran.' }
  const v = validateInput(e)
  if (!v.ok) return { deny: `pr-evidence refused the input, nothing ran: ${v.error}` }

  const cwd = await $.session.cwd()
  const deadline = (await $.clock.now()) + config.timeoutSeconds * 1000
  const deps = runner($, cwd, deadline, signal)
  let env
  try {
    env = await collect(v.request, deps)
  } catch (err) {
    if (err instanceof TurnedOff) return { deny: 'pr-evidence was turned off during collection; no evidence returned.' }
    throw err
  }
  // Checked again right before returning: an off switch flipped during the last command wins.
  if (!(await active($))) return { deny: 'pr-evidence was turned off during collection; no evidence returned.' }

  const fitted = withCollection(fitEnvelope(env, config.maxOutputKiB * 1024))
  const outcome = (fitted.ci.observed_outcome as { state?: string } | undefined)?.state ?? 'none'
  log($, `${fitted.identity.repo ?? '?'}@${(fitted.identity.sha ?? '?').slice(0, 12)}: ${fitted.collection}, ci ${outcome}, ${deps.count()} commands, ${fitted.errors.length} errors`)
  return { result: JSON.stringify(fitted) }
}

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Show or set whether the pr_evidence tool answers in this session',
      argumentHint: '[on|off|status]',
    })
    // Registered whatever the mode, so the tool list never changes mid-session.
    await $.tool.register({ name: 'pr_evidence', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: true })
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
    return { text: statusText(config, await read($, sessionAtom)) }
  })

  // The tool is this plugin's own: nothing beneath answers it, so a failure here
  // is a refusal, never a fall-through and never a partial result.
  on('tool.call', { tool: TOOL }, ($, e, next) => serve($, e as unknown as Record<string, unknown>, next.signal))
    .catch(() => ({ deny: 'pr-evidence failed inside the plugin; no evidence returned.' }))
}
