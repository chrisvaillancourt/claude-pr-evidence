// Options, the /pr-evidence command, and the tool's input. Pure: no `$`, no I/O.
import { SHA_RE, isRepo } from './gh'
import type { Config, Mode, Session } from '../types'

export const INITIAL: Session = { mode: null }

/** Fixed ceilings (README "Limits"). Not options. */
export const CEILINGS = {
  invocations: 30,
  perCallMs: 20_000,
  minCallMs: 1_000,
  runs: 100,
  checks: 100,
  statuses: 100,
  jobsPerRun: 100,
  failedRunsInspected: 5,
  logsFetched: 5,
  searchConfirmations: 5,
  logsBytes: 16 * 1024,
  diffBytes: 24 * 1024,
  patchBytes: 8 * 1024,
  bodyBytes: 4 * 1024,
}

export const SECTIONS = ['metadata', 'diff', 'ci', 'logs'] as const
export type SectionKey = (typeof SECTIONS)[number]

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

export function configFrom(options: Record<string, unknown>): Config {
  return {
    enabled: options.enabled !== false,
    allowSubagents: options.allowSubagents === true,
    timeoutSeconds: clamp(options.timeoutSeconds, 10, 600, 120),
    maxOutputKiB: clamp(options.maxOutputKiB, 16, 64, 64),
  }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

export type Command = { kind: 'set'; mode: Mode } | { kind: 'status' } | { kind: 'help'; error?: string }

export function parseArgs(args: string): Command {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'on' || word === 'off') return { kind: 'set', mode: word }
  if (word === 'help') return { kind: 'help' }
  return { kind: 'help', error: `Unknown argument: ${args.trim()}` }
}

export const USAGE = 'Usage: /pr-evidence [on|off|status]'

export function statusText(config: Config, session: Session): string {
  const state = isActive(config, session) ? 'on' : 'off'
  const source = session.mode === null ? 'from the enabled option' : 'set for this session'
  return `${state} (${source}); subagents are ${config.allowSubagents ? 'allowed' : 'refused'}.`
}

export type Request =
  | { mode: 'repo+pr'; repo: string; pr: number; sha?: string; sections: SectionKey[] }
  | { mode: 'repo+sha'; repo: string; sha: string; sections: SectionKey[] }
  | { mode: 'workspace'; sections: SectionKey[] }

/** Keys the engine puts on a `tool.call` event beside the tool's own arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
const FIELDS = new Set(['repo', 'pr', 'sha', 'sections'])

export function validateInput(e: Record<string, unknown>): { ok: true; request: Request } | { ok: false; error: string } {
  for (const k of Object.keys(e)) {
    if (!RESERVED.has(k) && !FIELDS.has(k)) return { ok: false, error: `unknown field: ${k}. Fields: repo, pr, sha, sections.` }
  }
  const { repo, pr, sha } = e
  let sections: SectionKey[] = [...SECTIONS]
  if (e.sections !== undefined) {
    const s = e.sections
    if (!Array.isArray(s) || s.length === 0 || !s.every(x => typeof x === 'string' && (SECTIONS as readonly string[]).includes(x))) {
      return { ok: false, error: 'sections must be a non-empty array of metadata, diff, ci, logs.' }
    }
    sections = SECTIONS.filter(x => (s as string[]).includes(x))
  }
  if (repo !== undefined && (typeof repo !== 'string' || !isRepo(repo))) return { ok: false, error: 'repo must be OWNER/REPO on github.com (no URL, no host).' }
  if (pr !== undefined && (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1)) return { ok: false, error: 'pr must be a positive integer.' }
  if (sha !== undefined && (typeof sha !== 'string' || !SHA_RE.test(sha))) return { ok: false, error: 'sha must be a full 40-character lowercase hex commit SHA.' }
  if (repo === undefined) {
    if (pr !== undefined || sha !== undefined) return { ok: false, error: 'pr and sha each needs repo; leave all three out to use the current checkout.' }
    return { ok: true, request: { mode: 'workspace', sections } }
  }
  if (typeof pr === 'number') return { ok: true, request: { mode: 'repo+pr', repo: repo as string, pr, ...(typeof sha === 'string' ? { sha } : {}), sections } }
  if (typeof sha === 'string') return { ok: true, request: { mode: 'repo+sha', repo: repo as string, sha, sections } }
  return { ok: false, error: 'repo needs pr or sha (there is no branch input).' }
}
