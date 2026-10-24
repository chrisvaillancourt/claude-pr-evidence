// Reconciling the two reads of a commit's workflow runs. Pure: no `$`, no I/O.
//
// One rule, by run ID: a header in the final read supersedes the earlier one;
// a run the final read doesn't list keeps its earlier observation, marked
// `not_in_final_page` (the final read was cut short) or `no_longer_listed` (it
// was complete); runs only the final read lists are added. Nothing is dropped,
// so a known failure stays visible until a newer header for the same run says otherwise.

export type Seen = { id: number; attempt: number; status: string | null; conclusion: string | null }
export type Listing = 'listed' | 'not_in_final_page' | 'no_longer_listed' | 'not_rechecked'
export type Merged<H extends Seen> = { header: H; changed: boolean; listing: Listing }

const differs = (a: Seen, b: Seen) => a.attempt !== b.attempt || a.status !== b.status || a.conclusion !== b.conclusion

/** Merges by run ID; `final` null means there was no usable final read. Final order first, then runs only seen earlier. */
export function reconcileRuns<H extends Seen>(initial: readonly H[], final: readonly H[] | null, finalComplete: boolean): Merged<H>[] {
  if (final === null) return initial.map(header => ({ header, changed: false, listing: 'not_rechecked' as const }))
  const before = new Map(initial.map(h => [h.id, h]))
  const seen = new Set<number>()
  const out: Merged<H>[] = []
  for (const h of final) {
    if (seen.has(h.id)) continue
    seen.add(h.id)
    const old = before.get(h.id)
    out.push({ header: h, changed: old !== undefined && differs(old, h), listing: 'listed' })
  }
  for (const h of initial) {
    if (seen.has(h.id)) continue
    seen.add(h.id)
    out.push({ header: h, changed: false, listing: finalComplete ? 'no_longer_listed' : 'not_in_final_page' })
  }
  return out
}
